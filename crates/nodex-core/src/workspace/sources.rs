//! External facts commit with their read position. Network and credential material never enter Core.
use super::{
    ProjectWorkspaceApplyOutcome,
    mutation::run_mutation,
    session_mutation::{sqlite_now, validate_id},
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, sources::*};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
fn decode<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid Source value"))
}
fn bounded(count: u32) -> Result<u32, StoreError> {
    if !(1..=100).contains(&count) {
        return Err(invalid("Source windows require a limit from 1 to 100"));
    }
    Ok(count)
}
fn now_ms(connection: &Connection) -> Result<i64, StoreError> {
    Ok(connection.query_row(
        "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
        [],
        |r| r.get(0),
    )?)
}
pub(super) fn source(
    connection: &Connection,
    library: &str,
    id: &str,
) -> Result<Option<Source>, StoreError> {
    Ok(connection.query_row("SELECT id,library_id,kind,revision,enabled,enabled_at_ms,config_json FROM sources WHERE id=?1 AND library_id=?2",params![id,library],|r|Ok(Source {id:r.get(0)?,library_id:r.get(1)?,kind:r.get(2)?,revision:r.get(3)?,enabled:r.get(4)?,enabled_at_ms:r.get(5)?,config:decode(r.get(6)?)?})).optional()?)
}
fn position_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SourcePosition> {
    Ok(SourcePosition {
        source_id: r.get(0)?,
        partition: r.get(1)?,
        revision: r.get(2)?,
        baseline: r.get(3)?,
        cursor: decode(r.get(4)?)?,
        lease_token: r.get(5)?,
        lease_expires_at_ms: r.get(6)?,
        next_poll_at_ms: r.get(7)?,
        last_success_at_ms: r.get(8)?,
        consecutive_failures: r.get(9)?,
    })
}
fn position(
    connection: &Connection,
    source: &str,
    partition: &str,
) -> Result<Option<SourcePosition>, StoreError> {
    Ok(connection.query_row("SELECT source_id,partition,revision,baseline,cursor_json,lease_token,lease_expires_at_ms,next_poll_at_ms,last_success_at_ms,consecutive_failures FROM source_positions WHERE source_id=?1 AND partition=?2",params![source,partition],position_row).optional()?)
}
pub(super) fn read(
    connection: &Connection,
    library: &str,
    read: SourceRead,
) -> Result<SourceReadValue, StoreError> {
    match read {
        SourceRead::EventAutomationWatching {
            source_id,
            repository,
        } => {
            require_source(connection, library, &source_id)?;
            let filters=connection.prepare("SELECT f.filter_json FROM automation_event_filters f JOIN automations r ON r.automation_id=f.automation_id JOIN members m ON m.id=r.owner_member_id WHERE m.library_id=?1 AND m.lifecycle='active' AND r.status='ACTIVE' LIMIT 200")?.query_map([library],|r|decode::<nodex_core_contracts::automation::AutomationSourceFilter>(r.get(0)?))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::EventAutomationWatching {
                enabled: filters.iter().any(|f| {
                    f.source_id.as_ref().is_none_or(|id| id == &source_id)
                        && (f.repositories.is_empty()
                            || f.repositories
                                .iter()
                                .any(|r| r.eq_ignore_ascii_case(&repository)))
                }),
            })
        }

        SourceRead::ChannelOutbox {
            include_terminal,
            after_id,
            limit,
        } => Ok(SourceReadValue::ChannelOutbox {
            items: super::channels::items(
                connection,
                library,
                include_terminal,
                after_id.as_deref(),
                limit,
            )?,
        }),
        SourceRead::PageFollows {
            page_id,
            after_thread_id,
            limit,
        } => Ok(SourceReadValue::PageFollows {
            follows: super::thread_follows::follows(
                connection,
                library,
                &page_id,
                after_thread_id.as_deref(),
                limit,
            )?,
        }),
        SourceRead::Deliveries {
            page_id,
            state,
            after_id,
            limit,
        } => Ok(SourceReadValue::Deliveries {
            deliveries: super::thread_follows::deliveries(
                connection,
                library,
                page_id.as_deref(),
                state.as_deref(),
                after_id.as_deref(),
                limit,
            )?,
        }),
        SourceRead::DeliveryBatches {
            after_message_id,
            limit,
        } => Ok(SourceReadValue::DeliveryBatches {
            batches: super::thread_follows::batches(
                connection,
                library,
                after_message_id.as_deref(),
                limit,
            )?,
        }),
        SourceRead::Sources { after_id, limit } => {
            let ids = connection.prepare("SELECT id FROM sources WHERE library_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3")?.query_map(params![library,after_id,bounded(limit)?],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::Sources {
                sources: ids
                    .iter()
                    .map(|id| {
                        source(connection, library, id)
                            .and_then(|s| s.ok_or_else(|| invalid("Source disappeared")))
                    })
                    .collect::<Result<_, _>>()?,
            })
        }
        SourceRead::Positions {
            source_id,
            after_partition,
            limit,
        } => {
            require_source(connection, library, &source_id)?;
            let positions=connection.prepare("SELECT source_id,partition,revision,baseline,cursor_json,lease_token,lease_expires_at_ms,next_poll_at_ms,last_success_at_ms,consecutive_failures FROM source_positions WHERE source_id=?1 AND (?2 IS NULL OR partition>?2) ORDER BY partition LIMIT ?3")?.query_map(params![source_id,after_partition,bounded(limit)?],position_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::Positions { positions })
        }
        SourceRead::Threads {
            host,
            repository_id,
            after_id,
            limit,
        } => {
            let threads=connection.prepare("SELECT thread_json FROM external_threads WHERE library_id=?1 AND host=?2 AND repository_id=?3 AND (?4 IS NULL OR id>?4) ORDER BY id LIMIT ?5")?.query_map(params![library,host,repository_id,after_id,bounded(limit)?],|r|decode(r.get(0)?))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::Threads { threads })
        }
        SourceRead::Triggers {
            thread_url,
            before_id,
            limit,
        } => {
            let triggers=connection.prepare("SELECT t.id,t.source_id,t.received_at_ms,t.disposition,t.event_json FROM source_triggers t JOIN trigger_threads link ON link.trigger_id=t.id JOIN external_threads thread ON thread.id=link.thread_id WHERE t.library_id=?1 AND json_extract(thread.thread_json,'$.url')=?2 AND (?3 IS NULL OR t.id<?3) ORDER BY t.id DESC LIMIT ?4")?.query_map(params![library,thread_url,before_id,bounded(limit)?],|r|Ok(SourceTrigger {id:r.get(0)?,source_id:r.get(1)?,received_at_ms:r.get(2)?,disposition:r.get(3)?,event:decode(r.get(4)?)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::Triggers { triggers })
        }
        SourceRead::OpenProblems {
            source_id,
            after_id,
            limit,
        } => {
            let problems = super::problems::open(
                connection,
                library,
                source_id.as_deref(),
                after_id.as_deref(),
                limit,
            )?;
            Ok(SourceReadValue::OpenProblems { problems })
        }
        SourceRead::KnownPullRequests {
            after_page_id,
            limit,
        } => {
            let pull_requests=connection.prepare("SELECT pr.page_id,pr.workspace_id,pr.repository,pr.number,pr.url,pr.state,pr.observed_at FROM page_pull_requests pr JOIN blocks b ON b.id=pr.page_id WHERE b.library_id=?1 AND (?2 IS NULL OR pr.page_id>?2) ORDER BY pr.page_id LIMIT ?3")?.query_map(params![library,after_page_id,bounded(limit)?],|r|Ok(nodex_core_contracts::workspace::PagePullRequest {page_id:r.get(0)?,workspace_id:r.get(1)?,repository:r.get(2)?,number:r.get(3)?,url:r.get(4)?,state:r.get(5)?,observed_at:r.get(6)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(SourceReadValue::KnownPullRequests { pull_requests })
        }
    }
}
fn require_source(connection: &Connection, library: &str, id: &str) -> Result<Source, StoreError> {
    source(connection, library, id)?
        .ok_or_else(|| invalid("Source is outside this Library or absent"))
}
fn require_current(
    connection: &Connection,
    library: &str,
    id: &str,
    revision: i64,
) -> Result<Source, StoreError> {
    let source = require_source(connection, library, id)?;
    if !source.enabled || source.revision != revision {
        return Err(conflict("Source changed or is disabled"));
    }
    Ok(source)
}
fn require_lease(
    connection: &Connection,
    id: &str,
    partition: &str,
    token: &str,
    now: i64,
) -> Result<SourcePosition, StoreError> {
    let value = position(connection, id, partition)?
        .ok_or_else(|| conflict("Source partition has no lease"))?;
    if value.lease_token.as_deref() != Some(token)
        || value.lease_expires_at_ms.is_none_or(|until| until <= now)
    {
        return Err(conflict("Source partition lease expired or changed"));
    }
    Ok(value)
}
fn validate_config(config: &GitHubSourceConfig) -> Result<(), StoreError> {
    if config.host.is_empty()
        || config.host.len() > 253
        || !config
            .host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        || config.host != config.host.to_lowercase()
    {
        return Err(invalid("Invalid GitHub host"));
    }
    if config.account_login.is_empty()
        || config.account_login.len() > 100
        || !config
            .account_login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || config.account_id.parse::<u64>().is_err()
        || config.credential_ref != format!("gh:{}:{}", config.host, config.account_login)
    {
        return Err(invalid(
            "A Source requires a verified GitHub account and CLI credential reference",
        ));
    }
    if config.repositories.len() > 200 {
        return Err(invalid("A Source supports at most 200 repositories"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for repo in &config.repositories {
        let parts = repo.name.split('/').collect::<Vec<_>>();
        if repo.id.parse::<u64>().is_err()
            || !ids.insert(&repo.id)
            || parts.len() != 2
            || parts.iter().any(|p| {
                p.is_empty()
                    || !p
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            })
        {
            return Err(invalid("Invalid watched repository"));
        }
    }
    Ok(())
}
fn record_failure(
    connection: &Connection,
    id: &str,
    scope: &str,
    kind: &str,
    evidence: &serde_json::Value,
    now: i64,
    count: i64,
) -> Result<(), StoreError> {
    if json(evidence)?.len() > 65536 || kind.len() > 100 {
        return Err(invalid("Source problem evidence exceeds its bound"));
    }
    let library: String =
        connection.query_row("SELECT library_id FROM sources WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    let _ = (now, count);
    let credential = matches!(kind, "credential" | "account_changed");
    super::problems::fail(
        connection,
        super::problems::Failure {
            library: &library,
            source: Some(id),
            page: None,
            scope: &format!("{id}:{scope}"),
            kind: if credential {
                "credential_invalid"
            } else {
                "source_failing"
            },
            summary: if credential {
                "Reconnect GitHub"
            } else if kind == "malformed_item" {
                "GitHub returned an unreadable update"
            } else {
                "GitHub could not be checked"
            },
            fix: "reconnect",
            evidence: evidence.clone(),
            immediate: credential || kind == "malformed_item",
        },
    )
}
fn success(connection: &Connection, id: &str, scope: &str, _now: i64) -> Result<(), StoreError> {
    let library: String =
        connection.query_row("SELECT library_id FROM sources WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    super::problems::resolve(connection, &library, &format!("{id}:{scope}"))
}
#[allow(clippy::too_many_arguments)]
/// Check the current person and Host before receipt replay or Source writes.
pub(super) fn authorize(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    command: &SourceCommand,
) -> Result<(), StoreError> {
    if matches!(command, SourceCommand::RetryProblem { .. })
        && matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::RemoteMember | AdapterKind::Test
        )
        && context.agent_attribution.is_none()
    {
        return Ok(());
    }
    if matches!(
        command,
        SourceCommand::FollowThread { .. } | SourceCommand::ReplyToOrigin { .. }
    ) || !matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) || context.agent_attribution.is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Sources are configured by a person and polled by the Desktop Host",
            false,
        ));
    }
    if !matches!(command, SourceCommand::ConfigureSource { .. }) {
        return Ok(());
    }
    let owner: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_profile_members local JOIN members member ON member.id=local.member_id AND member.library_id=local.library_id WHERE local.profile_id=?1 AND local.library_id=?2 AND member.role='owner' AND member.lifecycle='active')",
        params![context.profile_id.0, library],
        |row| row.get(0),
    )?;
    if !owner {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Source configuration requires the local Owner",
            false,
        ));
    }
    Ok(())
}

