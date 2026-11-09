use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::automation::{
    Automation, AutomationCondition, AutomationDecision, AutomationDueWorkLane,
    AutomationExecutionEnvironment, AutomationExecutionKind, AutomationLease,
    AutomationLeasePurpose, AutomationLeaseStatus, AutomationMode, AutomationNotificationPolicy,
    AutomationRead, AutomationReadValue, AutomationStatus,
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
    if matches!(context.adapter, nodex_core_contracts::AdapterKind::Agent)
        && !matches!(
            &request,
            AutomationRead::AgentAutomation { .. } | AutomationRead::AgentAutomations { .. }
        )
    {
        return Err(unauthorized(
            "Agent Automation reads require Turn provenance",
        ));
    }
    match request {
        AutomationRead::AutomationExecutionAdmission {
            run_id,
            lease_id,
            dispatch_id,
        } => {
            if !matches!(
                context.adapter,
                nodex_core_contracts::AdapterKind::ElectronHost
                    | nodex_core_contracts::AdapterKind::Test
            ) || context.agent_attribution.is_some()
            {
                return Err(unauthorized(
                    "Automation execution admission belongs to the Host",
                ));
            }
            validate_id("run_id", &run_id)?;
            validate_id("lease_id", &lease_id)?;
            validate_id("dispatch_id", &dispatch_id)?;
            let valid=connection.query_row("SELECT EXISTS(SELECT 1 FROM automation_execution_runs run JOIN automation_execution_leases lease ON lease.dispatch_id=run.dispatch_id AND lease.automation_id=run.automation_id JOIN automation_decisions decision ON decision.dispatch_id=lease.dispatch_id JOIN automations automation ON automation.automation_id=run.automation_id JOIN members owner ON owner.id=automation.owner_member_id AND owner.lifecycle='active' JOIN members grant_owner ON grant_owner.id=json_extract(decision.frozen_authority_json,'$.owner_member_id') AND grant_owner.lifecycle='active' WHERE run.run_id=?1 AND lease.lease_id=?2 AND lease.dispatch_id=?3 AND run.status='IN_PROGRESS' AND lease.status='claimed' AND lease.expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) AND decision.status='admitted' AND decision.automation_id=run.automation_id AND lease.automation_revision=decision.automation_revision AND automation.status<>'DELETED' AND (decision.admitted_at_ms IS NOT NULL OR (decision.mode='run' AND automation.mode='run' AND automation.status='ACTIVE' AND automation.automation_revision=decision.automation_revision)) AND (run.page_id IS NULL OR EXISTS(SELECT 1 FROM blocks block WHERE block.id=run.page_id AND block.lifecycle='active')))",params![run_id,lease_id,dispatch_id],|r|r.get(0))?;
            Ok(AutomationReadValue::AutomationExecutionAdmission { valid })
        }
        AutomationRead::AutomationDecisions {
            automation_id,
            window,
        } => Ok(AutomationReadValue::AutomationDecisions {
            window: read_decisions(connection, library_id, commit_head, &automation_id, &window)?,
        }),
        AutomationRead::AutomationNotificationPolicy { message_id } => {
            validate_id("message_id", &message_id)?;
            let policy:Option<String>=connection.query_row("SELECT notification_policy FROM automation_execution_runs WHERE message_id=?1 ORDER BY created_at DESC,run_id LIMIT 1",[message_id],|r|r.get(0)).optional()?.flatten();
            Ok(AutomationReadValue::AutomationNotificationPolicy {
                policy: policy.map(|_| AutomationNotificationPolicy::FailedRunsOnly),
            })
        }
        AutomationRead::AgentAutomations {
            provenance,
            search_query,
            window,
        } => {
            super::agent_command::admit_read(connection, library_id, context, &provenance)?;
            Ok(AutomationReadValue::Automations {
                window: read_definition_window(
                    connection,
                    library_id,
                    commit_head,
                    DefinitionWindowQuery {
                        include_deleted: false,
                        project_id: None,
                        search_query: search_query.as_deref(),
                    },
                    &window,
                )?,
            })
        }
        AutomationRead::AgentAutomation {
            provenance,
            automation_id,
        } => {
            super::agent_command::admit_read(connection, library_id, context, &provenance)?;
            validate_id("automation_id", &automation_id)?;
            let item = read_definition(connection, &automation_id)?;
            Ok(AutomationReadValue::Automation {
                item: item.map(Box::new),
            })
        }
        AutomationRead::DueWork { lane } => Ok(AutomationReadValue::DueWork {
            plan: match lane {
                AutomationDueWorkLane::Automations => {
                    super::mutation::plan_definition_due_work(connection)?
                }
                AutomationDueWorkLane::Reminders => {
                    super::reminder::plan_due_work(connection, library_id)?
                }
            },
        }),
        AutomationRead::Automations {
            include_deleted,
            search_query,
            window,
        } => Ok(AutomationReadValue::Automations {
            window: read_definition_window(
                connection,
                library_id,
                commit_head,
                DefinitionWindowQuery {
                    include_deleted: include_deleted.unwrap_or(false),
                    project_id: None,
                    search_query: search_query.as_deref(),
                },
                &window,
            )?,
        }),
        AutomationRead::Automation { automation_id } => {
            validate_id("automation_id", &automation_id)?;
            Ok(AutomationReadValue::Automation {
                item: read_definition(connection, &automation_id)?.map(Box::new),
            })
        }
        AutomationRead::AutomationForExecution { automation_id } => {
            validate_id("automation_id", &automation_id)?;
            let item = read_definition(connection, &automation_id)?;
            if let Some(automation) = &item {
                super::clock::require_owner_available(connection, automation)?;
            }
            if let Some(definition) = &item
                && definition.kind == AutomationExecutionKind::Cron
            {
                super::mutation::validate_cron_project_target(
                    connection,
                    definition.project_id.as_deref(),
                    &definition.cwds,
                    definition.execution_environment,
                    definition.local_environment_config_path.as_deref(),
                )?;
            }
            Ok(AutomationReadValue::Automation {
                item: item.map(Box::new),
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
        AutomationRead::Run { run_id } => Ok(AutomationReadValue::Run {
            item: super::run::read_run(connection, &run_id)?.map(Box::new),
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

struct DefinitionWindowQuery<'a> {
    include_deleted: bool,
    project_id: Option<&'a str>,
    search_query: Option<&'a str>,
}

fn read_definition_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    query: DefinitionWindowQuery<'_>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<Automation>, StoreError> {
    let normalized = normalize_request(request)?;
    let search_query = query
        .search_query
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if search_query.is_some_and(|value| value.len() > 512) {
        return Err(invalid("Automation search query is too long"));
    }
    let fingerprint = cursor::query_fingerprint(&(
        "automation_definitions_v2",
        query.include_deleted,
        query.project_id,
        search_query,
    ))?;
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
        "SELECT automation_id, automation_revision, kind, status, target_session_id, name, \
                prompt, rrule, model, reasoning_effort, service_tier, cwds_json, \
                agent_backend_kind, agent_backend_definition_id, \
                agent_backend_instance_config_id, execution_environment, \
                local_environment_config_path, next_run_at, last_run_at, created_at, updated_at, notification_policy, \
                project_id, mode, runbook_page_id, owner_member_id, condition_text, timezone, jitter_salt, scope_project_id \
         FROM automations \
         WHERE (?1 OR status <> 'DELETED') \
           AND (?2 IS NULL OR created_at > ?2 OR (created_at = ?2 AND automation_id > ?3)) \
           AND (?5 IS NULL OR (kind = 'cron' AND project_id = ?5) \
                OR (kind = 'heartbeat' AND EXISTS (SELECT 1 FROM project_sessions s \
                    WHERE s.id = target_session_id AND s.project_id = ?5))) \
           AND (?6 IS NULL OR instr(lower(name), lower(?6)) > 0 \
                OR instr(lower(prompt), lower(?6)) > 0 \
                OR instr(lower(automation_id), lower(?6)) > 0) \
         ORDER BY created_at, automation_id LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![
                query.include_deleted,
                after.as_ref().map(|value| value.0),
                after.as_ref().map(|value| value.1.as_str()),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Automation definition window size is invalid"))?,
                query.project_id,
                search_query,
            ],
            definition_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Automation definition column types are invalid"))?
        .into_iter()
        .map(|item| enrich_definition(connection, item))
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
) -> Result<Option<Automation>, StoreError> {
    let definition = connection
        .query_row(
            "SELECT automation_id, automation_revision, kind, status, target_session_id, name, \
                    prompt, rrule, model, reasoning_effort, service_tier, cwds_json, \
                    agent_backend_kind, agent_backend_definition_id, \
                    agent_backend_instance_config_id, execution_environment, \
                    local_environment_config_path, next_run_at, last_run_at, created_at, updated_at, notification_policy, \
                project_id, mode, runbook_page_id, owner_member_id, condition_text, timezone, jitter_salt, scope_project_id \
             FROM automations WHERE automation_id = ?1",
            [automation_id],
            definition_from_row,
        )
        .optional()
        .map_err(|_| corrupt("Automation definition column types are invalid"))?;
    definition
        .map(|item| enrich_definition(connection, item))
        .transpose()
}

fn definition_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let kind = parse_kind(row.get::<_, String>(2)?).map_err(rusqlite_conversion)?;
    let status = parse_status(row.get::<_, String>(3)?).map_err(rusqlite_conversion)?;
    let environment = parse_environment(row.get::<_, String>(15)?).map_err(rusqlite_conversion)?;
    let cwds_json = row.get::<_, String>(11)?;
    let cwds = serde_json::from_str::<Vec<String>>(&cwds_json)
        .map_err(|_| rusqlite_conversion("Automation cwd JSON is invalid".to_owned()))?;
    Ok(Automation {
        scope: row.get::<_, Option<String>>(29)?.map_or(
            nodex_core_contracts::automation::AutomationScope::Space,
            |project_id| nodex_core_contracts::automation::AutomationScope::Project { project_id },
        ),
        owner_member_id: row.get(25)?,
        condition_text: row.get(26)?,
        typed_condition: Some(AutomationCondition::Clock {
            rrule: row.get(7)?,
            timezone: row.get(27)?,
            jitter_salt: row.get(28)?,
        }),
        automation_id: row.get(0)?,
        automation_revision: row.get(1)?,
        kind,
        status,
        project_id: row.get(22)?,
        target_session_id: row.get(4)?,
        notification_policy: match row.get::<_, Option<String>>(21)?.as_deref() {
            None => None,
            Some("failed_runs_only") => Some(AutomationNotificationPolicy::FailedRunsOnly),
            Some(_) => {
                return Err(rusqlite_conversion(
                    "Automation notification policy is invalid".into(),
                ));
            }
        },
        mode: match row.get::<_, String>(23)?.as_str() {
            "ask_first" => AutomationMode::AskFirst,
            "dry_run" => AutomationMode::DryRun,
            "run" => AutomationMode::Run,
            _ => {
                return Err(rusqlite_conversion("Invalid scheduled mode choice".into()));
            }
        },
        runbook_page_id: row.get(24)?,
        runbook_title: None,
        held_decision: None,
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

fn enrich_definition(
    connection: &Connection,
    mut item: Automation,
) -> Result<Automation, StoreError> {
    // The clock migration freezes retained Automations before the event tables exist.
    let has_events: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='automation_event_filters')",
        [],
        |r| r.get(0),
    )?;
    let filter: Option<String> = if has_events {
        connection
            .query_row(
                "SELECT filter_json FROM automation_event_filters WHERE automation_id=?1",
                [&item.automation_id],
                |r| r.get(0),
            )
            .optional()?
    } else {
        None
    };
    if let Some(filter) = filter {
        item.typed_condition = Some(AutomationCondition::Source {
            filters: serde_json::from_str(&filter)
                .map_err(|_| corrupt("Invalid Automation Source filter"))?,
        });
    }
    item.held_decision = super::firing::held(connection, &item.automation_id)?;
    item.runbook_title = connection.query_row(
        "SELECT COALESCE(materialization.title,'') FROM pages page \
         JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active' \
         LEFT JOIN document_materializations materialization ON materialization.document_id=page.document_id \
         WHERE page.block_id=?1", [item.runbook_page_id.as_deref()], |row| row.get(0),
    ).optional()?;
    validate_definition(item)
}

fn validate_definition(definition: Automation) -> Result<Automation, StoreError> {
    validate_id("stored automation_id", &definition.automation_id)
        .map_err(|_| corrupt("Stored Automation id is invalid"))?;
    if definition.automation_revision < 1
        || definition.name.trim().is_empty()
        || definition.created_at_ms < 0
        || definition.updated_at_ms < definition.created_at_ms
        || definition.next_run_at_ms.is_some_and(|value| value < 0)
        || definition.last_run_at_ms.is_some_and(|value| value < 0)
    {
        return Err(corrupt("Stored Automation definition is invalid"));
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
            let message = format!("Stored Automation {label} is invalid");
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
                expires_at_ms, settled_at_ms, retry_at_ms, reason_code, dispatch_id, automation_revision, purpose \
         FROM automation_execution_leases \
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
        .map(|item| enrich_lease(connection, item))
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
                    expires_at_ms, settled_at_ms, retry_at_ms, reason_code, dispatch_id, automation_revision, purpose \
             FROM automation_execution_leases WHERE lease_id = ?1",
            [lease_id],
            lease_from_row,
        )
        .optional()
        .map_err(|_| corrupt("Automation lease column types are invalid"))?
        .map(|item| enrich_lease(connection, item))
        .transpose()
}

fn lease_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationLease> {
    let attempt = row.get::<_, i64>(3)?;
    let attempt = u32::try_from(attempt)
        .map_err(|_| rusqlite_conversion("Automation lease attempt is invalid".to_owned()))?;
    Ok(AutomationLease {
        execution_automation: None,
        lease_id: row.get(0)?,
        dispatch_id: row.get(10)?,
        automation_revision: row.get(11)?,
        automation_id: row.get(1)?,
        scheduled_for_ms: row.get(2)?,
        attempt,
        status: parse_lease_status(row.get::<_, String>(4)?).map_err(rusqlite_conversion)?,
        claimed_at_ms: row.get(5)?,
        expires_at_ms: row.get(6)?,
        settled_at_ms: row.get(7)?,
        retry_at_ms: row.get(8)?,
        reason_code: row.get(9)?,
        purpose: match row.get::<_, String>(12)?.as_str() {
            "hold" => AutomationLeasePurpose::Hold,
            "run" => AutomationLeasePurpose::Run,
            _ => {
                return Err(rusqlite_conversion(
                    "Invalid scheduled lease purpose".into(),
                ));
            }
        },
        admission: None,
    })
}

fn enrich_lease(
    connection: &Connection,
    mut lease: AutomationLease,
) -> Result<AutomationLease, StoreError> {
    if lease.purpose == AutomationLeasePurpose::Run {
        lease.admission = super::firing::admission(connection, &lease.dispatch_id)?;
    }
    lease.execution_automation =
        super::clock::execution_automation(connection, &lease.dispatch_id)?;
    validate_lease(lease)
}

fn validate_lease(lease: AutomationLease) -> Result<AutomationLease, StoreError> {
    validate_id("stored Automation dispatch id", &lease.dispatch_id)
        .map_err(|_| corrupt("Stored Automation dispatch id is invalid"))?;
    if lease.lease_id.is_empty()
        || lease.lease_id.len() > MAX_ID_LENGTH
        || lease.automation_id.is_empty()
        || lease.automation_id.len() > MAX_ID_LENGTH
        || lease.scheduled_for_ms < 0
        || lease.attempt == 0
        || lease.automation_revision < 1
        || lease.claimed_at_ms < 0
        || lease.expires_at_ms <= lease.claimed_at_ms
    {
        return Err(corrupt("Stored Automation lease is invalid"));
    }
    Ok(lease)
}

pub(super) fn kind_string(value: AutomationExecutionKind) -> &'static str {
    match value {
        AutomationExecutionKind::Cron => "cron",
        AutomationExecutionKind::Heartbeat => "heartbeat",
    }
}

pub(super) fn status_string(value: AutomationStatus) -> &'static str {
    match value {
        AutomationStatus::Active => "ACTIVE",
        AutomationStatus::Paused => "PAUSED",
        AutomationStatus::Deleted => "DELETED",
    }
}

pub(super) fn environment_string(value: AutomationExecutionEnvironment) -> &'static str {
    match value {
        AutomationExecutionEnvironment::Local => "local",
        AutomationExecutionEnvironment::Worktree => "worktree",
    }
}

fn parse_kind(value: String) -> Result<AutomationExecutionKind, String> {
    match value.as_str() {
        "cron" => Ok(AutomationExecutionKind::Cron),
        "heartbeat" => Ok(AutomationExecutionKind::Heartbeat),
        _ => Err("Automation kind is invalid".to_owned()),
    }
}

fn parse_status(value: String) -> Result<AutomationStatus, String> {
    match value.as_str() {
        "ACTIVE" => Ok(AutomationStatus::Active),
        "PAUSED" => Ok(AutomationStatus::Paused),
        "DELETED" => Ok(AutomationStatus::Deleted),
        _ => Err("Automation status is invalid".to_owned()),
    }
}

fn parse_environment(value: String) -> Result<AutomationExecutionEnvironment, String> {
    match value.as_str() {
        "local" => Ok(AutomationExecutionEnvironment::Local),
        "worktree" => Ok(AutomationExecutionEnvironment::Worktree),
        _ => Err("Automation execution environment is invalid".to_owned()),
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

fn read_decisions(
    connection: &Connection,
    library: &str,
    head: i64,
    automation: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<AutomationDecision>, StoreError> {
    validate_id("automation_id", automation)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("automation_decisions", automation))?;
    let subject = CollectionCursorSubject {
        kind: "automation_decisions",
        library_id: library,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward {
                return Err(invalid("Automation decision cursor direction is invalid"));
            }
            let [KeysetValue::Integer { value }] = coordinate.values.as_slice() else {
                return Err(invalid("Automation decision cursor is invalid"));
            };
            Ok((*value, coordinate.stable_id))
        })
        .transpose()?;
    let rows=connection.prepare("SELECT dispatch_id,automation_id,automation_revision,reason,mode,status,frozen_action_json,frozen_authority_json,page_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,created_at_ms,updated_at_ms,admitted_at_ms FROM automation_decisions WHERE automation_id=?1 AND (?2 IS NULL OR created_at_ms<?2 OR (created_at_ms=?2 AND dispatch_id>?3)) ORDER BY created_at_ms DESC,dispatch_id LIMIT ?4")?.query_map(params![automation,after.as_ref().map(|a|a.0),after.as_ref().map(|a|a.1.as_str()),i64::try_from(normalized.first+1).map_err(|_|invalid("Automation decision window size is invalid"))?],|r| {
        let dispatch_id:String=r.get(0)?;
        Ok((AutomationDecision {
            decision_id:dispatch_id.clone(),dispatch_id,automation_id:r.get(1)?,automation_revision:r.get(2)?,reason:r.get(3)?,
            mode:serde_json::from_value(serde_json::Value::String(r.get(4)?)).map_err(|_|rusqlite_conversion("Automation decision mode is invalid".into()))?,
            status:serde_json::from_value(serde_json::Value::String(r.get(5)?)).map_err(|_|rusqlite_conversion("Automation decision state is invalid".into()))?,
            frozen_action:serde_json::from_str(&r.get::<_,String>(6)?).map_err(|_|rusqlite_conversion("Automation action snapshot is invalid".into()))?,
            frozen_authority:serde_json::from_str(&r.get::<_,String>(7)?).map_err(|_|rusqlite_conversion("Automation authority snapshot is invalid".into()))?,
            page_id:r.get(8)?,proposal_id:None,trigger_ids:vec![],inputs:serde_json::json!({}),occurred_at_ms:r.get(9)?,session_id:None,
            first_scheduled_for_ms:r.get(9)?,last_scheduled_for_ms:r.get(10)?,missed_count:r.get(11)?,created_at_ms:r.get(12)?,updated_at_ms:r.get(13)?,
        }, r.get::<_,Option<i64>>(14)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    for (mut item, admitted_at_ms) in rows {
        let manual = admitted_at_ms.is_some() && item.page_id.is_none();
        if item.page_id.is_none() {
            item.page_id=connection.query_row("SELECT page_id FROM automation_execution_runs WHERE dispatch_id=?1 AND page_id IS NOT NULL ORDER BY created_at,run_id LIMIT 1",[&item.dispatch_id],|r|r.get(0)).optional()?.flatten();
        }
        item.trigger_ids=connection.prepare("SELECT trigger_id FROM automation_decision_triggers WHERE dispatch_id=?1 ORDER BY trigger_id")?.query_map([&item.dispatch_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let occurrences = connection.prepare("SELECT trigger.id,trigger.schedule_revision,trigger.due_at_ms FROM automation_clock_triggers trigger JOIN automation_decision_triggers link ON link.trigger_id=trigger.id WHERE link.dispatch_id=?1 ORDER BY trigger.due_at_ms,trigger.id")?.query_map([&item.dispatch_id], |row| Ok(serde_json::json!({"trigger_id":row.get::<_,String>(0)?,"schedule_revision":row.get::<_,i64>(1)?,"due_at_ms":row.get::<_,i64>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        item.inputs = serde_json::json!({"clock_occurrences":occurrences});
        if manual && item.trigger_ids.is_empty() {
            item.inputs["manual_requested_at_ms"] = admitted_at_ms.into();
        } else if !item.trigger_ids.is_empty() {
            item.inputs["coalesced_clock"] = serde_json::json!({"first_due_at_ms":item.first_scheduled_for_ms,"last_due_at_ms":item.last_scheduled_for_ms,"missed_count":item.missed_count});
        }
        let assessment: Option<String> = connection.query_row(
            "SELECT assessment_json FROM automation_decisions WHERE dispatch_id=?1",
            [&item.dispatch_id],
            |r| r.get(0),
        )?;
        if let Some(assessment) = assessment {
            item.inputs = serde_json::from_str(&assessment)
                .map_err(|_| corrupt("Invalid assessment decision"))?;
            item.trigger_ids = connection.prepare("SELECT trigger_id FROM automation_decision_source_triggers WHERE dispatch_id=?1 ORDER BY trigger_id")?.query_map([&item.dispatch_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        }
        item.proposal_id = connection
            .query_row(
                "SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1",
                [&item.page_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        item.session_id=connection.query_row("SELECT session_id FROM automation_execution_runs WHERE dispatch_id=?1 AND session_id IS NOT NULL ORDER BY created_at DESC,run_id LIMIT 1",[&item.dispatch_id],|r|r.get(0)).optional()?.flatten();
        candidates.push(WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Integer {
                    value: item.created_at_ms,
                }],
                stable_id: item.dispatch_id.clone(),
            },
            item,
        });
    }
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: head,
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
