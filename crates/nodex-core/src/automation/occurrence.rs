use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone,
    Timelike, Utc, Weekday,
};
use chrono_tz::Tz;
use nodex_core_contracts::automation::{
    PageRecurrenceConfig, PageRecurrenceEndCondition, PageRecurrenceFrequency, PageReminderConfig,
    ScheduledPageOccurrence,
};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue},
};

const MAX_GENERATED_OCCURRENCES: usize = 20_000;
const MAX_READ_LIMIT: u32 = 20_000;
const MAX_REMINDER_OFFSET_MINUTES: i32 = 365 * 24 * 60;
const UNPOSITIONED_PAGE_ORDER: i64 = 9_007_199_254_740_991;

pub(super) struct OccurrenceWindowQuery<'a> {
    pub project_id: &'a str,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub search_query: Option<&'a str>,
}

const INTRINSIC_PROPERTY_KEYS: [&str; 9] = [
    "run.target",
    "run.localPath",
    "run.baseBranch",
    "run.worktreePath",
    "run.environmentPath",
    "schedule.isAllDay",
    "schedule.timezone",
    "recurrence.config",
    "reminders.config",
];

#[derive(Clone)]
struct ScheduledRow {
    page_id: String,
    library_id: String,
    index_lifecycle: String,
    block_lifecycle: String,
    metadata_revision: i64,
    source_metadata_revision: i64,
    scheduled_start: String,
    scheduled_end: String,
    is_all_day: bool,
    recurrence_json: String,
    reminders_json: String,
    schedule_timezone: Option<String>,
    block_created_at: String,
    block_updated_at: String,
    document_generation: Option<i64>,
    document_head_seq: Option<i64>,
    document_schema_version: Option<i64>,
    document_readiness: Option<String>,
    document_authority: Option<String>,
    materialization_generation: Option<i64>,
    materialization_projected_seq: Option<i64>,
    materialization_schema_version: Option<i64>,
    title: Option<String>,
    rich_title_json: Option<String>,
    description: Option<String>,
    materialization_updated_at: Option<String>,
    membership_id: Option<String>,
    data_source_id: Option<String>,
    page_key: Option<String>,
    view_order: Option<i64>,
}

#[derive(Clone)]
struct PropertyValue {
    value: Value,
    config: Value,
}

#[derive(Clone)]
pub(super) struct RecurrenceException {
    occurrence_start_ms: i64,
    exception_type: String,
    override_start_ms: Option<i64>,
    override_end_ms: Option<i64>,
    override_reminders: Option<Vec<PageReminderConfig>>,
}

#[derive(Clone)]
struct ExpandedOccurrence {
    start_ms: i64,
    end_ms: i64,
    reminders: Vec<PageReminderConfig>,
}

#[derive(Clone, Copy)]
enum ScheduleZone {
    Named(Tz),
    Local,
}

impl ScheduleZone {
    fn parse(value: Option<&str>) -> Result<Self, StoreError> {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(Self::Local);
        };
        Tz::from_str(value)
            .map(Self::Named)
            .map_err(|_| corrupt("Scheduled Page timezone is invalid"))
    }

    fn local_naive(self, timestamp_ms: i64) -> Result<NaiveDateTime, StoreError> {
        match self {
            Self::Named(zone) => zone
                .timestamp_millis_opt(timestamp_ms)
                .single()
                .map(|value| value.naive_local()),
            Self::Local => Local
                .timestamp_millis_opt(timestamp_ms)
                .single()
                .map(|value| value.naive_local()),
        }
        .ok_or_else(|| corrupt("Scheduled Page timestamp is outside the calendar range"))
    }

    fn timestamp_ms(self, local: NaiveDateTime) -> Result<i64, StoreError> {
        match self {
            Self::Named(zone) => resolve_local_named(zone, local),
            Self::Local => resolve_local_system(local),
        }
    }
}

pub(super) fn read_occurrence_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    query: OccurrenceWindowQuery<'_>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ScheduledPageOccurrence>, StoreError> {
    let normalized = normalize_request(request)?;
    let normalized_search = query.search_query.unwrap_or_default().trim();
    let fingerprint = cursor::query_fingerprint(&(
        "automation_occurrences_v1",
        query.project_id,
        query.window_start_ms,
        query.window_end_ms,
        normalized_search,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "automation_occurrences",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Scheduled Page occurrence cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: occurrence_start_ms,
                },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid(
                    "Scheduled Page occurrence cursor coordinate is invalid",
                ));
            };
            Ok((*occurrence_start_ms, coordinate.stable_id))
        })
        .transpose()?;
    let items = collect_occurrences(
        connection,
        library_id,
        query.project_id,
        query.window_start_ms,
        query.window_end_ms,
        Some(normalized_search),
        after.as_ref().map(|(start, id)| (*start, id.as_str())),
        normalized.first + 1,
    )?;
    let candidates = items.into_iter().map(|item| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![KeysetValue::Integer {
                value: item.occurrence_start_ms,
            }],
            stable_id: item.occurrence_id.clone(),
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

pub(super) fn read_occurrences(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    window_start_ms: i64,
    window_end_ms: i64,
    search_query: Option<&str>,
    limit: u32,
) -> Result<Vec<ScheduledPageOccurrence>, StoreError> {
    if window_end_ms <= window_start_ms {
        return Ok(Vec::new());
    }
    if !(1..=MAX_READ_LIMIT).contains(&limit) {
        return Err(invalid("Scheduled Page occurrence read limit is invalid"));
    }
    collect_occurrences(
        connection,
        library_id,
        project_id,
        window_start_ms,
        window_end_ms,
        search_query,
        None,
        limit as usize,
    )
}

#[allow(clippy::too_many_arguments)]
fn collect_occurrences(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    window_start_ms: i64,
    window_end_ms: i64,
    search_query: Option<&str>,
    after: Option<(i64, &str)>,
    limit: usize,
) -> Result<Vec<ScheduledPageOccurrence>, StoreError> {
    if window_end_ms <= window_start_ms {
        return Ok(Vec::new());
    }
    require_active_project(connection, library_id, project_id)?;
    let search_tokens = normalize_search_tokens(search_query.unwrap_or_default());
    let mut items = BTreeMap::new();

    visit_scheduled_rows(
        connection,
        library_id,
        window_start_ms,
        window_end_ms,
        None,
        |row| {
            match crate::library::require_page_read_access(
                connection,
                library_id,
                project_id,
                &row.page_id,
            ) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.code,
                        StoreErrorCode::NotFound | StoreErrorCode::Unauthorized
                    ) =>
                {
                    return Ok(());
                }
                Err(error) => return Err(error),
            }
            let projection = validate_and_project(connection, &row)?;
            if !search_tokens.is_empty() && !matches_search(&projection, &search_tokens) {
                return Ok(());
            }
            let exceptions = read_exceptions(connection, &row.page_id)?;
            let expanded = expand_occurrences(
                projection.occurrence_start_ms,
                projection.occurrence_end_ms,
                projection.is_all_day,
                projection.recurrence.as_ref(),
                &projection.reminders,
                projection.schedule_timezone.as_deref(),
                &exceptions,
                window_start_ms,
                window_end_ms,
            )?;
            let first_start = projection.occurrence_start_ms;
            for occurrence in expanded {
                let mut item = projection.clone();
                item.occurrence_id = format!(
                    "{}:{}",
                    item.page_id,
                    timestamp_to_iso(occurrence.start_ms)?
                );
                item.occurrence_start_ms = occurrence.start_ms;
                item.occurrence_end_ms = occurrence.end_ms;
                item.reminders = occurrence.reminders;
                item.is_recurring = item.recurrence.is_some();
                item.this_and_future_equivalent_to_all =
                    item.is_recurring && occurrence.start_ms <= first_start;
                let coordinate = (item.occurrence_start_ms, item.occurrence_id.clone());
                if after.is_some_and(|(start, id)| {
                    coordinate.0 < start || (coordinate.0 == start && coordinate.1.as_str() <= id)
                }) {
                    continue;
                }
                items.insert(coordinate, item);
                if items.len() > limit {
                    items.pop_last();
                }
            }
            Ok(())
        },
    )?;

    Ok(items.into_values().collect())
}

