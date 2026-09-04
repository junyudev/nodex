use std::path::Path;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::automation::{
    AutomationIntent, PageOccurrenceMutationCode, PageOccurrenceMutationResult,
    PageOccurrenceSchedulePatch, PageOccurrenceUpdateScope, PageRecurrenceConfig,
    PageRecurrenceEndCondition, PageReminderConfig, ScheduledPageOccurrence,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::infrastructure::local_commit::CommitContext;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::library::{
    OccurrencePageCloneInput, clone_page_for_occurrence, require_page_write_access,
};

use super::occurrence::{
    local_date_key, next_schedule_after, read_exceptions, read_scheduled_page, shift_date_key,
    timestamp_to_iso, validate_recurrence_input, validate_reminders_input, validate_timezone_input,
};

const MAX_ID_LENGTH: usize = 512;
const MIN_OCCURRENCE_DURATION_MS: i64 = 60_000;

pub(super) struct OccurrenceMutationEffects {
    pub(super) operation_kind: &'static str,
    pub(super) result: PageOccurrenceMutationResult,
    pub(super) page_ids: Vec<String>,
    pub(super) document_ids: Vec<String>,
    pub(super) database_ids: Vec<String>,
    pub(super) committed_at: String,
}

struct Target {
    page: ScheduledPageOccurrence,
    library_id: String,
    document_id: String,
    database_id: String,
    data_source_id: String,
    membership_id: String,
}

#[derive(Clone)]
struct ScheduleState {
    scheduled_start_ms: Option<i64>,
    scheduled_end_ms: Option<i64>,
    is_all_day: bool,
    recurrence: Option<PageRecurrenceConfig>,
    reminders: Vec<PageReminderConfig>,
    schedule_timezone: Option<String>,
}

pub(super) struct OccurrenceMutationInput<'a> {
    pub(super) connection: &'a Connection,
    pub(super) commit_context: &'a CommitContext,
    pub(super) library_id: &'a str,
    pub(super) context: &'a BoundModuleContext,
    pub(super) store_epoch: &'a str,
    pub(super) operation_id: &'a str,
    pub(super) intent: &'a AutomationIntent,
    pub(super) assets_root: &'a Path,
    pub(super) committed_at: &'a str,
}

