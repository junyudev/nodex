use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::automation::{
    AutomationDefinition, AutomationDefinitionKind, AutomationDefinitionStatus,
    AutomationDueWorkLane, AutomationExecutionEnvironment, AutomationLease, AutomationLeaseStatus,
    AutomationRead, AutomationReadValue,
};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::agent_backend::binding_from_storage;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_ID_LENGTH: usize = 512;

pub(super) fn read(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    request: AutomationRead,
) -> Result<AutomationReadValue, StoreError> {
    match request {
        AutomationRead::DueWork { lane } => Ok(AutomationReadValue::DueWork {
            plan: match lane {
                AutomationDueWorkLane::Definitions => {
                    super::mutation::plan_definition_due_work(connection)?
                }
                AutomationDueWorkLane::Reminders => {
                    super::reminder::plan_due_work(connection, library_id)?
                }
            },
        }),
        AutomationRead::Definitions {
            include_deleted,
            window,
        } => Ok(AutomationReadValue::Definitions {
            window: read_definition_window(
                connection,
                library_id,
                commit_head,
                include_deleted.unwrap_or(false),
                &window,
            )?,
        }),
        AutomationRead::Definition { automation_id } => {
            validate_id("automation_id", &automation_id)?;
            Ok(AutomationReadValue::Definition {
                item: read_definition(connection, &automation_id)?.map(Box::new),
            })
        }
        AutomationRead::Leases {
            automation_id,
            include_settled,
            window,
        } => {
            if let Some(automation_id) = automation_id.as_deref() {
                validate_id("automation_id", automation_id)?;
            }
            Ok(AutomationReadValue::Leases {
                window: read_lease_window(
                    connection,
                    library_id,
                    commit_head,
                    automation_id.as_deref(),
                    include_settled.unwrap_or(false),
                    &window,
                )?,
            })
        }
        AutomationRead::Run { thread_id } => Ok(AutomationReadValue::Run {
            item: super::run::read_run(connection, &thread_id)?.map(Box::new),
        }),
        AutomationRead::Runs {
            automation_id,
            include_archived,
            window,
        } => Ok(AutomationReadValue::Runs {
            window: super::run::read_runs_window(
                connection,
                library_id,
                commit_head,
                automation_id.as_deref(),
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        AutomationRead::Inbox { window } => {
            let (window, unread_counts) =
                super::run::read_inbox_window(connection, library_id, commit_head, &window)?;
            Ok(AutomationReadValue::Inbox {
                window,
                unread_counts,
            })
        }
        AutomationRead::Occurrences {
            window_start_ms,
            window_end_ms,
            search_query,
            window,
        } => {
            let project_id = context
                .project_id
                .as_ref()
                .map(|value| value.0.as_str())
                .ok_or_else(|| {
                    unauthorized("Scheduled Page occurrences require a bound Project")
                })?;
            Ok(AutomationReadValue::Occurrences {
                window: super::occurrence::read_occurrence_window(
                    connection,
                    library_id,
                    commit_head,
                    super::occurrence::OccurrenceWindowQuery {
                        project_id,
                        window_start_ms,
                        window_end_ms,
                        search_query: search_query.as_deref(),
                    },
                    &window,
                )?,
            })
        }
        AutomationRead::ReminderLeases {
            include_settled,
            window,
        } => Ok(AutomationReadValue::ReminderLeases {
            window: super::reminder::read_lease_window(
                connection,
                library_id,
                commit_head,
                context.project_id.as_ref().map(|value| value.0.as_str()),
                include_settled.unwrap_or(false),
                &window,
            )?,
        }),
        AutomationRead::ReminderSnoozes {
            include_consumed,
            window,
        } => Ok(AutomationReadValue::ReminderSnoozes {
            window: super::reminder::read_snooze_window(
                connection,
                library_id,
                commit_head,
                context.project_id.as_ref().map(|value| value.0.as_str()),
                include_consumed.unwrap_or(false),
                &window,
            )?,
        }),
    }
}

fn read_definition_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    include_deleted: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<AutomationDefinition>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("automation_definitions_v1", include_deleted))?;
    let subject = CollectionCursorSubject {
        kind: "automation_definitions",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Automation definition cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: created_at_ms,
                },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid(
                    "Automation definition cursor coordinate is invalid",
                ));
            };
            Ok((*created_at_ms, coordinate.stable_id))
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT automation_id, definition_revision, kind, status, target_thread_id, name, \
                prompt, rrule, model, reasoning_effort, service_tier, cwds_json, \
                agent_backend_kind, agent_backend_definition_id, \
                agent_backend_instance_config_id, execution_environment, \
                local_environment_config_path, next_run_at, last_run_at, created_at, updated_at \
         FROM codex_scheduled_automations \
         WHERE (?1 OR status <> 'DELETED') \
           AND (?2 IS NULL OR created_at > ?2 OR (created_at = ?2 AND automation_id > ?3)) \
         ORDER BY created_at, automation_id LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![
                include_deleted,
                after.as_ref().map(|value| value.0),
                after.as_ref().map(|value| value.1.as_str()),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Automation definition window size is invalid"))?,
            ],
            definition_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Scheduled Automation definition column types are invalid"))?
        .into_iter()
        .map(validate_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let candidates = rows.into_iter().map(|item| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![KeysetValue::Integer {
                value: item.created_at_ms,
            }],
            stable_id: item.automation_id.clone(),
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

pub(super) fn read_definition(
    connection: &Connection,
    automation_id: &str,
) -> Result<Option<AutomationDefinition>, StoreError> {
    let definition = connection
        .query_row(
            "SELECT automation_id, definition_revision, kind, status, target_thread_id, name, \
                    prompt, rrule, model, reasoning_effort, service_tier, cwds_json, \
                    agent_backend_kind, agent_backend_definition_id, \
                    agent_backend_instance_config_id, execution_environment, \
                    local_environment_config_path, next_run_at, last_run_at, created_at, updated_at \
             FROM codex_scheduled_automations WHERE automation_id = ?1",
            [automation_id],
            definition_from_row,
        )
        .optional()
        .map_err(|_| corrupt("Scheduled Automation definition column types are invalid"))?;
    definition.map(validate_definition).transpose()
}

fn definition_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationDefinition> {
    let kind = parse_kind(row.get::<_, String>(2)?).map_err(rusqlite_conversion)?;
    let status = parse_status(row.get::<_, String>(3)?).map_err(rusqlite_conversion)?;
    let environment = parse_environment(row.get::<_, String>(15)?).map_err(rusqlite_conversion)?;
    let cwds_json = row.get::<_, String>(11)?;
    let cwds = serde_json::from_str::<Vec<String>>(&cwds_json)
        .map_err(|_| rusqlite_conversion("Scheduled Automation cwd JSON is invalid".to_owned()))?;
    Ok(AutomationDefinition {
        automation_id: row.get(0)?,
        definition_revision: row.get(1)?,
        kind,
        status,
        target_thread_id: row.get(4)?,
        name: row.get(5)?,
        prompt: row.get(6)?,
        rrule: row.get(7)?,
        model: row.get(8)?,
        reasoning_effort: row.get(9)?,
        service_tier: row.get(10)?,
        backend_binding: binding_from_storage(
            row.get::<_, String>(12)?.as_str(),
            row.get(13)?,
            row.get(14)?,
        )
        .map_err(|message| rusqlite_conversion(message.to_owned()))?,
        cwds,
        execution_environment: environment,
        local_environment_config_path: row.get(16)?,
        next_run_at_ms: row.get(17)?,
        last_run_at_ms: row.get(18)?,
        created_at_ms: row.get(19)?,
        updated_at_ms: row.get(20)?,
    })
}

fn validate_definition(
    definition: AutomationDefinition,
) -> Result<AutomationDefinition, StoreError> {
    validate_id("stored automation_id", &definition.automation_id)
        .map_err(|_| corrupt("Stored Scheduled Automation id is invalid"))?;
    if definition.definition_revision < 1
        || definition.name.trim().is_empty()
        || definition.created_at_ms < 0
        || definition.updated_at_ms < definition.created_at_ms
        || definition.next_run_at_ms.is_some_and(|value| value < 0)
        || definition.last_run_at_ms.is_some_and(|value| value < 0)
    {
        return Err(corrupt("Stored Scheduled Automation definition is invalid"));
    }
    for (label, value, max_bytes) in [
        ("model", definition.model.as_deref(), 512),
        (
            "reasoning_effort",
            definition.reasoning_effort.as_deref(),
            64,
        ),
        ("service_tier", definition.service_tier.as_deref(), 64),
    ] {
        if value.is_some_and(|value| {
            value.trim().is_empty()
                || value.trim() != value
                || value.len() > max_bytes
                || value.chars().any(char::is_control)
        }) {
            let message = format!("Stored Scheduled Automation {label} is invalid");
            return Err(corrupt(&message));
        }
    }
    Ok(definition)
}

fn read_lease_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    automation_id: Option<&str>,
    include_settled: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<AutomationLease>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("automation_leases_v1", automation_id, include_settled))?;
    let subject = CollectionCursorSubject {
        kind: "automation_leases",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 2 {
                return Err(invalid("Automation lease cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: scheduled_for_ms,
                },
                KeysetValue::Integer { value: attempt },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Automation lease cursor coordinate is invalid"));
            };
            Ok((*scheduled_for_ms, *attempt, coordinate.stable_id))
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT lease_id, automation_id, scheduled_for_ms, attempt, status, claimed_at_ms, \
                expires_at_ms, settled_at_ms, retry_at_ms, reason_code \
         FROM core_automation_leases \
         WHERE (?1 IS NULL OR automation_id = ?1) AND (?2 OR status = 'claimed') \
           AND (?3 IS NULL OR scheduled_for_ms < ?3 \
             OR (scheduled_for_ms = ?3 AND attempt < ?4) \
             OR (scheduled_for_ms = ?3 AND attempt = ?4 AND lease_id < ?5)) \
         ORDER BY scheduled_for_ms DESC, attempt DESC, lease_id DESC LIMIT ?6",
    )?;
    let rows = statement
        .query_map(
            params![
                automation_id,
                include_settled,
                after.as_ref().map(|value| value.0),
                after.as_ref().map(|value| value.1),
                after.as_ref().map(|value| value.2.as_str()),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Automation lease window size is invalid"))?,
            ],
            lease_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Automation lease column types are invalid"))?
        .into_iter()
        .map(validate_lease)
        .collect::<Result<Vec<_>, _>>()?;
    let candidates = rows.into_iter().map(|item| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![
                KeysetValue::Integer {
                    value: item.scheduled_for_ms,
                },
                KeysetValue::Integer {
                    value: i64::from(item.attempt),
                },
            ],
            stable_id: item.lease_id.clone(),
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

pub(super) fn read_lease(
    connection: &Connection,
    lease_id: &str,
) -> Result<Option<AutomationLease>, StoreError> {
    connection
        .query_row(
            "SELECT lease_id, automation_id, scheduled_for_ms, attempt, status, claimed_at_ms, \
                    expires_at_ms, settled_at_ms, retry_at_ms, reason_code \
             FROM core_automation_leases WHERE lease_id = ?1",
            [lease_id],
            lease_from_row,
        )
        .optional()
        .map_err(|_| corrupt("Automation lease column types are invalid"))?
        .map(validate_lease)
        .transpose()
}

fn lease_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationLease> {
    let attempt = row.get::<_, i64>(3)?;
    let attempt = u32::try_from(attempt)
        .map_err(|_| rusqlite_conversion("Automation lease attempt is invalid".to_owned()))?;
    Ok(AutomationLease {
        lease_id: row.get(0)?,
        automation_id: row.get(1)?,
        scheduled_for_ms: row.get(2)?,
        attempt,
        status: parse_lease_status(row.get::<_, String>(4)?).map_err(rusqlite_conversion)?,
        claimed_at_ms: row.get(5)?,
        expires_at_ms: row.get(6)?,
        settled_at_ms: row.get(7)?,
        retry_at_ms: row.get(8)?,
        reason_code: row.get(9)?,
    })
}

fn validate_lease(lease: AutomationLease) -> Result<AutomationLease, StoreError> {
    if lease.lease_id.is_empty()
        || lease.lease_id.len() > MAX_ID_LENGTH
        || lease.automation_id.is_empty()
        || lease.automation_id.len() > MAX_ID_LENGTH
        || lease.scheduled_for_ms < 0
        || lease.attempt == 0
        || lease.claimed_at_ms < 0
        || lease.expires_at_ms <= lease.claimed_at_ms
    {
        return Err(corrupt("Stored Automation lease is invalid"));
    }
    Ok(lease)
}

pub(super) fn kind_string(value: AutomationDefinitionKind) -> &'static str {
    match value {
        AutomationDefinitionKind::Cron => "cron",
        AutomationDefinitionKind::Heartbeat => "heartbeat",
    }
}

pub(super) fn status_string(value: AutomationDefinitionStatus) -> &'static str {
    match value {
        AutomationDefinitionStatus::Active => "ACTIVE",
        AutomationDefinitionStatus::Paused => "PAUSED",
        AutomationDefinitionStatus::Deleted => "DELETED",
    }
}

pub(super) fn environment_string(value: AutomationExecutionEnvironment) -> &'static str {
    match value {
        AutomationExecutionEnvironment::Local => "local",
        AutomationExecutionEnvironment::Worktree => "worktree",
    }
}

fn parse_kind(value: String) -> Result<AutomationDefinitionKind, String> {
    match value.as_str() {
        "cron" => Ok(AutomationDefinitionKind::Cron),
        "heartbeat" => Ok(AutomationDefinitionKind::Heartbeat),
        _ => Err("Scheduled Automation kind is invalid".to_owned()),
    }
}

fn parse_status(value: String) -> Result<AutomationDefinitionStatus, String> {
    match value.as_str() {
        "ACTIVE" => Ok(AutomationDefinitionStatus::Active),
        "PAUSED" => Ok(AutomationDefinitionStatus::Paused),
        "DELETED" => Ok(AutomationDefinitionStatus::Deleted),
        _ => Err("Scheduled Automation status is invalid".to_owned()),
    }
}

fn parse_environment(value: String) -> Result<AutomationExecutionEnvironment, String> {
    match value.as_str() {
        "local" => Ok(AutomationExecutionEnvironment::Local),
        "worktree" => Ok(AutomationExecutionEnvironment::Worktree),
        _ => Err("Scheduled Automation execution environment is invalid".to_owned()),
    }
}

fn parse_lease_status(value: String) -> Result<AutomationLeaseStatus, String> {
    match value.as_str() {
        "claimed" => Ok(AutomationLeaseStatus::Claimed),
        "completed" => Ok(AutomationLeaseStatus::Completed),
        "failed" => Ok(AutomationLeaseStatus::Failed),
        "cancelled" => Ok(AutomationLeaseStatus::Cancelled),
        _ => Err("Automation lease status is invalid".to_owned()),
    }
}

fn validate_id(label: &str, value: &str) -> Result<(), StoreError> {
    if !value.trim().is_empty()
        && value.trim() == value
        && value.len() <= MAX_ID_LENGTH
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\'])
    {
        return Ok(());
    }
    Err(invalid(&format!("{label} is invalid")))
}

fn rusqlite_conversion(message: String) -> rusqlite::Error {
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

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