pub(super) fn read_occurrences_for_reminders(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<Vec<ScheduledPageOccurrence>, StoreError> {
    read_occurrences(
        connection,
        library_id,
        project_id,
        window_start_ms,
        window_end_ms,
        None,
        MAX_READ_LIMIT,
    )
}

pub(super) fn read_current_page_title(
    connection: &Connection,
    page_id: &str,
) -> Result<String, StoreError> {
    let row = connection
        .query_row(
            "SELECT document.generation, document.head_seq, \
               document.schema_version, document.readiness, document.authority, \
               materialization.generation, materialization.projected_seq, \
               materialization.schema_version, materialization.title \
             FROM blocks block \
             LEFT JOIN block_documents ownership ON ownership.block_id = block.id \
               AND ownership.library_id = block.library_id \
             LEFT JOIN documents document ON document.id = ownership.document_id \
               AND document.library_id = ownership.library_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
             WHERE block.id = ?1 AND block.type = 'page' AND block.lifecycle <> 'deleted'",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Reminder Page is unavailable"))?;
    if row.3.as_deref() != Some("ready")
        || row.4.as_deref() != Some("ydoc_primary")
        || row.0.is_none()
        || row.1.is_none()
        || row.2.is_none()
        || row.5 != row.0
        || row.6 != row.1
        || row.7 != row.2
        || row.8.is_none()
    {
        return Err(corrupt(
            "Reminder Page has no materialization for its current Document head",
        ));
    }
    Ok(row.8.expect("validated reminder title"))
}

fn read_scheduled_rows(
    connection: &Connection,
    library_id: &str,
    window_start_ms: i64,
    window_end_ms: i64,
    page_id: Option<&str>,
) -> Result<Vec<ScheduledRow>, StoreError> {
    let mut result = Vec::new();
    visit_scheduled_rows(
        connection,
        library_id,
        window_start_ms,
        window_end_ms,
        page_id,
        |row| {
            result.push(row);
            Ok(())
        },
    )?;
    Ok(result)
}