/// The receipt identity of one Source command: the Store epoch, operation and request hash it replays under.
pub(super) struct SourceReceiptIdentity<'a> {
    pub(super) epoch: &'a str,
    pub(super) operation: &'a str,
    pub(super) hash: &'a str,
}

pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    source_receipt_identity: SourceReceiptIdentity<'_>,
    command: &SourceCommand,
    provenance: Option<&nodex_core_contracts::agent::AgentTurnProvenance>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let SourceReceiptIdentity {
        epoch,
        operation,
        hash,
    } = source_receipt_identity;
    if matches!(
        command,
        SourceCommand::FollowThread { .. } | SourceCommand::ReplyToOrigin { .. }
    ) {
        if provenance.is_none()
            || !matches!(
                context.adapter,
                AdapterKind::ElectronHost | AdapterKind::Test
            )
            || context.agent_attribution.is_some()
        {
            return Err(invalid(
                "Only a verified managed-chat tool may follow a thread",
            ));
        }
    } else {
        authorize(connection, context, library, command)?;
    }
    let now = now_ms(connection)?;
    if json(command)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("Source batch exceeds 4 MiB"));
    }
    let at = sqlite_now(connection)?;
    run_mutation(connection, context, epoch, operation, hash, &at, |scope| {
        let mut effects = super::inbox::simple_effects("inbox_source", &at);
        match command {
            SourceCommand::ReplyToOrigin { page_id, body } => {
                super::channels::enqueue(connection, library, page_id, body, provenance)?
            }
            SourceCommand::ClaimChannelSend {
                id,
                lease_token,
                lease_duration_ms,
            } => super::channels::claim(connection, library, id, lease_token, *lease_duration_ms)?,
            SourceCommand::SettleChannelSend {
                id,
                lease_token,
                receipt,
                failure,
                permanent,
                credential_invalid,
            } => super::channels::settle(
                connection,
                library,
                id,
                lease_token,
                super::channels::DeliveryOutcome {
                    receipt: receipt.as_ref(),
                    failure: failure.as_deref(),
                    permanent: *permanent,
                    credential: *credential_invalid,
                },
            )?,
            SourceCommand::RecordThreadDeliveryFailure { message_id, reason } => {
                super::problems::delivery_failure(connection, library, message_id, reason)?
            }
            SourceCommand::RetryProblem { problem_id } => {
                super::problems::retry(connection, library, problem_id)?
            }
            SourceCommand::FollowThread {
                source_id,
                config_revision,
                thread,
            } => {
                let source = require_current(connection, library, source_id, *config_revision)?;
                let partition = format!("repo:{}", thread.repository_id);
                validate_partition(&source, &partition)?;
                let page = super::thread_follows::managed_page(
                    connection,
                    library,
                    provenance.ok_or_else(|| invalid("Managed-chat authority required"))?,
                )?;
                upsert_thread(connection, library, &source, &partition, thread)?;
                super::thread_follows::add_follow(
                    connection,
                    library,
                    &page,
                    thread,
                    "context",
                    "managed_chat_verified_url",
                    &at,
                )?;
                effects.page_ids.push(page);
                super::automation_assessment::flush_followed(
                    connection,
                    library,
                    context,
                    operation,
                    &thread.id,
                    &at,
                    &mut effects,
                )?;
            }
            SourceCommand::PrepareThreadDeliveryBatch {
                message_id,
                delivery_ids,
                body,
            } => {
                validate_id("message_id", message_id)?;
                super::thread_follows::prepare_batch(
                    connection,
                    library,
                    delivery_ids,
                    message_id,
                    body,
                    now,
                    &at,
                )?;
            }
            SourceCommand::BeginThreadDeliveryBatch { message_id } => {
                super::thread_follows::begin_batch(connection, library, message_id)?;
            }
            SourceCommand::SettleThreadDeliveryBatch {
                message_id,
                accepted,
                receipt,
            } => {
                if receipt.is_empty() || receipt.len() > 2000 {
                    return Err(invalid("A delivery requires a bounded admission receipt"));
                }
                let state = if *accepted { "accepted" } else { "rejected" };
                connection.execute("UPDATE thread_delivery_batches SET state=?3,receipt=?4 WHERE message_id=?1 AND library_id=?2 AND state='pending'",params![message_id,library,state,receipt])?;
                connection.execute("UPDATE thread_delivery_batches SET settled_at_ms=?3 WHERE message_id=?1 AND library_id=?2",params![message_id,library,now])?;
                if *accepted {
                    super::problems::resolve(connection, library, message_id)?;
                }
                connection.execute("UPDATE thread_deliveries SET state=?3,reason=(SELECT receipt FROM thread_delivery_batches WHERE message_id=?1) WHERE message_id=?1 AND EXISTS(SELECT 1 FROM thread_delivery_batches b WHERE b.message_id=?1 AND b.library_id=?2 AND b.state=?3)",params![message_id,library,state])?;
            }
            SourceCommand::InvalidateThreadDelivery {
                delivery_id,
                reason,
            } => {
                if reason.is_empty() || reason.len() > 2000 {
                    return Err(invalid("A delivery requires a bounded unresolved reason"));
                }
                connection.execute("UPDATE thread_deliveries SET state='unresolved',reason=?3 WHERE id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM source_triggers t WHERE t.id=thread_deliveries.trigger_id AND t.library_id=?2)",params![delivery_id,library,reason])?;
            }
            SourceCommand::ConfigureSource {
                source_id,
                expected_revision,
                enabled,
                config,
            } => {
                validate_id("source_id", source_id)?;
                validate_config(config)?;
                let current = source(connection, library, source_id)?;
                if current.as_ref().map_or(0, |s| s.revision) != *expected_revision {
                    return Err(conflict("Source configuration changed"));
                }
                if current.as_ref().is_some_and(|s| {
                    s.config.host != config.host || s.config.account_id != config.account_id
                }) {
                    return Err(invalid("A different GitHub account requires a new Source"));
                }
                let boundary = current
                    .and_then(|s| s.enabled_at_ms)
                    .or((*enabled).then_some(now));
                connection.execute("INSERT INTO sources(id,library_id,kind,revision,enabled,enabled_at_ms,config_json) VALUES(?1,?2,'github',1,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=sources.revision+1,enabled=excluded.enabled,enabled_at_ms=excluded.enabled_at_ms,config_json=excluded.config_json",params![source_id,library,enabled,boundary,json(config)?])?;
                connection.execute("UPDATE source_positions SET lease_token=NULL,lease_expires_at_ms=NULL WHERE source_id=?1",[source_id])?;
                if *enabled {
                    // A verified reconnection re-arms credential failures at the original frozen address.
                    connection.execute("UPDATE channel_outbox SET state='pending',consecutive_failures=0,retry_at_ms=0 WHERE source_id=?1 AND state='failed' AND json_extract(source_json,'$.config.account_id')=?2 AND EXISTS(SELECT 1 FROM problems p WHERE p.scope=channel_outbox.id AND p.kind='credential_invalid' AND p.resolved_at_ms IS NULL)",params![source_id,config.account_id])?;
                    let cursor = SourceCursor {
                        baseline_at_ms: now,
                        watermark_ms: now,
                        ..Default::default()
                    };
                    for repo in config.repositories.iter().filter(|repo| repo.enabled) {
                        connection.execute("INSERT OR IGNORE INTO source_positions(source_id,partition,cursor_json) VALUES(?1,?2,?3)",params![source_id,format!("repo:{}",repo.id),json(&cursor)?])?;
                    }
                }
                let pages=connection.prepare("SELECT pr.page_id FROM page_pull_requests pr JOIN blocks b ON b.id=pr.page_id WHERE b.library_id=?1")?.query_map([library],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for page in pages {
                    super::thread_follows::follow_linked_pr(connection, library, &page, &at)?;
                    effects.page_ids.push(page);
                }
            }
            SourceCommand::ClaimSourcePartition {
                source_id,
                config_revision,
                partition,
                lease_token,
                lease_duration_ms,
            } => {
                let source = require_current(connection, library, source_id, *config_revision)?;
                validate_partition(&source, partition)?;
                validate_id("lease_token", lease_token)?;
                if !(1000..=120000).contains(lease_duration_ms) {
                    return Err(invalid("Source leases last 1–120 seconds"));
                }
                let current = position(connection, source_id, partition)?;
                if current.as_ref().is_some_and(|p| {
                    p.lease_expires_at_ms.is_some_and(|end| end > now)
                        && p.lease_token.as_deref() != Some(lease_token)
                }) {
                    return Err(conflict("Source partition is already leased"));
                }
                let cursor = SourceCursor {
                    baseline_at_ms: now,
                    watermark_ms: now,
                    ..Default::default()
                };
                connection.execute("INSERT INTO source_positions(source_id,partition,cursor_json,lease_token,lease_expires_at_ms) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source_id,partition) DO UPDATE SET lease_token=excluded.lease_token,lease_expires_at_ms=excluded.lease_expires_at_ms",params![source_id,partition,json(&cursor)?,lease_token,now+lease_duration_ms])?;
            }
            SourceCommand::IngestSourceBatch {
                source_id,
                config_revision,
                partition,
                expected_position,
                lease_token,
                threads,
                triggers,
                next_position,
                next_poll_at_ms,
                quarantine,
            } => {
                let source = require_current(connection, library, source_id, *config_revision)?;
                validate_partition(&source, partition)?;
                let previous = require_lease(connection, source_id, partition, lease_token, now)?;
                if previous.revision != *expected_position
                    || next_position.baseline_at_ms != previous.cursor.baseline_at_ms
                    || next_position.watermark_ms < previous.cursor.watermark_ms
                    || next_position.watermark_ms > now + 60000
                {
                    return Err(conflict("Source read position changed or moved backwards"));
                }
                if threads.len() > 1000 || triggers.len() > 2000 || quarantine.len() > 100 {
                    return Err(invalid("Source batch exceeds its item bound"));
                }
                for thread in threads {
                    upsert_thread(connection, library, &source, partition, thread)?;
                }
                let mut candidates = threads.iter().collect::<Vec<_>>();
                candidates.sort_by_key(|thread| (thread.state == "open", thread.number));
                for thread in candidates {
                    effects
                        .page_ids
                        .extend(super::thread_follows::discover_own_pr(
                            connection, library, thread, &at,
                        )?);
                }
                let linked=connection.prepare("SELECT page_id FROM page_pull_requests WHERE url IN (SELECT json_extract(thread_json,'$.url') FROM external_threads WHERE library_id=?1)")?.query_map([library],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for page in linked {
                    super::thread_follows::follow_linked_pr(connection, library, &page, &at)?;
                }
                let mut ordered = triggers.iter().collect::<Vec<_>>();
                ordered.sort_by_key(|event| {
                    (
                        event.occurred_at_ms,
                        if event.kind == "merged" {
                            2
                        } else if event.kind == "closed" {
                            1
                        } else {
                            0
                        },
                        &event.semantic_key,
                    )
                });
                for event in ordered {
                    validate_event(connection, library, &source, partition, event)?;
                    if event.occurred_at_ms < previous.cursor.baseline_at_ms {
                        continue;
                    }
                    if super::channels::emitted(connection, library, event)? {
                        continue;
                    }
                    let id = crate::domain::identity::random_uuid_v7()
                        .map_err(|_| invalid("Source identity entropy is unavailable"))?;
                    let has_follow:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM page_thread_follows f JOIN blocks b ON b.id=f.page_id WHERE f.external_thread_id=?1 AND b.library_id=?2)",params![event.thread_id,library],|r|r.get(0))?;
                    let discovery = match event.kind.as_str() {
                        "discovery_assigned" => source.config.discovery.assigned,
                        "discovery_review_requests" => source.config.discovery.review_requests,
                        "discovery_mentions" => source.config.discovery.mentions,
                        _ => false,
                    };
                    let disposition = if has_follow {
                        "followed"
                    } else if discovery && event.actor_class == SourceActorClass::Person {
                        "intake"
                    } else {
                        "recorded"
                    };
                    let inserted=connection.execute("INSERT INTO source_triggers(id,source_id,library_id,provider,semantic_key,received_at_ms,disposition,event_json) VALUES(?1,?2,?3,'github',?4,?5,?7,?6) ON CONFLICT(library_id,provider,semantic_key) DO NOTHING",params![id,source_id,library,event.semantic_key,now,json(event)?,disposition])?;
                    if inserted > 0 {
                        connection.execute("INSERT INTO trigger_threads(trigger_id,thread_id,role) VALUES(?1,?2,'primary')",params![id,event.thread_id])?;
                        let followed = super::thread_follows::ingest(
                            connection,
                            library,
                            context,
                            operation,
                            &id,
                            event,
                            &at,
                            &mut effects,
                        )?;
                        let assessed = if !followed {
                            super::automation_assessment::enqueue(
                                connection, library, &id, source_id, event,
                            )?
                        } else {
                            false
                        };
                        if assessed {
                            effects.operation_kind = "inbox_automation_assessment";
                        }
                        if !followed
                            && !assessed
                            && discovery
                            && event.actor_class == SourceActorClass::Person
                        {
                            let captured = super::inbox::github::ingest(
                                connection, library, context, epoch, operation, scope, &id, event,
                                &at,
                            )?;
                            effects.absorb_workspace(captured);
                            effects.operation_kind = "inbox_source_ingest";
                        }
                    }
                }
                for evidence in quarantine {
                    let key = crate::document::sha256(json(evidence)?.as_bytes());
                    record_failure(
                        connection,
                        source_id,
                        &format!("quarantine:{partition}:{key}"),
                        "malformed_item",
                        evidence,
                        now,
                        1,
                    )?;
                }
                // Health commits with the covered position, even if the Host stops before releasing its lease.
                success(connection, source_id, partition, now)?;
                connection.execute("UPDATE source_positions SET revision=revision+1,baseline=1,cursor_json=?3,next_poll_at_ms=?4,last_success_at_ms=?5,consecutive_failures=0 WHERE source_id=?1 AND partition=?2",params![source_id,partition,json(next_position)?,next_poll_at_ms,now])?;
            }
            SourceCommand::RecordSourceFailure {
                source_id,
                config_revision,
                partition,
                lease_token,
                problem_kind,
                evidence,
                retry_at_ms,
            } => {
                require_current(connection, library, source_id, *config_revision)?;
                if let Some(partition) = partition {
                    require_lease(
                        connection,
                        source_id,
                        partition,
                        lease_token.as_deref().unwrap_or(""),
                        now,
                    )?;
                    connection.execute("UPDATE source_positions SET next_poll_at_ms=?3,consecutive_failures=consecutive_failures+1,lease_token=NULL,lease_expires_at_ms=NULL WHERE source_id=?1 AND partition=?2",params![source_id,partition,retry_at_ms])?;
                }
                record_failure(
                    connection,
                    source_id,
                    partition.as_deref().unwrap_or("source"),
                    problem_kind,
                    evidence,
                    now,
                    1,
                )?;
            }
            SourceCommand::RecordSourceSuccess {
                source_id,
                config_revision,
                partition,
                lease_token,
            } => {
                require_current(connection, library, source_id, *config_revision)?;
                if let Some(partition) = partition {
                    require_lease(
                        connection,
                        source_id,
                        partition,
                        lease_token.as_deref().unwrap_or(""),
                        now,
                    )?;
                    connection.execute("UPDATE source_positions SET consecutive_failures=0,lease_token=NULL,lease_expires_at_ms=NULL WHERE source_id=?1 AND partition=?2",params![source_id,partition])?;
                }
                success(
                    connection,
                    source_id,
                    partition.as_deref().unwrap_or("source"),
                    now,
                )?;
            }
        }
        Ok(effects)
    })
}