pub(super) fn apply(
    input: OccurrenceMutationInput<'_>,
) -> Result<OccurrenceMutationEffects, StoreError> {
    let OccurrenceMutationInput {
        connection,
        commit_context,
        library_id,
        context,
        store_epoch,
        operation_id,
        intent,
        assets_root,
        committed_at,
    } = input;
    let project_id = context
        .project_id
        .as_ref()
        .map(|value| value.0.as_str())
        .ok_or_else(|| unauthorized("Page occurrence mutation requires a bound Project"))?;
    require_active_project(connection, library_id, project_id)?;
    match intent {
        AutomationIntent::CompletePageOccurrence {
            page_id,
            occurrence_start_ms,
            created_page_id,
        } => complete(
            connection,
            commit_context,
            library_id,
            project_id,
            store_epoch,
            operation_id,
            page_id,
            *occurrence_start_ms,
            created_page_id,
            committed_at,
            assets_root,
        ),
        AutomationIntent::SkipPageOccurrence {
            page_id,
            occurrence_start_ms,
        } => skip(
            connection,
            commit_context,
            library_id,
            project_id,
            operation_id,
            page_id,
            *occurrence_start_ms,
            committed_at,
        ),
        AutomationIntent::UpdatePageOccurrence {
            page_id,
            occurrence_start_ms,
            scope,
            created_page_id,
            updates,
        } => update(
            connection,
            commit_context,
            library_id,
            project_id,
            store_epoch,
            operation_id,
            page_id,
            *occurrence_start_ms,
            *scope,
            created_page_id.as_deref(),
            updates,
            committed_at,
            assets_root,
        ),
        _ => Err(internal(
            "Occurrence aggregate received another Automation intent",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn complete(
    connection: &Connection,
    commit_context: &CommitContext,
    library_id: &str,
    requesting_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    page_id: &str,
    occurrence_start_ms: i64,
    created_page_id: &str,
    now: &str,
    assets_root: &Path,
) -> Result<OccurrenceMutationEffects, StoreError> {
    if let Err(message) = validate_common(page_id, occurrence_start_ms)
        .and_then(|()| validate_uuid_v7(created_page_id, "created_page_id"))
    {
        return Ok(rejected(
            "complete_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            &message,
            now,
        ));
    }
    let target = match resolve_target(connection, library_id, requesting_project_id, page_id, true)?
    {
        Ok(target) => target,
        Err((code, message)) => {
            return Ok(rejected(
                "complete_page_occurrence",
                operation_id,
                page_id,
                code,
                &message,
                now,
            ));
        }
    };
    if identity_exists(connection, created_page_id)? {
        return Ok(rejected(
            "complete_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            "created_page_id is already owned",
            now,
        ));
    }
    let duration_ms = (target.page.occurrence_end_ms - target.page.occurrence_start_ms)
        .max(MIN_OCCURRENCE_DURATION_MS);
    let occurrence_end_ms = occurrence_start_ms
        .checked_add(duration_ms)
        .ok_or_else(|| invalid("Occurrence completion exceeds the timestamp range"))?;
    let occurrence_start = timestamp_to_iso(occurrence_start_ms)?;
    let occurrence_end = timestamp_to_iso(occurrence_end_ms)?;
    let clone = clone_page_for_occurrence(
        connection,
        library_id,
        store_epoch,
        assets_root,
        OccurrencePageCloneInput {
            commit_context,
            actor_project_id: requesting_project_id,
            operation_id,
            source_page_id: page_id,
            new_page_id: created_page_id,
            lifecycle: "archived",
            status: "ship",
            scheduled_start: &occurrence_start,
            scheduled_end: &occurrence_end,
            is_all_day: target.page.is_all_day,
            recurrence_json: "null",
            reminders_json: "[]",
            schedule_timezone: target.page.schedule_timezone.as_deref(),
            primary_placement: crate::database::ViewOrderPlacement::End,
            now,
        },
    )?;
    refresh_scheduled_index(connection, created_page_id, now)?;

    let should_advance = occurrence_start_ms <= target.page.occurrence_start_ms;
    if target.page.recurrence.is_some() && !should_advance {
        upsert_skip_exception(
            connection,
            &target.library_id,
            page_id,
            occurrence_start_ms,
            now,
        )?;
    }
    if should_advance {
        advance_after_occurrence(connection, &target, occurrence_start_ms, now)?;
    }
    Ok(success(
        "complete_page_occurrence",
        operation_id,
        vec![page_id.to_owned(), clone.page_id],
        [vec![target.document_id], clone.affected_document_ids].concat(),
        vec![clone.database_id],
        Some(created_page_id.to_owned()),
        now,
    ))
}

#[allow(clippy::too_many_arguments)]
fn skip(
    connection: &Connection,
    _commit_context: &CommitContext,
    library_id: &str,
    requesting_project_id: &str,
    operation_id: &str,
    page_id: &str,
    occurrence_start_ms: i64,
    now: &str,
) -> Result<OccurrenceMutationEffects, StoreError> {
    if let Err(message) = validate_common(page_id, occurrence_start_ms) {
        return Ok(rejected(
            "skip_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            &message,
            now,
        ));
    }
    let target = match resolve_target(
        connection,
        library_id,
        requesting_project_id,
        page_id,
        false,
    )? {
        Ok(target) => target,
        Err((code, message)) => {
            return Ok(rejected(
                "skip_page_occurrence",
                operation_id,
                page_id,
                code,
                &message,
                now,
            ));
        }
    };
    if target.page.recurrence.is_some() {
        upsert_skip_exception(
            connection,
            &target.library_id,
            page_id,
            occurrence_start_ms,
            now,
        )?;
    }
    if occurrence_start_ms <= target.page.occurrence_start_ms {
        advance_after_occurrence(connection, &target, occurrence_start_ms, now)?;
    }
    Ok(success(
        "skip_page_occurrence",
        operation_id,
        vec![page_id.to_owned()],
        vec![target.document_id],
        vec![target.database_id],
        None,
        now,
    ))
}

#[allow(clippy::too_many_arguments)]
fn update(
    connection: &Connection,
    commit_context: &CommitContext,
    library_id: &str,
    requesting_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    page_id: &str,
    occurrence_start_ms: i64,
    scope: PageOccurrenceUpdateScope,
    created_page_id: Option<&str>,
    updates: &PageOccurrenceSchedulePatch,
    now: &str,
    assets_root: &Path,
) -> Result<OccurrenceMutationEffects, StoreError> {
    if let Err(message) = validate_update_request(
        page_id,
        occurrence_start_ms,
        scope,
        created_page_id,
        updates,
    ) {
        return Ok(rejected(
            "update_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            &message,
            now,
        ));
    }
    let target = match resolve_target(
        connection,
        library_id,
        requesting_project_id,
        page_id,
        false,
    )? {
        Ok(target) => target,
        Err((code, message)) => {
            return Ok(rejected(
                "update_page_occurrence",
                operation_id,
                page_id,
                code,
                &message,
                now,
            ));
        }
    };
    if target.page.recurrence.is_some()
        && scope != PageOccurrenceUpdateScope::All
        && let Err(message) =
            require_sibling_creation(connection, library_id, requesting_project_id, page_id)
    {
        if message.code == StoreErrorCode::Unauthorized {
            return Ok(rejected(
                "update_page_occurrence",
                operation_id,
                page_id,
                PageOccurrenceMutationCode::AuthorizationDenied,
                &message.message,
                now,
            ));
        }
        return Err(message);
    }
    let drag_shift = shifted_drag_recurrence(&target.page, occurrence_start_ms, updates)?;

    if scope == PageOccurrenceUpdateScope::All {
        let patch = patch_for_series(updates, drag_shift);
        if let Err(message) = validate_schedule_patch(&target, &patch) {
            return deterministic_update_rejection(operation_id, page_id, message, now);
        }
        apply_schedule_patch(connection, &target, &patch, now)?;
        return Ok(success(
            "update_page_occurrence",
            operation_id,
            vec![page_id.to_owned()],
            vec![target.document_id],
            vec![target.database_id],
            None,
            now,
        ));
    }

    if scope == PageOccurrenceUpdateScope::This {
        if target.page.recurrence.is_none() {
            let patch = one_time_patch(updates);
            if let Err(message) = validate_schedule_patch(&target, &patch) {
                return deterministic_update_rejection(operation_id, page_id, message, now);
            }
            apply_schedule_patch(connection, &target, &patch, now)?;
            return Ok(success(
                "update_page_occurrence",
                operation_id,
                vec![page_id.to_owned()],
                vec![target.document_id],
                vec![target.database_id],
                None,
                now,
            ));
        }
        let created_page_id = created_page_id.expect("validated clone identity");
        if identity_exists(connection, created_page_id)? {
            return Ok(rejected(
                "update_page_occurrence",
                operation_id,
                page_id,
                PageOccurrenceMutationCode::InvalidOccurrenceRequest,
                "created_page_id is already owned",
                now,
            ));
        }
        let (start_ms, end_ms) = normalize_timing(&target.page, occurrence_start_ms, updates)?;
        let start = timestamp_to_iso(start_ms)?;
        let end = timestamp_to_iso(end_ms)?;
        let reminders = updates.reminders.as_ref().unwrap_or(&target.page.reminders);
        let reminders_json = serde_json::to_string(reminders)
            .map_err(|_| internal("Occurrence reminders cannot be encoded"))?;
        let timezone = match updates.schedule_timezone.as_ref() {
            None => target.page.schedule_timezone.as_deref(),
            Some(value) => value.as_deref(),
        };
        let clone = clone_page_for_occurrence(
            connection,
            library_id,
            store_epoch,
            assets_root,
            OccurrencePageCloneInput {
                commit_context,
                actor_project_id: requesting_project_id,
                operation_id,
                source_page_id: page_id,
                new_page_id: created_page_id,
                lifecycle: "active",
                status: &target.page.status,
                scheduled_start: &start,
                scheduled_end: &end,
                is_all_day: updates.is_all_day.unwrap_or(target.page.is_all_day),
                recurrence_json: "null",
                reminders_json: &reminders_json,
                schedule_timezone: timezone,
                primary_placement: crate::database::ViewOrderPlacement::After(page_id),
                now,
            },
        )?;
        refresh_scheduled_index(connection, created_page_id, now)?;
        upsert_skip_exception(
            connection,
            &target.library_id,
            page_id,
            occurrence_start_ms,
            now,
        )?;
        return Ok(success(
            "update_page_occurrence",
            operation_id,
            vec![page_id.to_owned(), clone.page_id],
            [vec![target.document_id], clone.affected_document_ids].concat(),
            vec![clone.database_id],
            Some(created_page_id.to_owned()),
            now,
        ));
    }

    if target.page.recurrence.is_none() {
        let patch = one_time_patch(updates);
        if let Err(message) = validate_schedule_patch(&target, &patch) {
            return deterministic_update_rejection(operation_id, page_id, message, now);
        }
        apply_schedule_patch(connection, &target, &patch, now)?;
        return Ok(success(
            "update_page_occurrence",
            operation_id,
            vec![page_id.to_owned()],
            vec![target.document_id],
            vec![target.database_id],
            None,
            now,
        ));
    }
    if occurrence_start_ms <= target.page.occurrence_start_ms {
        let patch = patch_for_series(updates, drag_shift);
        if let Err(message) = validate_schedule_patch(&target, &patch) {
            return deterministic_update_rejection(operation_id, page_id, message, now);
        }
        apply_schedule_patch(connection, &target, &patch, now)?;
        return Ok(success(
            "update_page_occurrence",
            operation_id,
            vec![page_id.to_owned()],
            vec![target.document_id],
            vec![target.database_id],
            None,
            now,
        ));
    }

    let created_page_id = created_page_id.expect("validated split identity");
    if identity_exists(connection, created_page_id)? {
        return Ok(rejected(
            "update_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            "created_page_id is already owned",
            now,
        ));
    }
    let timezone_for_split = target.page.schedule_timezone.as_deref().or_else(|| {
        updates
            .schedule_timezone
            .as_ref()
            .and_then(|value| value.as_deref())
    });
    let occurrence_date = local_date_key(occurrence_start_ms, timezone_for_split)?;
    let mut ended_recurrence = target.page.recurrence.clone().expect("recurring target");
    ended_recurrence.end_condition = Some(PageRecurrenceEndCondition::UntilDate {
        until_date: shift_date_key(&occurrence_date, -1)?,
    });
    let source_patch = PageOccurrenceSchedulePatch {
        recurrence: Some(Some(ended_recurrence)),
        ..PageOccurrenceSchedulePatch::default()
    };
    if let Err(message) = validate_schedule_patch(&target, &source_patch) {
        return deterministic_update_rejection(operation_id, page_id, message, now);
    }
    let (start_ms, end_ms) = normalize_timing(&target.page, occurrence_start_ms, updates)?;
    let start = timestamp_to_iso(start_ms)?;
    let end = timestamp_to_iso(end_ms)?;
    let reminders = updates.reminders.as_ref().unwrap_or(&target.page.reminders);
    let reminders_json = serde_json::to_string(reminders)
        .map_err(|_| internal("Occurrence reminders cannot be encoded"))?;
    let next_timezone = match updates.schedule_timezone.as_ref() {
        None => target.page.schedule_timezone.as_deref(),
        Some(value) => value.as_deref(),
    };
    let split_drag_shift = shifted_drag_recurrence_in_timezone(
        &target.page,
        occurrence_start_ms,
        updates,
        next_timezone,
    )?;
    let next_recurrence = updates
        .recurrence
        .as_ref()
        .cloned()
        .unwrap_or_else(|| split_drag_shift.or_else(|| target.page.recurrence.clone()));
    let recurrence_json = serde_json::to_string(&next_recurrence)
        .map_err(|_| internal("Occurrence recurrence cannot be encoded"))?;
    let clone = clone_page_for_occurrence(
        connection,
        library_id,
        store_epoch,
        assets_root,
        OccurrencePageCloneInput {
            commit_context,
            actor_project_id: requesting_project_id,
            operation_id,
            source_page_id: page_id,
            new_page_id: created_page_id,
            lifecycle: "active",
            status: &target.page.status,
            scheduled_start: &start,
            scheduled_end: &end,
            is_all_day: updates.is_all_day.unwrap_or(target.page.is_all_day),
            recurrence_json: &recurrence_json,
            reminders_json: &reminders_json,
            schedule_timezone: next_timezone,
            primary_placement: crate::database::ViewOrderPlacement::After(page_id),
            now,
        },
    )?;
    refresh_scheduled_index(connection, created_page_id, now)?;
    apply_schedule_patch(connection, &target, &source_patch, now)?;
    Ok(success(
        "update_page_occurrence",
        operation_id,
        vec![page_id.to_owned(), clone.page_id],
        [vec![target.document_id], clone.affected_document_ids].concat(),
        vec![clone.database_id],
        Some(created_page_id.to_owned()),
        now,
    ))
}

fn resolve_target(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    page_id: &str,
    requires_sibling_creation: bool,
) -> Result<Result<Target, (PageOccurrenceMutationCode, String)>, StoreError> {
    let authority = connection
        .query_row(
            "SELECT block.library_id, page.document_id, page.parent_kind, page.parent_id, \
               source.home_database_block_id, membership.data_source_id, membership.id \
             FROM pages page JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
             LEFT JOIN data_source_page_memberships membership ON membership.page_block_id = page.block_id \
               AND membership.removed_at IS NULL \
             LEFT JOIN data_sources source ON source.id = membership.data_source_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    let Some(authority) = authority else {
        return Ok(Err((
            PageOccurrenceMutationCode::PageNotFound,
            "Page not found".to_owned(),
        )));
    };
    if let Err(error) =
        require_page_write_access(connection, library_id, requesting_project_id, page_id)
    {
        if matches!(
            error.code,
            StoreErrorCode::NotFound | StoreErrorCode::Unauthorized
        ) {
            return Ok(Err((
                PageOccurrenceMutationCode::AuthorizationDenied,
                "Page occurrence mutation denied".to_owned(),
            )));
        }
        return Err(error);
    }
    if requires_sibling_creation
        && let Err(error) =
            require_sibling_creation(connection, library_id, requesting_project_id, page_id)
    {
        if error.code == StoreErrorCode::Unauthorized {
            return Ok(Err((
                PageOccurrenceMutationCode::AuthorizationDenied,
                error.message,
            )));
        }
        return Err(error);
    }
    let Some(database_id) = authority.4 else {
        return Ok(Err((
            PageOccurrenceMutationCode::PageNotScheduled,
            "Page has no active scheduled Data Source".to_owned(),
        )));
    };
    let (Some(data_source_id), Some(membership_id)) = (authority.5, authority.6) else {
        return Ok(Err((
            PageOccurrenceMutationCode::PageNotScheduled,
            "Page has no active scheduled Data Source".to_owned(),
        )));
    };
    let page = match read_scheduled_page(connection, library_id, page_id)? {
        Some(page) => page,
        None => {
            return Ok(Err((
                PageOccurrenceMutationCode::PageNotScheduled,
                "Page is not scheduled".to_owned(),
            )));
        }
    };
    Ok(Ok(Target {
        page,
        library_id: authority.0,
        document_id: authority.1,
        database_id,
        data_source_id,
        membership_id,
    }))
}

fn require_sibling_creation(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id, \
               source.home_database_block_id \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
             LEFT JOIN data_sources source ON source.id = page.parent_id AND source.library_id = ?1 \
             WHERE page.block_id = ?2 AND page.library_id = ?1",
            params![library_id, page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| unauthorized("Scheduled Page is unavailable"))?;
    if row.0 != "data_source" || row.2.is_none() {
        return Err(unauthorized("Scheduled Page has no Data Source parent"));
    }
    let database_id = row.2.expect("validated Database");
    let primary = connection
        .query_row(
            "SELECT database_block_id FROM projects WHERE id = ?1 AND library_id = ?2 \
               AND lifecycle = 'active'",
            params![requesting_project_id, library_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if primary.as_deref() == Some(database_id.as_str()) {
        return Ok(());
    }
    let granted = connection
        .query_row(
            "SELECT 1 FROM project_resource_grants WHERE project_id = ?1 \
             AND root_kind = 'database' AND root_id = ?2 AND access = 'read_write' \
             AND lifecycle = 'active'",
            params![requesting_project_id, database_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if granted {
        return Ok(());
    }
    Err(unauthorized(
        "Page occurrence mutation requires Data Source create-child authority",
    ))
}

fn advance_after_occurrence(
    connection: &Connection,
    target: &Target,
    occurrence_start_ms: i64,
    now: &str,
) -> Result<(), StoreError> {
    let next = if target.page.recurrence.is_some() {
        let exceptions = read_exceptions(connection, &target.page.page_id)?;
        next_schedule_after(&target.page, occurrence_start_ms, &exceptions)?
    } else {
        None
    };
    let patch = PageOccurrenceSchedulePatch {
        scheduled_start_ms: Some(next.map(|value| value.0)),
        scheduled_end_ms: Some(next.map(|value| value.1)),
        ..PageOccurrenceSchedulePatch::default()
    };
    apply_schedule_patch(connection, target, &patch, now)
}

fn apply_schedule_patch(
    connection: &Connection,
    target: &Target,
    patch: &PageOccurrenceSchedulePatch,
    now: &str,
) -> Result<(), StoreError> {
    validate_schedule_patch(target, patch)?;
    let mut changed = false;
    if let Some(value) = &patch.scheduled_start_ms {
        changed |= update_database_value(
            connection,
            target,
            "scheduled_start",
            value
                .map(timestamp_to_iso)
                .transpose()?
                .map(Value::String)
                .unwrap_or(Value::Null),
            now,
        )?;
    }
    if let Some(value) = &patch.scheduled_end_ms {
        changed |= update_database_value(
            connection,
            target,
            "scheduled_end",
            value
                .map(timestamp_to_iso)
                .transpose()?
                .map(Value::String)
                .unwrap_or(Value::Null),
            now,
        )?;
    }
    if let Some(value) = patch.is_all_day {
        changed |= update_intrinsic_value(
            connection,
            target,
            "schedule.isAllDay",
            Value::Bool(value),
            now,
        )?;
    }
    if let Some(value) = &patch.recurrence {
        changed |= update_intrinsic_value(
            connection,
            target,
            "recurrence.config",
            serde_json::to_value(value)
                .map_err(|_| invalid("Recurrence config cannot be encoded"))?,
            now,
        )?;
    }
    if let Some(value) = &patch.reminders {
        changed |= update_intrinsic_value(
            connection,
            target,
            "reminders.config",
            serde_json::to_value(value)
                .map_err(|_| invalid("Reminder config cannot be encoded"))?,
            now,
        )?;
    }
    if let Some(value) = &patch.schedule_timezone {
        changed |= update_intrinsic_value(
            connection,
            target,
            "schedule.timezone",
            value
                .as_ref()
                .map_or(Value::Null, |value| Value::String(value.clone())),
            now,
        )?;
    }
    if !changed {
        return Ok(());
    }
    let metadata_revision = connection
        .query_row(
            "UPDATE blocks SET metadata_revision = metadata_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND library_id = ?3 AND type = 'page' RETURNING metadata_revision",
            params![now, target.page.page_id, target.library_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Scheduled Page disappeared during mutation"))?;
    refresh_page_read_model(connection, target, metadata_revision, now)?;
    refresh_scheduled_index(connection, &target.page.page_id, now)
}

fn validate_schedule_patch(
    target: &Target,
    patch: &PageOccurrenceSchedulePatch,
) -> Result<(), StoreError> {
    validate_schedule_state(&patched_schedule_state(schedule_state_for(target), patch))
}

fn schedule_state_for(target: &Target) -> ScheduleState {
    ScheduleState {
        scheduled_start_ms: Some(target.page.occurrence_start_ms),
        scheduled_end_ms: Some(target.page.occurrence_end_ms),
        is_all_day: target.page.is_all_day,
        recurrence: target.page.recurrence.clone(),
        reminders: target.page.reminders.clone(),
        schedule_timezone: target.page.schedule_timezone.clone(),
    }
}

fn patched_schedule_state(
    current: ScheduleState,
    patch: &PageOccurrenceSchedulePatch,
) -> ScheduleState {
    ScheduleState {
        scheduled_start_ms: patch
            .scheduled_start_ms
            .unwrap_or(current.scheduled_start_ms),
        scheduled_end_ms: patch.scheduled_end_ms.unwrap_or(current.scheduled_end_ms),
        is_all_day: patch.is_all_day.unwrap_or(current.is_all_day),
        recurrence: patch.recurrence.clone().unwrap_or(current.recurrence),
        reminders: patch.reminders.clone().unwrap_or(current.reminders),
        schedule_timezone: patch
            .schedule_timezone
            .clone()
            .unwrap_or(current.schedule_timezone),
    }
}

fn update_database_value(
    connection: &Connection,
    target: &Target,
    property_id: &str,
    value: Value,
    now: &str,
) -> Result<bool, StoreError> {
    let row = connection
        .query_row(
            "SELECT value.value_json, value.revision, value.value_type \
             FROM data_source_property_values value \
             JOIN data_source_properties property ON property.data_source_id = value.data_source_id \
               AND property.id = value.property_id AND property.lifecycle = 'active' \
             WHERE value.data_source_id = ?1 AND value.membership_id = ?2 \
               AND value.property_id = ?3",
            params![target.data_source_id, target.membership_id, property_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Scheduled Page Database property is unavailable"))?;
    let encoded = serde_json::to_string(&value)
        .map_err(|_| invalid("Schedule Database value cannot be encoded"))?;
    if row.0 == encoded {
        return Ok(false);
    }
    connection.execute(
        "UPDATE data_source_property_values SET value_json = ?1, revision = ?2, updated_at = ?3 \
         WHERE data_source_id = ?4 AND membership_id = ?5 AND property_id = ?6",
        params![
            encoded,
            row.1 + 1,
            now,
            target.data_source_id,
            target.membership_id,
            property_id,
        ],
    )?;
    Ok(true)
}

fn update_intrinsic_value(
    connection: &Connection,
    target: &Target,
    property_key: &str,
    value: Value,
    now: &str,
) -> Result<bool, StoreError> {
    let row = connection
        .query_row(
            "SELECT value_json, revision FROM block_properties \
             WHERE block_id = ?1 AND library_id = ?2 AND property_key = ?3",
            params![target.page.page_id, target.library_id, property_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| corrupt("Scheduled Page intrinsic property is unavailable"))?;
    let encoded = serde_json::to_string(&value)
        .map_err(|_| invalid("Schedule intrinsic value cannot be encoded"))?;
    if row.0 == encoded {
        return Ok(false);
    }
    connection.execute(
        "UPDATE block_properties SET value_json = ?1, revision = ?2, updated_at = ?3 \
         WHERE block_id = ?4 AND library_id = ?5 AND property_key = ?6",
        params![
            encoded,
            row.1 + 1,
            now,
            target.page.page_id,
            target.library_id,
            property_key,
        ],
    )?;
    Ok(true)
}

fn refresh_page_read_model(
    connection: &Connection,
    target: &Target,
    metadata_revision: i64,
    now: &str,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT database_values_json, intrinsic_properties_json, property_revisions_json \
             FROM page_read_model WHERE page_block_id = ?1",
            [&target.page.page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Scheduled Page read projection is unavailable"))?;
    let mut database = parse_object(&row.0, "Page Database values")?;
    let mut intrinsic = parse_object(&row.1, "Page intrinsic values")?;
    let mut revisions = parse_object(&row.2, "Page property revisions")?;
    let mut database_revisions = take_revision_map(&mut revisions, "database")?;
    let mut intrinsic_revisions = take_revision_map(&mut revisions, "intrinsic")?;

    for property_id in ["scheduled_start", "scheduled_end"] {
        let (value_json, revision) = connection.query_row(
            "SELECT value_json, revision FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
            params![target.data_source_id, target.membership_id, property_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        database.insert(property_id.to_owned(), parse_value(&value_json)?);
        database_revisions.insert(property_id.to_owned(), Value::from(revision));
    }
    for property_key in [
        "schedule.isAllDay",
        "recurrence.config",
        "reminders.config",
        "schedule.timezone",
    ] {
        let (value_json, revision) = connection.query_row(
            "SELECT value_json, revision FROM block_properties \
             WHERE block_id = ?1 AND library_id = ?2 AND property_key = ?3",
            params![target.page.page_id, target.library_id, property_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        intrinsic.insert(property_key.to_owned(), parse_value(&value_json)?);
        intrinsic_revisions.insert(property_key.to_owned(), Value::from(revision));
    }
    revisions.insert("database".to_owned(), Value::Object(database_revisions));
    revisions.insert("intrinsic".to_owned(), Value::Object(intrinsic_revisions));
    connection.execute(
        "UPDATE page_read_model SET metadata_revision = ?1, database_values_json = ?2, \
           intrinsic_properties_json = ?3, property_revisions_json = ?4, \
           projection_version = projection_version + 1, updated_at = ?5 \
         WHERE page_block_id = ?6",
        params![
            metadata_revision,
            serde_json::to_string(&database).map_err(|_| internal("Page Database values"))?,
            serde_json::to_string(&intrinsic).map_err(|_| internal("Page intrinsic values"))?,
            serde_json::to_string(&revisions).map_err(|_| internal("Page revisions"))?,
            now,
            target.page.page_id,
        ],
    )?;
    Ok(())
}

fn take_revision_map(
    revisions: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<serde_json::Map<String, Value>, StoreError> {
    match revisions.remove(key) {
        None => Ok(serde_json::Map::new()),
        Some(Value::Object(values)) => Ok(values),
        Some(_) => Err(corrupt(&format!("Page {key} revisions are invalid"))),
    }
}

pub(crate) fn refresh_scheduled_index(
    connection: &Connection,
    page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT block.library_id, block.lifecycle, block.metadata_revision, membership.id, \
               start.value_json, finish.value_json, all_day.value_json, recurrence.value_json, \
               reminders.value_json, timezone.value_json \
             FROM blocks block \
             LEFT JOIN data_source_page_memberships membership ON membership.page_block_id = block.id \
               AND membership.removed_at IS NULL \
             LEFT JOIN data_source_property_values start ON start.membership_id = membership.id \
               AND start.data_source_id = membership.data_source_id AND start.property_id = 'scheduled_start' \
             LEFT JOIN data_source_property_values finish ON finish.membership_id = membership.id \
               AND finish.data_source_id = membership.data_source_id AND finish.property_id = 'scheduled_end' \
             LEFT JOIN block_properties all_day ON all_day.block_id = block.id \
               AND all_day.library_id = block.library_id AND all_day.property_key = 'schedule.isAllDay' \
             LEFT JOIN block_properties recurrence ON recurrence.block_id = block.id \
               AND recurrence.library_id = block.library_id AND recurrence.property_key = 'recurrence.config' \
             LEFT JOIN block_properties reminders ON reminders.block_id = block.id \
               AND reminders.library_id = block.library_id AND reminders.property_key = 'reminders.config' \
             LEFT JOIN block_properties timezone ON timezone.block_id = block.id \
               AND timezone.library_id = block.library_id AND timezone.property_key = 'schedule.timezone' \
             WHERE block.id = ?1 AND block.type = 'page'",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Scheduled Page projection source is unavailable"))?;
    let scheduled_start = row
        .4
        .as_deref()
        .map(parse_nullable_string)
        .transpose()?
        .flatten();
    let scheduled_end = row
        .5
        .as_deref()
        .map(parse_nullable_string)
        .transpose()?
        .flatten();
    if (scheduled_start.is_some()) != (scheduled_end.is_some()) {
        return Err(invalid(
            "scheduled_start and scheduled_end must both be set or cleared",
        ));
    }
    let is_all_day = row
        .6
        .as_deref()
        .map(parse_value)
        .transpose()?
        .and_then(|value| value.as_bool())
        .ok_or_else(|| corrupt("Scheduled Page all-day property is invalid"))?;
    let recurrence_json = row
        .7
        .ok_or_else(|| corrupt("Scheduled Page recurrence property is unavailable"))?;
    let reminders_json = row
        .8
        .ok_or_else(|| corrupt("Scheduled Page reminder property is unavailable"))?;
    let timezone = row
        .9
        .as_deref()
        .map(parse_nullable_string)
        .transpose()?
        .flatten();
    connection.execute(
        "INSERT INTO scheduled_page_index( \
           page_block_id, library_id, lifecycle, scheduled_start, scheduled_end, is_all_day, \
           recurrence_json, reminders_json, schedule_timezone, source_metadata_revision, updated_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(page_block_id) DO UPDATE SET library_id = excluded.library_id, \
           lifecycle = excluded.lifecycle, scheduled_start = excluded.scheduled_start, \
           scheduled_end = excluded.scheduled_end, is_all_day = excluded.is_all_day, \
           recurrence_json = excluded.recurrence_json, reminders_json = excluded.reminders_json, \
           schedule_timezone = excluded.schedule_timezone, \
           source_metadata_revision = excluded.source_metadata_revision, updated_at = excluded.updated_at",
        params![
            page_id,
            row.0,
            row.1,
            scheduled_start,
            scheduled_end,
            i64::from(is_all_day),
            recurrence_json,
            reminders_json,
            timezone,
            row.2,
            now,
        ],
    )?;
    Ok(())
}

fn validate_schedule_state(state: &ScheduleState) -> Result<(), StoreError> {
    if state.scheduled_start_ms.is_some() != state.scheduled_end_ms.is_some() {
        return Err(invalid(
            "scheduled_start and scheduled_end must both be set or cleared",
        ));
    }
    if let (Some(start), Some(end)) = (state.scheduled_start_ms, state.scheduled_end_ms) {
        timestamp_to_iso(start).map_err(|_| invalid("scheduled_start is invalid"))?;
        timestamp_to_iso(end).map_err(|_| invalid("scheduled_end is invalid"))?;
        if end <= start {
            return Err(invalid("scheduled_end must be after scheduled_start"));
        }
    }
    if state.is_all_day && state.scheduled_start_ms.is_none() {
        return Err(invalid("is_all_day requires a schedule range"));
    }
    if let Some(recurrence) = state.recurrence.as_ref() {
        validate_recurrence_input(recurrence)?;
    }
    validate_reminders_input(&state.reminders)?;
    validate_timezone_input(state.schedule_timezone.as_deref())
}

fn validate_update_request(
    page_id: &str,
    occurrence_start_ms: i64,
    scope: PageOccurrenceUpdateScope,
    created_page_id: Option<&str>,
    updates: &PageOccurrenceSchedulePatch,
) -> Result<(), String> {
    validate_common(page_id, occurrence_start_ms)?;
    match scope {
        PageOccurrenceUpdateScope::All if created_page_id.is_some() => {
            return Err("created_page_id must be omitted for scope all".to_owned());
        }
        PageOccurrenceUpdateScope::All => {}
        PageOccurrenceUpdateScope::This | PageOccurrenceUpdateScope::ThisAndFuture => {
            validate_uuid_v7(
                created_page_id.ok_or_else(|| {
                    "created_page_id is required for this update scope".to_owned()
                })?,
                "created_page_id",
            )?;
        }
    }
    if updates.scheduled_start_ms.is_none()
        && updates.scheduled_end_ms.is_none()
        && updates.is_all_day.is_none()
        && updates.recurrence.is_none()
        && updates.reminders.is_none()
        && updates.schedule_timezone.is_none()
    {
        return Err("updates must contain a schedule field".to_owned());
    }
    if let Some(Some(recurrence)) = updates.recurrence.as_ref() {
        validate_recurrence_input(recurrence).map_err(|error| error.message)?;
    }
    if let Some(reminders) = updates.reminders.as_ref() {
        validate_reminders_input(reminders).map_err(|error| error.message)?;
    }
    if let Some(timezone) = updates.schedule_timezone.as_ref() {
        validate_timezone_input(timezone.as_deref()).map_err(|error| error.message)?;
    }
    for value in [
        updates.scheduled_start_ms.as_ref().and_then(|value| *value),
        updates.scheduled_end_ms.as_ref().and_then(|value| *value),
    ]
    .into_iter()
    .flatten()
    {
        timestamp_to_iso(value).map_err(|error| error.message)?;
    }
    if let (Some(Some(start)), Some(Some(end))) =
        (&updates.scheduled_start_ms, &updates.scheduled_end_ms)
        && end <= start
    {
        return Err("scheduled_end must be after scheduled_start".to_owned());
    }
    Ok(())
}

fn validate_common(page_id: &str, occurrence_start_ms: i64) -> Result<(), String> {
    validate_id(page_id, "page_id")?;
    timestamp_to_iso(occurrence_start_ms)
        .map(|_| ())
        .map_err(|_| "occurrence_start_ms is invalid".to_owned())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if !value.is_empty() && value.trim() == value && value.len() <= MAX_ID_LENGTH {
        return Ok(());
    }
    Err(format!("{label} is invalid"))
}

fn validate_uuid_v7(value: &str, label: &str) -> Result<(), String> {
    validate_id(value, label)?;
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        });
    if valid {
        return Ok(());
    }
    Err(format!("{label} must be a canonical lowercase UUID-v7"))
}

fn shifted_drag_recurrence(
    page: &ScheduledPageOccurrence,
    occurrence_start_ms: i64,
    updates: &PageOccurrenceSchedulePatch,
) -> Result<Option<PageRecurrenceConfig>, StoreError> {
    let timezone = updates
        .schedule_timezone
        .as_ref()
        .and_then(|value| value.as_deref())
        .or(page.schedule_timezone.as_deref());
    shifted_drag_recurrence_in_timezone(page, occurrence_start_ms, updates, timezone)
}

fn shifted_drag_recurrence_in_timezone(
    page: &ScheduledPageOccurrence,
    occurrence_start_ms: i64,
    updates: &PageOccurrenceSchedulePatch,
    timezone: Option<&str>,
) -> Result<Option<PageRecurrenceConfig>, StoreError> {
    let (Some(recurrence), Some(Some(next_start_ms))) = (
        page.recurrence.as_ref(),
        updates.scheduled_start_ms.as_ref(),
    ) else {
        return Ok(None);
    };
    let Some(PageRecurrenceEndCondition::UntilDate { until_date }) =
        recurrence.end_condition.as_ref()
    else {
        return Ok(None);
    };
    let from = local_date_key(occurrence_start_ms, timezone)?;
    let to = local_date_key(*next_start_ms, timezone)?;
    let from_date = chrono::NaiveDate::parse_from_str(&from, "%Y-%m-%d")
        .map_err(|_| invalid("Occurrence date is invalid"))?;
    let to_date = chrono::NaiveDate::parse_from_str(&to, "%Y-%m-%d")
        .map_err(|_| invalid("Updated occurrence date is invalid"))?;
    let days = to_date.signed_duration_since(from_date).num_days();
    if days == 0 {
        return Ok(None);
    }
    let mut shifted = recurrence.clone();
    shifted.end_condition = Some(PageRecurrenceEndCondition::UntilDate {
        until_date: shift_date_key(until_date, days)?,
    });
    Ok(Some(shifted))
}

fn patch_for_series(
    updates: &PageOccurrenceSchedulePatch,
    shifted: Option<PageRecurrenceConfig>,
) -> PageOccurrenceSchedulePatch {
    let mut patch = updates.clone();
    if patch.recurrence.is_none() && shifted.is_some() {
        patch.recurrence = Some(shifted);
    }
    patch
}

fn one_time_patch(updates: &PageOccurrenceSchedulePatch) -> PageOccurrenceSchedulePatch {
    PageOccurrenceSchedulePatch {
        scheduled_start_ms: updates.scheduled_start_ms,
        scheduled_end_ms: updates.scheduled_end_ms,
        is_all_day: updates.is_all_day,
        reminders: updates.reminders.clone(),
        schedule_timezone: updates.schedule_timezone.clone(),
        recurrence: None,
    }
}

fn normalize_timing(
    page: &ScheduledPageOccurrence,
    occurrence_start_ms: i64,
    updates: &PageOccurrenceSchedulePatch,
) -> Result<(i64, i64), StoreError> {
    let start = updates
        .scheduled_start_ms
        .flatten()
        .unwrap_or(occurrence_start_ms);
    let duration =
        (page.occurrence_end_ms - page.occurrence_start_ms).max(MIN_OCCURRENCE_DURATION_MS);
    let fallback_end = start
        .checked_add(duration)
        .ok_or_else(|| invalid("Occurrence timing exceeds the timestamp range"))?;
    let requested_end = updates.scheduled_end_ms.flatten().unwrap_or(fallback_end);
    let end = if requested_end > start {
        requested_end
    } else {
        fallback_end
    };
    timestamp_to_iso(start)?;
    timestamp_to_iso(end)?;
    Ok((start, end))
}

fn upsert_skip_exception(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    occurrence_start_ms: i64,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO recurrence_exceptions( \
           library_id, page_id, occurrence_start, exception_type, created \
         ) VALUES (?1, ?2, ?3, 'skip', ?4) \
         ON CONFLICT(library_id, page_id, occurrence_start) DO UPDATE SET \
           exception_type = 'skip', override_start = NULL, override_end = NULL, \
           override_reminders_json = NULL",
        params![
            library_id,
            page_id,
            timestamp_to_iso(occurrence_start_ms)?,
            now,
        ],
    )?;
    Ok(())
}

fn identity_exists(connection: &Connection, page_id: &str) -> Result<bool, StoreError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM blocks WHERE id = ?1 UNION ALL \
             SELECT 1 FROM documents WHERE id = ?2 LIMIT 1",
            params![page_id, format!("document:{page_id}")],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn deterministic_update_rejection(
    operation_id: &str,
    page_id: &str,
    error: StoreError,
    now: &str,
) -> Result<OccurrenceMutationEffects, StoreError> {
    if error.code == StoreErrorCode::InvalidInput {
        return Ok(rejected(
            "update_page_occurrence",
            operation_id,
            page_id,
            PageOccurrenceMutationCode::InvalidOccurrenceRequest,
            &error.message,
            now,
        ));
    }
    Err(error)
}

fn success(
    operation_kind: &'static str,
    operation_id: &str,
    mut page_ids: Vec<String>,
    mut document_ids: Vec<String>,
    mut database_ids: Vec<String>,
    created_page_id: Option<String>,
    now: &str,
) -> OccurrenceMutationEffects {
    page_ids.sort();
    page_ids.dedup();
    document_ids.sort();
    document_ids.dedup();
    database_ids.sort();
    database_ids.dedup();
    OccurrenceMutationEffects {
        operation_kind,
        result: PageOccurrenceMutationResult {
            success: true,
            operation_id: operation_id.to_owned(),
            duplicate: false,
            commit_seq: None,
            created_page_id,
            code: None,
            error: None,
        },
        page_ids,
        document_ids,
        database_ids,
        committed_at: now.to_owned(),
    }
}

fn rejected(
    operation_kind: &'static str,
    operation_id: &str,
    page_id: &str,
    code: PageOccurrenceMutationCode,
    message: &str,
    now: &str,
) -> OccurrenceMutationEffects {
    OccurrenceMutationEffects {
        operation_kind,
        result: PageOccurrenceMutationResult {
            success: false,
            operation_id: operation_id.to_owned(),
            duplicate: false,
            commit_seq: None,
            created_page_id: None,
            code: Some(code),
            error: Some(message.to_owned()),
        },
        page_ids: vec![page_id.to_owned()],
        document_ids: Vec::new(),
        database_ids: Vec::new(),
        committed_at: now.to_owned(),
    }
}

fn require_active_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    Err(unauthorized(
        "Page occurrence mutation requires an active bound Project",
    ))
}

fn parse_object(value: &str, label: &str) -> Result<Map<String, Value>, StoreError> {
    parse_value(value)?
        .as_object()
        .cloned()
        .ok_or_else(|| corrupt(&format!("{label} is invalid")))
}

fn parse_value(value: &str) -> Result<Value, StoreError> {
    serde_json::from_str(value).map_err(|_| corrupt("Stored Page property JSON is invalid"))
}

fn parse_nullable_string(value: &str) -> Result<Option<String>, StoreError> {
    let value = parse_value(value)?;
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| corrupt("Scheduled Page nullable string property is invalid"))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