fn visit_scheduled_rows(
    connection: &Connection,
    library_id: &str,
    window_start_ms: i64,
    window_end_ms: i64,
    page_id: Option<&str>,
    mut visitor: impl FnMut(ScheduledRow) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let window_start = timestamp_to_iso(window_start_ms)?;
    let window_end = timestamp_to_iso(window_end_ms)?;
    let mut statement = connection.prepare(
        "WITH ranked_positions AS ( \
           SELECT view.database_block_id, view.data_source_id, position.page_block_id, \
             CAST(ROW_NUMBER() OVER ( \
               PARTITION BY view.id \
               ORDER BY position.rank_key, position.page_block_id \
             ) - 1 AS INTEGER) AS view_order \
           FROM database_views view \
           JOIN database_containers container \
             ON container.default_view_id = view.id AND container.block_id = view.database_block_id \
           JOIN database_view_page_positions position ON position.view_id = view.id \
           WHERE view.layout = 'board' AND view.lifecycle = 'active' \
         ) \
         SELECT schedule.page_block_id, schedule.library_id, schedule.lifecycle, block.lifecycle, \
           block.metadata_revision, schedule.source_metadata_revision, schedule.scheduled_start, \
           schedule.scheduled_end, schedule.is_all_day, schedule.recurrence_json, \
           schedule.reminders_json, schedule.schedule_timezone, block.created_at, block.updated_at, \
           document.generation, document.head_seq, document.schema_version, document.readiness, \
           document.authority, materialization.generation, materialization.projected_seq, \
           materialization.schema_version, materialization.title, \
           materialization.title_rich_json, materialization.preview, materialization.updated_at, \
           membership.id, source.id, \
           CASE WHEN key_assignment.number IS NULL THEN NULL \
             ELSE key_prefix.normalized_prefix || '-' || key_assignment.number END, \
           position.view_order \
         FROM scheduled_page_index schedule \
         JOIN blocks block ON block.id = schedule.page_block_id \
           AND block.library_id = schedule.library_id AND block.type = 'page' \
         JOIN pages page ON page.block_id = block.id AND page.library_id = ?1 \
         LEFT JOIN block_documents ownership ON ownership.block_id = block.id \
           AND ownership.library_id = block.library_id \
         LEFT JOIN documents document ON document.id = ownership.document_id \
           AND document.library_id = ownership.library_id \
         LEFT JOIN document_materializations materialization \
           ON materialization.document_id = document.id \
         LEFT JOIN data_source_page_memberships membership \
           ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
         LEFT JOIN data_sources source ON source.id = membership.data_source_id \
           AND source.library_id = block.library_id \
           AND page.parent_kind = 'data_source' AND page.parent_id = source.id \
         LEFT JOIN page_key_assignments key_assignment \
           ON key_assignment.database_block_id = source.home_database_block_id \
           AND key_assignment.page_block_id = block.id \
         LEFT JOIN page_key_prefixes key_prefix \
           ON key_prefix.database_block_id = key_assignment.database_block_id \
           AND key_prefix.library_id = page.library_id \
           AND key_prefix.retired_at IS NULL \
         LEFT JOIN ranked_positions position \
           ON position.database_block_id = source.home_database_block_id \
           AND position.data_source_id = membership.data_source_id \
           AND position.page_block_id = block.id \
         WHERE block.lifecycle <> 'deleted' \
           AND schedule.scheduled_start IS NOT NULL AND schedule.scheduled_end IS NOT NULL \
           AND schedule.scheduled_start < ?2 \
           AND (schedule.recurrence_json <> 'null' OR schedule.scheduled_end > ?3) \
           AND (?4 IS NULL OR schedule.page_block_id = ?4) \
         ORDER BY schedule.scheduled_start, schedule.page_block_id",
    )?;
    let mut rows = statement.query(params![library_id, window_end, window_start, page_id])?;
    while let Some(row) = rows.next()? {
        visitor(ScheduledRow {
            page_id: row.get(0)?,
            library_id: row.get(1)?,
            index_lifecycle: row.get(2)?,
            block_lifecycle: row.get(3)?,
            metadata_revision: row.get(4)?,
            source_metadata_revision: row.get(5)?,
            scheduled_start: row.get(6)?,
            scheduled_end: row.get(7)?,
            is_all_day: row.get::<_, i64>(8)? == 1,
            recurrence_json: row.get(9)?,
            reminders_json: row.get(10)?,
            schedule_timezone: row.get(11)?,
            block_created_at: row.get(12)?,
            block_updated_at: row.get(13)?,
            document_generation: row.get(14)?,
            document_head_seq: row.get(15)?,
            document_schema_version: row.get(16)?,
            document_readiness: row.get(17)?,
            document_authority: row.get(18)?,
            materialization_generation: row.get(19)?,
            materialization_projected_seq: row.get(20)?,
            materialization_schema_version: row.get(21)?,
            title: row.get(22)?,
            rich_title_json: row.get(23)?,
            description: row.get(24)?,
            materialization_updated_at: row.get(25)?,
            membership_id: row.get(26)?,
            data_source_id: row.get(27)?,
            page_key: row.get(28)?,
            view_order: row.get(29)?,
        })?;
    }
    Ok(())
}

pub(super) fn read_scheduled_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<ScheduledPageOccurrence>, StoreError> {
    let rows = read_scheduled_rows(
        connection,
        library_id,
        -62_135_596_800_000,
        253_402_300_799_999,
        Some(page_id),
    )?;
    rows.first()
        .map(|row| validate_and_project(connection, row))
        .transpose()
}