fn validate_partition(source: &Source, partition: &str) -> Result<(), StoreError> {
    if !source
        .config
        .repositories
        .iter()
        .any(|r| r.enabled && partition == format!("repo:{}", r.id))
    {
        return Err(invalid("Source partition is not a watched repository"));
    }
    Ok(())
}
fn upsert_thread(
    connection: &Connection,
    library: &str,
    source: &Source,
    partition: &str,
    thread: &ExternalThread,
) -> Result<(), StoreError> {
    let identity = format!(
        "github:{}:{}:{}",
        thread.host, thread.repository_id, thread.number
    );
    let expected_path = match thread.kind {
        ExternalThreadKind::Issue => "issues",
        ExternalThreadKind::PullRequest => "pull",
    };
    if !source.config.repositories.iter().any(|repo| {
        repo.id == thread.repository_id && repo.name.eq_ignore_ascii_case(&thread.repository)
    }) || thread.id != identity
        || thread.host != source.config.host
        || partition != format!("repo:{}", thread.repository_id)
        || thread.number < 1
        || thread.url
            != format!(
                "https://{}/{}/{}/{}",
                thread.host, thread.repository, expected_path, thread.number
            )
        || thread.title.len() > 10000
        || thread.state.len() > 100
    {
        return Err(invalid("Invalid external thread identity"));
    }
    let mut next = thread.clone();
    next.observation_revision = thread
        .observation_revision
        .checked_add(1)
        .ok_or_else(|| invalid("External thread observation revision exhausted"))?;
    if thread.observation_revision < 0 {
        return Err(invalid("Invalid external thread revision"));
    }
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM external_threads WHERE id=?1)",
        [&thread.id],
        |r| r.get(0),
    )?;
    if !exists && thread.observation_revision != 0 {
        return Err(conflict("External thread observations changed"));
    }
    let changed=connection.execute("INSERT INTO external_threads(id,library_id,provider,host,repository_id,number,thread_json) VALUES(?1,?2,'github',?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET thread_json=excluded.thread_json WHERE external_threads.library_id=excluded.library_id AND json_extract(external_threads.thread_json,'$.observation_revision')=?7",params![thread.id,library,thread.host,thread.repository_id,thread.number,json(&next)?,thread.observation_revision])?;
    if changed != 1 {
        return Err(conflict("External thread observations changed"));
    }
    Ok(())
}
fn validate_event(
    connection: &Connection,
    library: &str,
    source: &Source,
    partition: &str,
    event: &SourceTriggerInput,
) -> Result<(), StoreError> {
    if event.semantic_key.is_empty()
        || event.semantic_key.len() > 2048
        || event.kind.len() > 100
        || event.actor_login.len() > 256
        || event.text.as_ref().is_some_and(|s| s.len() > 65536)
        || json(&event.metadata)?.len() > 65536
        || event.url.len() > 4096
    {
        return Err(invalid("Invalid or oversized Source Trigger"));
    }
    let repo: Option<String> = connection
        .query_row(
            "SELECT repository_id FROM external_threads WHERE id=?1 AND library_id=?2 AND host=?3",
            params![event.thread_id, library, source.config.host],
            |r| r.get(0),
        )
        .optional()?;
    if repo.is_none_or(|repo| {
        partition != format!("repo:{repo}")
            || !event
                .semantic_key
                .starts_with(&format!("github:{}:{repo}:", source.config.host))
    }) {
        return Err(invalid("Trigger is outside its Source partition"));
    }
    Ok(())
}