fn validate_and_project(
    connection: &Connection,
    row: &ScheduledRow,
) -> Result<ScheduledPageOccurrence, StoreError> {
    if row.index_lifecycle != row.block_lifecycle
        || row.source_metadata_revision != row.metadata_revision
    {
        return Err(corrupt("Scheduled Page index is stale"));
    }
    if row.document_readiness.as_deref() != Some("ready")
        || row.document_authority.as_deref() != Some("ydoc_primary")
        || row.document_generation.is_none()
        || row.document_head_seq.is_none()
        || row.document_schema_version.is_none()
        || row.materialization_generation != row.document_generation
        || row.materialization_projected_seq != row.document_head_seq
        || row.materialization_schema_version != row.document_schema_version
        || row.title.is_none()
        || row.rich_title_json.is_none()
        || row.description.is_none()
        || row.materialization_updated_at.is_none()
    {
        return Err(corrupt(
            "Scheduled Page has no materialization for its current Document head",
        ));
    }
    let membership_id = row
        .membership_id
        .as_deref()
        .ok_or_else(|| corrupt("Scheduled Page has no active Data Source membership"))?;
    let data_source_id = row
        .data_source_id
        .as_deref()
        .ok_or_else(|| corrupt("Scheduled Page has no active Data Source"))?;
    let database = read_database_properties(connection, membership_id, data_source_id)?;
    let intrinsic = read_intrinsic_properties(connection, &row.page_id, &row.library_id)?;

    let status = optional_string(&database, "status")?.unwrap_or_else(|| "triage".to_owned());
    let status_name = status_label(&status)
        .ok_or_else(|| corrupt("Scheduled Page status is invalid"))?
        .to_owned();
    let priority = optional_string(&database, "priority")?;
    let estimate = optional_string(&database, "estimate")?;
    let assignee = optional_string(&database, "assignee")?;
    let due_date = optional_string(&database, "due_date")?;
    if let Some(value) = due_date.as_deref() {
        let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| corrupt("Scheduled Page due date is invalid"))?;
        if parsed.format("%Y-%m-%d").to_string() != value {
            return Err(corrupt("Scheduled Page due date is invalid"));
        }
    }
    let tags = database
        .get("tags")
        .map(|property| {
            if property.value.is_null() {
                return Ok(Vec::new());
            }
            resolve_tags(&property.value, &property.config)
        })
        .transpose()?
        .unwrap_or_default();
    let run_in_target = Some(required_string(&intrinsic, "run.target")?);
    if !matches!(
        run_in_target.as_deref(),
        Some("localProject" | "newWorktree" | "cloud")
    ) {
        return Err(corrupt("Scheduled Page run target is invalid"));
    }
    let is_all_day = required_bool(&intrinsic, "schedule.isAllDay")?;
    let schedule_timezone = optional_string(&intrinsic, "schedule.timezone")?;
    ScheduleZone::parse(schedule_timezone.as_deref())?;
    let recurrence = optional_recurrence(required_value(&intrinsic, "recurrence.config")?)?;
    let reminders = parse_reminders(required_value(&intrinsic, "reminders.config")?)?;
    let indexed_recurrence = parse_recurrence_json(&row.recurrence_json)?;
    let indexed_reminders = parse_reminders_json(&row.reminders_json)?;
    let scheduled_start = required_string(&database, "scheduled_start")?;
    let scheduled_end = required_string(&database, "scheduled_end")?;
    if scheduled_start != row.scheduled_start
        || scheduled_end != row.scheduled_end
        || is_all_day != row.is_all_day
        || recurrence != indexed_recurrence
        || reminders != indexed_reminders
        || schedule_timezone != row.schedule_timezone
    {
        return Err(corrupt(
            "Scheduled Page index disagrees with relational Page properties",
        ));
    }
    let occurrence_start_ms = parse_timestamp(&row.scheduled_start)?;
    let occurrence_end_ms = parse_timestamp(&row.scheduled_end)?;
    if occurrence_end_ms <= occurrence_start_ms {
        return Err(corrupt("Scheduled Page range is invalid"));
    }
    let rich_title = serde_json::from_str::<Value>(
        row.rich_title_json
            .as_deref()
            .expect("validated rich title projection"),
    )
    .map_err(|_| corrupt("Scheduled Page rich title projection is invalid"))?;
    if !rich_title.is_array() {
        return Err(corrupt("Scheduled Page rich title projection is invalid"));
    }

    Ok(ScheduledPageOccurrence {
        occurrence_id: String::new(),
        page_id: row.page_id.clone(),
        page_key: row.page_key.clone(),
        status,
        status_name,
        archived: row.block_lifecycle == "archived",
        title: row.title.clone().expect("validated title projection"),
        rich_title,
        description: row.description.clone().expect("validated NFM projection"),
        priority,
        estimate,
        tags,
        due_date,
        occurrence_start_ms,
        occurrence_end_ms,
        is_all_day,
        recurrence,
        reminders,
        schedule_timezone,
        assignee,
        run_in_target,
        run_in_local_path: optional_string(&intrinsic, "run.localPath")?,
        run_in_base_branch: optional_string(&intrinsic, "run.baseBranch")?,
        run_in_worktree_path: optional_string(&intrinsic, "run.worktreePath")?,
        run_in_environment_path: optional_string(&intrinsic, "run.environmentPath")?,
        metadata_revision: row.metadata_revision,
        created_at: row.block_created_at.clone(),
        updated_at: row
            .materialization_updated_at
            .clone()
            .unwrap_or_else(|| row.block_updated_at.clone()),
        order: row.view_order.unwrap_or(UNPOSITIONED_PAGE_ORDER),
        is_recurring: false,
        this_and_future_equivalent_to_all: false,
    })
}

fn read_database_properties(
    connection: &Connection,
    membership_id: &str,
    data_source_id: &str,
) -> Result<BTreeMap<String, PropertyValue>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT property.id, property.config_json, value.value_json \
         FROM data_source_properties property \
         LEFT JOIN data_source_property_values value \
           ON value.property_id = property.id AND value.data_source_id = property.data_source_id \
           AND value.membership_id = ?1 \
         WHERE property.data_source_id = ?2 AND property.lifecycle = 'active' \
           AND property.id IN ('status','priority','estimate','tags','due_date', \
             'scheduled_start','scheduled_end','assignee')",
    )?;
    let rows = statement
        .query_map(params![membership_id, data_source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = BTreeMap::new();
    for (key, config_json, value_json) in rows {
        values.insert(
            key,
            PropertyValue {
                value: value_json
                    .map(|value| parse_json(&value, "Scheduled Page Data Source property"))
                    .transpose()?
                    .unwrap_or(Value::Null),
                config: parse_json(&config_json, "Scheduled Page Data Source configuration")?,
            },
        );
    }
    Ok(values)
}

fn read_intrinsic_properties(
    connection: &Connection,
    page_id: &str,
    library_id: &str,
) -> Result<BTreeMap<String, PropertyValue>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT property_key, value_json FROM block_properties \
         WHERE block_id = ?1 AND library_id = ?2 AND property_key IN ( \
           'run.target','run.localPath','run.baseBranch','run.worktreePath', \
           'run.environmentPath','schedule.isAllDay','schedule.timezone', \
           'recurrence.config','reminders.config')",
    )?;
    let rows = statement
        .query_map(params![page_id, library_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = BTreeMap::new();
    for (key, value_json) in rows {
        values.insert(
            key,
            PropertyValue {
                value: parse_json(&value_json, "Scheduled Page intrinsic property")?,
                config: Value::Object(Default::default()),
            },
        );
    }
    if INTRINSIC_PROPERTY_KEYS
        .iter()
        .any(|key| !values.contains_key(*key))
    {
        return Err(corrupt(
            "Scheduled Page is missing a required intrinsic property",
        ));
    }
    Ok(values)
}

pub(super) fn read_exceptions(
    connection: &Connection,
    page_id: &str,
) -> Result<Vec<RecurrenceException>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT occurrence_start, exception_type, override_start, override_end, \
           override_reminders_json FROM recurrence_exceptions \
         WHERE page_id = ?1 ORDER BY occurrence_start",
    )?;
    statement
        .query_map([page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(start, kind, override_start, override_end, reminders)| {
            if !matches!(kind.as_str(), "skip" | "override_time") {
                return Err(corrupt("Scheduled Page recurrence exception is invalid"));
            }
            Ok(RecurrenceException {
                occurrence_start_ms: parse_timestamp(&start)?,
                exception_type: kind,
                override_start_ms: override_start.as_deref().map(parse_timestamp).transpose()?,
                override_end_ms: override_end.as_deref().map(parse_timestamp).transpose()?,
                override_reminders: reminders.as_deref().map(parse_reminders_json).transpose()?,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn expand_occurrences(
    scheduled_start_ms: i64,
    scheduled_end_ms: i64,
    is_all_day: bool,
    recurrence: Option<&PageRecurrenceConfig>,
    reminders: &[PageReminderConfig],
    timezone: Option<&str>,
    exceptions: &[RecurrenceException],
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<Vec<ExpandedOccurrence>, StoreError> {
    if window_end_ms <= window_start_ms {
        return Ok(Vec::new());
    }
    let zone = ScheduleZone::parse(timezone)?;
    let duration_ms = (scheduled_end_ms - scheduled_start_ms).max(60_000);
    let all_day_span = is_all_day
        .then(|| all_day_span_days(zone, scheduled_start_ms, scheduled_end_ms))
        .transpose()?;
    let exception_map = exceptions
        .iter()
        .map(|exception| (exception.occurrence_start_ms, exception))
        .collect::<BTreeMap<_, _>>();
    let mut occurrences = Vec::new();

    let mut add = |base_start_ms: i64| -> Result<(), StoreError> {
        if let Some(recurrence) = recurrence
            && !included_by_end_condition(zone, base_start_ms, recurrence)?
        {
            return Ok(());
        }
        let exception = exception_map.get(&base_start_ms).copied();
        if exception.is_some_and(|value| value.exception_type == "skip") {
            return Ok(());
        }
        let start_ms = exception
            .and_then(|value| value.override_start_ms)
            .unwrap_or(base_start_ms);
        let end_ms = if let Some(value) = exception.and_then(|value| value.override_end_ms) {
            value
        } else if let Some(days) = all_day_span {
            add_days(zone, start_ms, days)?
        } else {
            start_ms
                .checked_add(duration_ms)
                .ok_or_else(|| corrupt("Scheduled Page occurrence exceeds the timestamp range"))?
        };
        if end_ms > window_start_ms && start_ms < window_end_ms {
            occurrences.push(ExpandedOccurrence {
                start_ms,
                end_ms,
                reminders: exception
                    .and_then(|value| value.override_reminders.clone())
                    .unwrap_or_else(|| reminders.to_vec()),
            });
        }
        Ok(())
    };

    let Some(recurrence) = recurrence else {
        add(scheduled_start_ms)?;
        return Ok(occurrences);
    };

    let mut cursor = scheduled_start_ms;
    let mut generated = 0_usize;
    if recurrence.frequency == PageRecurrenceFrequency::Weekly {
        let end_scan = add_days(zone, window_end_ms, 14)?;
        while cursor < end_scan && generated < MAX_GENERATED_OCCURRENCES {
            generated += 1;
            if cursor >= scheduled_start_ms
                && weekly_match(zone, cursor, scheduled_start_ms, recurrence)?
            {
                add(cursor)?;
            }
            cursor = add_days(zone, cursor, 1)?;
        }
    } else {
        while cursor < window_end_ms && generated < MAX_GENERATED_OCCURRENCES {
            generated += 1;
            add(cursor)?;
            cursor = match recurrence.frequency {
                PageRecurrenceFrequency::Daily => {
                    add_days(zone, cursor, i64::from(recurrence.interval))?
                }
                PageRecurrenceFrequency::Monthly => {
                    add_months(zone, cursor, i64::from(recurrence.interval))?
                }
                PageRecurrenceFrequency::Yearly => {
                    add_years(zone, cursor, i64::from(recurrence.interval))?
                }
                PageRecurrenceFrequency::Weekly => unreachable!("weekly handled above"),
            };
        }
    }
    occurrences.sort_by_key(|item| item.start_ms);
    Ok(occurrences)
}

pub(super) fn next_schedule_after(
    page: &ScheduledPageOccurrence,
    after_occurrence_start_ms: i64,
    exceptions: &[RecurrenceException],
) -> Result<Option<(i64, i64)>, StoreError> {
    if page.recurrence.is_none() {
        return Ok(None);
    }
    let scan_start = after_occurrence_start_ms.checked_add(1).ok_or_else(|| {
        corrupt("Scheduled Page next-occurrence scan exceeds the timestamp range")
    })?;
    let zone = ScheduleZone::parse(page.schedule_timezone.as_deref())?;
    let scan_end = add_years(zone, scan_start, 5)?;
    let occurrences = expand_occurrences(
        page.occurrence_start_ms,
        page.occurrence_end_ms,
        page.is_all_day,
        page.recurrence.as_ref(),
        &page.reminders,
        page.schedule_timezone.as_deref(),
        exceptions,
        scan_start,
        scan_end,
    )?;
    Ok(occurrences
        .into_iter()
        .find(|occurrence| occurrence.start_ms > after_occurrence_start_ms)
        .map(|occurrence| (occurrence.start_ms, occurrence.end_ms)))
}

pub(super) fn local_date_key(
    timestamp_ms: i64,
    timezone: Option<&str>,
) -> Result<String, StoreError> {
    Ok(ScheduleZone::parse(timezone)?
        .local_naive(timestamp_ms)?
        .date()
        .format("%Y-%m-%d")
        .to_string())
}

pub(super) fn shift_date_key(value: &str, days: i64) -> Result<String, StoreError> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("Recurrence end date is invalid"))?;
    date.checked_add_signed(Duration::days(days))
        .map(|value| value.format("%Y-%m-%d").to_string())
        .ok_or_else(|| invalid("Recurrence end date exceeds the calendar range"))
}

pub(crate) fn validate_recurrence_input(
    recurrence: &PageRecurrenceConfig,
) -> Result<(), StoreError> {
    validate_recurrence(recurrence).map_err(|_| invalid("Recurrence config is invalid"))
}

pub(crate) fn validate_reminders_input(reminders: &[PageReminderConfig]) -> Result<(), StoreError> {
    let value = serde_json::to_value(reminders)
        .map_err(|_| invalid("Reminder config cannot be encoded"))?;
    parse_reminders(&value)
        .map(|_| ())
        .map_err(|_| invalid("Reminder config is invalid"))
}

pub(crate) fn validate_timezone_input(timezone: Option<&str>) -> Result<(), StoreError> {
    ScheduleZone::parse(timezone)
        .map(|_| ())
        .map_err(|_| invalid("Schedule timezone is invalid"))
}

fn weekly_match(
    zone: ScheduleZone,
    current_ms: i64,
    series_start_ms: i64,
    recurrence: &PageRecurrenceConfig,
) -> Result<bool, StoreError> {
    let current = zone.local_naive(current_ms)?;
    let start = zone.local_naive(series_start_ms)?;
    let current_weekday = weekday_number(current.weekday());
    let weekdays = if recurrence.by_weekdays.is_empty() {
        vec![weekday_number(start.weekday())]
    } else {
        recurrence.by_weekdays.clone()
    };
    if !weekdays.contains(&current_weekday) {
        return Ok(false);
    }
    let start_anchor = start.date() - Duration::days(i64::from(weekday_number(start.weekday())));
    let current_anchor =
        current.date() - Duration::days(i64::from(weekday_number(current.weekday())));
    let days = current_anchor
        .signed_duration_since(start_anchor)
        .num_days();
    Ok(days >= 0 && (days / 7) % i64::from(recurrence.interval) == 0)
}

fn included_by_end_condition(
    zone: ScheduleZone,
    start_ms: i64,
    recurrence: &PageRecurrenceConfig,
) -> Result<bool, StoreError> {
    match recurrence.end_condition.as_ref() {
        None | Some(PageRecurrenceEndCondition::Never) => Ok(true),
        Some(PageRecurrenceEndCondition::UntilDate { until_date }) => Ok(zone
            .local_naive(start_ms)?
            .date()
            .format("%Y-%m-%d")
            .to_string()
            <= *until_date),
    }
}

fn all_day_span_days(zone: ScheduleZone, start_ms: i64, end_ms: i64) -> Result<i64, StoreError> {
    let by_dates = zone
        .local_naive(end_ms)?
        .date()
        .signed_duration_since(zone.local_naive(start_ms)?.date())
        .num_days();
    if by_dates > 0 {
        return Ok(by_dates);
    }
    Ok(((end_ms - start_ms + 86_399_999) / 86_400_000).max(1))
}

fn add_days(zone: ScheduleZone, timestamp_ms: i64, days: i64) -> Result<i64, StoreError> {
    let local = zone.local_naive(timestamp_ms)?;
    let shifted = local
        .checked_add_signed(Duration::days(days))
        .and_then(|value| value.with_nanosecond(0))
        .ok_or_else(|| corrupt("Scheduled Page date exceeds the calendar range"))?;
    zone.timestamp_ms(shifted)
}

fn add_months(zone: ScheduleZone, timestamp_ms: i64, months: i64) -> Result<i64, StoreError> {
    let local = zone.local_naive(timestamp_ms)?;
    let month_index = i64::from(local.year())
        .checked_mul(12)
        .and_then(|value| value.checked_add(i64::from(local.month0())))
        .and_then(|value| value.checked_add(months))
        .ok_or_else(|| corrupt("Scheduled Page month exceeds the calendar range"))?;
    let year = i32::try_from(month_index.div_euclid(12))
        .map_err(|_| corrupt("Scheduled Page year exceeds the calendar range"))?;
    let month = u32::try_from(month_index.rem_euclid(12) + 1)
        .map_err(|_| corrupt("Scheduled Page month exceeds the calendar range"))?;
    let day = local.day().min(days_in_month(year, month)?);
    let date = NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| corrupt("Scheduled Page date is invalid"))?;
    zone.timestamp_ms(
        date.and_time(local.time())
            .with_nanosecond(0)
            .expect("zero nanoseconds are valid"),
    )
}

fn add_years(zone: ScheduleZone, timestamp_ms: i64, years: i64) -> Result<i64, StoreError> {
    let local = zone.local_naive(timestamp_ms)?;
    let year = i32::try_from(i64::from(local.year()) + years)
        .map_err(|_| corrupt("Scheduled Page year exceeds the calendar range"))?;
    let day = local.day().min(days_in_month(year, local.month())?);
    let date = NaiveDate::from_ymd_opt(year, local.month(), day)
        .ok_or_else(|| corrupt("Scheduled Page date is invalid"))?;
    zone.timestamp_ms(
        date.and_time(local.time())
            .with_nanosecond(0)
            .expect("zero nanoseconds are valid"),
    )
}

fn days_in_month(year: i32, month: u32) -> Result<u32, StoreError> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .ok_or_else(|| corrupt("Scheduled Page month is invalid"))?;
    Ok((next - Duration::days(1)).day())
}

fn resolve_local_named(zone: Tz, local: NaiveDateTime) -> Result<i64, StoreError> {
    match zone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).timestamp_millis()),
        LocalResult::None => resolve_named_gap(zone, local),
    }
}

fn resolve_named_gap(zone: Tz, local: NaiveDateTime) -> Result<i64, StoreError> {
    let before = (1..=180)
        .find_map(
            |minutes| match zone.from_local_datetime(&(local - Duration::minutes(minutes))) {
                LocalResult::Single(value) => Some(value.offset().fix().local_minus_utc()),
                LocalResult::Ambiguous(first, _) => Some(first.offset().fix().local_minus_utc()),
                LocalResult::None => None,
            },
        )
        .ok_or_else(|| corrupt("Scheduled Page local time cannot be resolved"))?;
    let after = (1..=180)
        .find_map(
            |minutes| match zone.from_local_datetime(&(local + Duration::minutes(minutes))) {
                LocalResult::Single(value) => Some(value.offset().fix().local_minus_utc()),
                LocalResult::Ambiguous(first, _) => Some(first.offset().fix().local_minus_utc()),
                LocalResult::None => None,
            },
        )
        .ok_or_else(|| corrupt("Scheduled Page local time cannot be resolved"))?;
    let shifted = local + Duration::seconds(i64::from(after - before));
    match zone.from_local_datetime(&shifted) {
        LocalResult::Single(value) => Ok(value.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).timestamp_millis()),
        LocalResult::None => Err(corrupt("Scheduled Page local time cannot be resolved")),
    }
}

fn resolve_local_system(local: NaiveDateTime) -> Result<i64, StoreError> {
    match Local.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).timestamp_millis()),
        LocalResult::None => {
            let shifted = (1..=180)
                .find_map(|minutes| {
                    let candidate = local + Duration::minutes(minutes);
                    match Local.from_local_datetime(&candidate) {
                        LocalResult::Single(value) => Some(value.timestamp_millis()),
                        LocalResult::Ambiguous(first, second) => {
                            Some(first.min(second).timestamp_millis())
                        }
                        LocalResult::None => None,
                    }
                })
                .ok_or_else(|| corrupt("Scheduled Page local time cannot be resolved"))?;
            Ok(shifted)
        }
    }
}

fn parse_recurrence_json(value: &str) -> Result<Option<PageRecurrenceConfig>, StoreError> {
    optional_recurrence(&parse_json(value, "Scheduled Page recurrence")?)
}

fn optional_recurrence(value: &Value) -> Result<Option<PageRecurrenceConfig>, StoreError> {
    if value.is_null() {
        return Ok(None);
    }
    let recurrence = serde_json::from_value::<PageRecurrenceConfig>(value.clone())
        .map_err(|_| corrupt("Scheduled Page recurrence is invalid"))?;
    validate_recurrence(&recurrence)?;
    Ok(Some(recurrence))
}

fn validate_recurrence(recurrence: &PageRecurrenceConfig) -> Result<(), StoreError> {
    if recurrence.interval == 0
        || recurrence.by_weekdays.iter().any(|value| *value > 6)
        || (!recurrence.by_weekdays.is_empty()
            && recurrence.by_weekdays.iter().collect::<BTreeSet<_>>().len()
                != recurrence.by_weekdays.len())
        || (recurrence.frequency == PageRecurrenceFrequency::Weekly
            && recurrence.by_weekdays.is_empty())
    {
        return Err(corrupt("Scheduled Page recurrence is invalid"));
    }
    if let Some(PageRecurrenceEndCondition::UntilDate { until_date }) =
        recurrence.end_condition.as_ref()
    {
        NaiveDate::parse_from_str(until_date, "%Y-%m-%d")
            .map_err(|_| corrupt("Scheduled Page recurrence end date is invalid"))?;
    }
    Ok(())
}

fn parse_reminders_json(value: &str) -> Result<Vec<PageReminderConfig>, StoreError> {
    let value = parse_json(value, "Scheduled Page reminders")?;
    parse_reminders(&value)
}

fn parse_reminders(value: &Value) -> Result<Vec<PageReminderConfig>, StoreError> {
    let reminders = serde_json::from_value::<Vec<PageReminderConfig>>(value.clone())
        .map_err(|_| corrupt("Scheduled Page reminders are invalid"))?;
    let mut seen = BTreeSet::new();
    if reminders.iter().any(|reminder| {
        reminder.offset_minutes < 0
            || reminder.offset_minutes > MAX_REMINDER_OFFSET_MINUTES
            || !seen.insert(reminder.offset_minutes)
    }) {
        return Err(corrupt("Scheduled Page reminders are invalid"));
    }
    Ok(reminders)
}

fn resolve_tags(value: &Value, config: &Value) -> Result<Vec<String>, StoreError> {
    let ids = value
        .as_array()
        .ok_or_else(|| corrupt("Scheduled Page tags are invalid"))?;
    let options = config
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| corrupt("Scheduled Page tag registry is invalid"))?;
    let names = options
        .iter()
        .map(|option| {
            let id = option.get("id").and_then(Value::as_str)?;
            let name = option.get("name").and_then(Value::as_str)?;
            Some((id, name))
        })
        .collect::<Option<BTreeMap<_, _>>>()
        .ok_or_else(|| corrupt("Scheduled Page tag registry is invalid"))?;
    let mut result = ids
        .iter()
        .map(|id| {
            let id = id
                .as_str()
                .ok_or_else(|| corrupt("Scheduled Page tags are invalid"))?;
            Ok(names.get(id).copied().unwrap_or(id).to_owned())
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    result.sort();
    Ok(result)
}

fn required_value<'a>(
    values: &'a BTreeMap<String, PropertyValue>,
    key: &str,
) -> Result<&'a Value, StoreError> {
    values
        .get(key)
        .map(|value| &value.value)
        .ok_or_else(|| corrupt("Scheduled Page property is unavailable"))
}

fn required_string(
    values: &BTreeMap<String, PropertyValue>,
    key: &str,
) -> Result<String, StoreError> {
    required_value(values, key)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| corrupt("Scheduled Page property is not a string"))
}

fn optional_string(
    values: &BTreeMap<String, PropertyValue>,
    key: &str,
) -> Result<Option<String>, StoreError> {
    let Some(value) = values.get(key).map(|value| &value.value) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| corrupt("Scheduled Page property is not a nullable string"))
}

fn required_bool(values: &BTreeMap<String, PropertyValue>, key: &str) -> Result<bool, StoreError> {
    required_value(values, key)?
        .as_bool()
        .ok_or_else(|| corrupt("Scheduled Page property is not a boolean"))
}

fn normalize_search_tokens(value: &str) -> Vec<String> {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn matches_search(item: &ScheduledPageOccurrence, tokens: &[String]) -> bool {
    let text = [
        item.page_key.as_deref().unwrap_or_default(),
        item.title.as_str(),
        item.description.as_str(),
        item.priority.as_deref().unwrap_or_default(),
        item.estimate.as_deref().unwrap_or_default(),
        item.assignee.as_deref().unwrap_or_default(),
        &item.tags.join(" "),
    ]
    .join(" ")
    .to_lowercase();
    tokens.iter().all(|token| text.contains(token))
}

fn require_active_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    let active = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if active {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "Scheduled Page occurrences require an active bound Project",
        false,
    ))
}

fn status_label(value: &str) -> Option<&'static str> {
    match value {
        "triage" => Some("Triage"),
        "plan" => Some("Plan"),
        "build" => Some("Build"),
        "review" => Some("Review"),
        "ship" => Some("Ship"),
        _ => None,
    }
}

fn weekday_number(value: Weekday) -> u8 {
    u8::try_from(value.num_days_from_sunday()).expect("weekday fits u8")
}

fn parse_timestamp(value: &str) -> Result<i64, StoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .map_err(|_| corrupt("Scheduled Page timestamp is invalid"))
}

pub(super) fn timestamp_to_iso(timestamp_ms: i64) -> Result<String, StoreError> {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| corrupt("Scheduled Page timestamp exceeds the calendar range"))
}

fn parse_json(value: &str, label: &str) -> Result<Value, StoreError> {
    serde_json::from_str(value).map_err(|_| corrupt(&format!("{label} JSON is invalid")))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recurrence(
        frequency: PageRecurrenceFrequency,
        interval: u32,
        weekdays: Vec<u8>,
    ) -> PageRecurrenceConfig {
        PageRecurrenceConfig {
            frequency,
            interval,
            by_weekdays: weekdays,
            end_condition: None,
        }
    }

    fn millis(value: &str) -> i64 {
        DateTime::parse_from_rfc3339(value)
            .expect("timestamp")
            .timestamp_millis()
    }

    #[test]
    fn daily_recurrence_preserves_new_york_wall_clock_across_dst() {
        let items = expand_occurrences(
            millis("2026-03-07T14:00:00.000Z"),
            millis("2026-03-07T15:00:00.000Z"),
            false,
            Some(&recurrence(PageRecurrenceFrequency::Daily, 1, Vec::new())),
            &[],
            Some("America/New_York"),
            &[],
            millis("2026-03-07T00:00:00.000Z"),
            millis("2026-03-11T00:00:00.000Z"),
        )
        .expect("occurrences");
        assert_eq!(
            items.iter().map(|item| item.start_ms).collect::<Vec<_>>(),
            vec![
                millis("2026-03-07T14:00:00.000Z"),
                millis("2026-03-08T13:00:00.000Z"),
                millis("2026-03-09T13:00:00.000Z"),
                millis("2026-03-10T13:00:00.000Z"),
            ]
        );
    }

    #[test]
    fn weekly_recurrence_and_exceptions_use_base_occurrence_identity() {
        let skipped = millis("2026-07-20T09:00:00.000Z");
        let overridden = millis("2026-07-22T09:00:00.000Z");
        let items = expand_occurrences(
            millis("2026-07-13T09:00:00.000Z"),
            millis("2026-07-13T10:00:00.000Z"),
            false,
            Some(&recurrence(PageRecurrenceFrequency::Weekly, 1, vec![1, 3])),
            &[PageReminderConfig { offset_minutes: 30 }],
            Some("UTC"),
            &[
                RecurrenceException {
                    occurrence_start_ms: skipped,
                    exception_type: "skip".to_owned(),
                    override_start_ms: None,
                    override_end_ms: None,
                    override_reminders: None,
                },
                RecurrenceException {
                    occurrence_start_ms: overridden,
                    exception_type: "override_time".to_owned(),
                    override_start_ms: Some(millis("2026-07-22T11:00:00.000Z")),
                    override_end_ms: Some(millis("2026-07-22T12:30:00.000Z")),
                    override_reminders: Some(vec![PageReminderConfig { offset_minutes: 5 }]),
                },
            ],
            millis("2026-07-19T00:00:00.000Z"),
            millis("2026-07-24T00:00:00.000Z"),
        )
        .expect("occurrences");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].start_ms, millis("2026-07-22T11:00:00.000Z"));
        assert_eq!(items[0].end_ms, millis("2026-07-22T12:30:00.000Z"));
        assert_eq!(items[0].reminders[0].offset_minutes, 5);
    }

    #[test]
    fn monthly_and_yearly_recurrence_clamp_to_calendar_end() {
        let monthly = expand_occurrences(
            millis("2024-01-31T08:00:00.000Z"),
            millis("2024-01-31T09:00:00.000Z"),
            false,
            Some(&recurrence(PageRecurrenceFrequency::Monthly, 1, Vec::new())),
            &[],
            Some("UTC"),
            &[],
            millis("2024-01-01T00:00:00.000Z"),
            millis("2024-04-01T00:00:00.000Z"),
        )
        .expect("monthly");
        assert_eq!(
            monthly.iter().map(|item| item.start_ms).collect::<Vec<_>>(),
            vec![
                millis("2024-01-31T08:00:00.000Z"),
                millis("2024-02-29T08:00:00.000Z"),
                millis("2024-03-29T08:00:00.000Z"),
            ]
        );

        let yearly = expand_occurrences(
            millis("2024-02-29T08:00:00.000Z"),
            millis("2024-02-29T09:00:00.000Z"),
            false,
            Some(&recurrence(PageRecurrenceFrequency::Yearly, 1, Vec::new())),
            &[],
            Some("UTC"),
            &[],
            millis("2024-01-01T00:00:00.000Z"),
            millis("2027-01-01T00:00:00.000Z"),
        )
        .expect("yearly");
        assert_eq!(yearly[1].start_ms, millis("2025-02-28T08:00:00.000Z"));
    }

    #[test]
    fn all_day_duration_uses_local_date_span() {
        let items = expand_occurrences(
            millis("2026-03-07T05:00:00.000Z"),
            millis("2026-03-09T04:00:00.000Z"),
            true,
            Some(&recurrence(PageRecurrenceFrequency::Daily, 1, Vec::new())),
            &[],
            Some("America/New_York"),
            &[],
            millis("2026-03-08T00:00:00.000Z"),
            millis("2026-03-11T00:00:00.000Z"),
        )
        .expect("all-day occurrences");
        assert_eq!(items[1].end_ms - items[1].start_ms, 47 * 60 * 60 * 1_000);
    }
}
