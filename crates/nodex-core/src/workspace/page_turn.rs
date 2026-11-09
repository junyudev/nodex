//! One transactional projection owns whose Turn it is. SQL triggers collect changed inputs;
//! LocalCommit reconciles the dirty set before sealing, including reverse prerequisites.
use crate::infrastructure::{
    local_commit::CommitContext,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{
    ProjectionImpact,
    library::{PageAssignee, PageWork},
    workspace::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use std::collections::BTreeMap;

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn decode<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery)
}

struct Facts {
    question_member: Option<String>,
    work: PageWork,
    stage: Option<String>,
    active: bool,
    active_agent: Option<PageAssignee>,
    observation: Option<SessionExecutionObservation>,
    report: Option<String>,
    blocker: Option<nodex_core_contracts::database::DatabaseWorkPage>,
    holds: Vec<ExecutionHold>,
}

/// Terminal stages retire work; otherwise the most specific effective hold owns the Turn.
fn choose(facts: &Facts) -> (TurnActor, Option<TurnReason>) {
    use TurnReason::*;
    if matches!(facts.stage.as_deref(), Some("done" | "canceled")) {
        return (TurnActor::None, None);
    }
    if let Some(hold) = facts.holds.first() {
        return (
            TurnActor::Member {
                member_id: hold.actor.clone(),
            },
            Some(Paused),
        );
    }
    let owner = || TurnActor::Member {
        member_id: facts.work.owner.clone(),
    };
    let assigned = || match &facts.work.assignee {
        Some(PageAssignee::Member { member_id }) => TurnActor::Member {
            member_id: member_id.clone(),
        },
        Some(assignee @ PageAssignee::Agent { .. }) => TurnActor::Agent {
            assignee: assignee.clone(),
        },
        None => TurnActor::None,
    };
    let executing = || {
        facts
            .active_agent
            .as_ref()
            .map(|assignee| TurnActor::Agent {
                assignee: assignee.clone(),
            })
            .unwrap_or_else(assigned)
    };
    if let Some(observation) = &facts.observation {
        if observation
            .pending_requests
            .iter()
            .any(|request| request.kind == SessionExecutionRequestKind::Question)
        {
            return (
                facts
                    .question_member
                    .as_ref()
                    .map_or_else(owner, |member| TurnActor::Member {
                        member_id: member.clone(),
                    }),
                Some(Question),
            );
        }
        if observation
            .pending_requests
            .iter()
            .any(|request| request.kind == SessionExecutionRequestKind::Approval)
        {
            return (owner(), Some(Approval));
        }
        // A stalled execution no longer supplies healthy working progress.
        if observation.state == SessionExecutionState::Working && !observation.stalled {
            let actor = executing();
            if actor == TurnActor::None {
                return (TurnActor::None, None);
            }
            return (actor, Some(Working));
        }
        if observation.state == SessionExecutionState::Queued {
            if let Some(assignee) = &facts.active_agent {
                return (
                    TurnActor::Agent {
                        assignee: assignee.clone(),
                    },
                    Some(Queued),
                );
            }
            if let Some(queue) = &observation.queue {
                return (
                    TurnActor::Queue {
                        position: queue.position,
                    },
                    Some(Queued),
                );
            }
        }
    }
    if facts.report.as_deref() == Some("blocked") {
        return (owner(), Some(Blocked));
    }
    if facts.report.as_deref() == Some("failed")
        || facts.observation.as_ref().is_some_and(|observation| {
            observation.state == SessionExecutionState::Failed && !observation.person_stopped
        })
    {
        return (owner(), Some(Failed));
    }
    if facts
        .observation
        .as_ref()
        .is_some_and(|observation| observation.stalled)
    {
        return (owner(), Some(Stalled));
    }
    if facts.stage.as_deref() == Some("review") {
        return (owner(), Some(Review));
    }
    if let Some(page) = &facts.blocker {
        return (
            TurnActor::Page {
                page_id: page.page_id.clone(),
                key: page.page_key.clone(),
            },
            Some(WaitingOnPrerequisite),
        );
    }
    if !facts.active
        && matches!(facts.stage.as_deref(), Some("triage" | "plan"))
        && matches!(facts.work.assignee, Some(PageAssignee::Agent { .. }))
    {
        return if facts.work.auto_start {
            (assigned(), Some(Starting))
        } else {
            (owner(), Some(ReadyToStart))
        };
    }
    if facts.stage.as_deref() == Some("doing")
        && matches!(facts.work.assignee, Some(PageAssignee::Member { .. }))
    {
        return (assigned(), Some(Working));
    }
    (TurnActor::None, None)
}

fn facts(connection: &Connection, ids: &[&str]) -> Result<BTreeMap<String, Facts>, StoreError> {
    let blockers = crate::database::work_graph::summaries(connection, ids)?;
    let mut holds = super::execution_holds::for_pages(connection, ids)?;
    let rows = connection.prepare("SELECT page.block_id,work.value_json,json_extract(status.value_json,'$'),active.session_id,observation.observed_json,report.report_outcome FROM json_each(?1) selected JOIN pages page ON page.block_id=selected.value JOIN blocks block ON block.id=page.block_id JOIN block_properties work ON work.block_id=page.block_id AND work.property_key='work' LEFT JOIN data_source_page_memberships membership ON membership.page_block_id=page.block_id AND membership.data_source_id=page.parent_id AND page.parent_kind='data_source' AND membership.removed_at IS NULL LEFT JOIN data_source_property_values status ON status.data_source_id=membership.data_source_id AND status.membership_id=membership.id AND status.property_id='status' LEFT JOIN page_active_chats active ON active.page_id=page.block_id LEFT JOIN session_execution_observations observation ON observation.session_id=active.session_id LEFT JOIN project_session_pages report ON report.page_id=page.block_id AND report.session_id=active.session_id")?
        .query_map([json!(ids).to_string()], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,Option<String>>(2)?, row.get::<_,Option<String>>(3)?, row.get::<_,Option<String>>(4)?, row.get::<_,Option<String>>(5)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, work, stage, active, observation, report)| {
            let work = crate::library::parse_page_work(&decode(work)?)?;
            let active_agent = active
                .as_deref()
                .map(|session| super::page_chat::session_agent_selection(connection, session))
                .transpose()?
                .flatten()
                .map(|agent| PageAssignee::Agent {
                    instance_id: agent.instance_id,
                    model: agent.model,
                    effort: agent.effort,
                });
            let blocker = blockers
                .get(&id)
                .and_then(|summary| summary.blockers.first())
                .cloned();
            let observation: Option<SessionExecutionObservation> =
                observation.map(decode).transpose()?;
            Ok((
                id.clone(),
                Facts {
                    question_member: active
                        .as_ref()
                        .map(|session| {
                            crate::infrastructure::actors::session_requester(
                                connection,
                                session,
                                observation.as_ref().and_then(|o| o.run_id.as_deref()),
                            )
                        })
                        .transpose()?
                        .flatten(),
                    holds: holds.remove(&id).unwrap_or_default(),
                    work,
                    stage,
                    active: active.is_some(),
                    active_agent,
                    observation,
                    report,
                    blocker,
                },
            ))
        })
        .collect()
}

fn signature(actor: &TurnActor, reason: Option<TurnReason>, holds: &[ExecutionHold]) -> String {
    // Page key is presentation metadata, not a new actor; queue position is part of its actor.
    let actor = match actor {
        TurnActor::Page { page_id, .. } => json!({"kind":"page", "page_id":page_id}),
        actor => json!(actor),
    };
    let hold = (reason == Some(TurnReason::Paused)).then(|| {
        holds
            .iter()
            .map(|hold| json!([hold.scope, hold.revision]))
            .collect::<Vec<_>>()
    });
    json!([actor, reason, hold]).to_string()
}

pub(super) fn read_turns(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<Vec<PageTurn>, StoreError> {
    if page_ids.len() > 200 {
        return Err(invalid("Turn window is bounded to 200 Pages"));
    }
    for id in page_ids {
        super::session_mutation::validate_id("page_id", id)?;
    }
    let count:i64=connection.query_row("SELECT count(DISTINCT page.block_id) FROM json_each(?1) selected JOIN pages page ON page.block_id=selected.value AND page.library_id=?2",params![json!(page_ids).to_string(),library_id],|row|row.get(0))?;
    if count as usize
        != page_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Turn Page is unavailable",
            false,
        ));
    }
    turns(connection, page_ids)
}

pub(crate) fn turns(
    connection: &Connection,
    page_ids: &[String],
) -> Result<Vec<PageTurn>, StoreError> {
    if page_ids.len() > 200 {
        return Err(invalid("Turn window is bounded to 200 Pages"));
    }
    for id in page_ids {
        super::session_mutation::validate_id("page_id", id)?;
    }
    let ids = page_ids.iter().map(String::as_str).collect::<Vec<_>>();
    let facts = facts(connection, &ids)?;
    let episodes=connection.prepare("SELECT page_id,signature,episode,since FROM page_turn_episodes WHERE page_id IN (SELECT value FROM json_each(?1))")?.query_map([json!(page_ids).to_string()],|r|Ok((r.get::<_,String>(0)?,(r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))))?.collect::<rusqlite::Result<BTreeMap<_,_>>>()?;
    let open:Option<(String,String)>=connection.query_row("SELECT store_epoch||':'||commit_seq,committed_at FROM local_commits WHERE commit_seq=(SELECT max(commit_seq) FROM local_commits) AND finalized=0",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    page_ids
        .iter()
        .map(|id| {
            let facts = facts.get(id).ok_or_else(|| {
                StoreError::new(StoreErrorCode::NotFound, "Turn Page is unavailable", false)
            })?;
            let (actor, reason) = choose(facts);
            let persisted = episodes.get(id).cloned();
            let current_signature = signature(&actor, reason, &facts.holds);
            let (episode, since) = match persisted {
                Some((signature, episode, since)) if signature == current_signature => {
                    (episode, since)
                }
                _ => {
                    // Projection patches may be assembled before the commit seals. Use the exact
                    // forthcoming episode without mutating from a read or publishing an old episode.
                    let (identity, now) = open
                        .clone()
                        .unwrap_or_else(|| ("initial".into(), "1970-01-01T00:00:00.000Z".into()));
                    (
                        crate::domain::identity::stable_uuid_v7("page-turn", &identity, id),
                        now,
                    )
                }
            };
            Ok(PageTurn {
                page_id: id.clone(),
                actor,
                reason,
                episode,
                since,
                hold: facts
                    .holds
                    .first()
                    .cloned()
                    .filter(|_| reason == Some(TurnReason::Paused)),
            })
        })
        .collect()
}

/// Migration uses the same decision as ordinary commits, without manufacturing Work events.
pub(crate) fn initialize(
    connection: &Connection,
    identity: &str,
    now: &str,
) -> Result<Vec<String>, StoreError> {
    let dirty = connection
        .prepare("SELECT page_id FROM page_turn_dirty ORDER BY page_id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if dirty.is_empty() {
        return Ok(vec![]);
    }
    let mut affected = dirty.clone();
    let reverse = connection.prepare("SELECT DISTINCT membership.page_block_id FROM json_each(?1) dirty JOIN data_source_relation_edges edge ON edge.target_page_block_id=dirty.value AND edge.property_id='blocked_by' JOIN data_source_page_memberships membership ON membership.id=edge.source_membership_id")?.query_map([json!(dirty).to_string()], |r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    affected.extend(reverse);
    affected.sort();
    affected.dedup();
    // Non-Page Blocks also participate in lifecycle writes; they have no Turn.
    affected=connection.prepare("SELECT page.block_id FROM json_each(?1) selected JOIN pages page ON page.block_id=selected.value ORDER BY page.block_id")?.query_map([json!(affected).to_string()],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    // Derive in bounded batches, even for a Source lifecycle mutation.
    for chunk in affected.chunks(200) {
        let ids = chunk.iter().map(String::as_str).collect::<Vec<_>>();
        let current = facts(connection, &ids)?;
        for (id, facts) in current {
            let (actor, reason) = choose(&facts);
            let signature = signature(&actor, reason, &facts.holds);
            let episode = crate::domain::identity::stable_uuid_v7("page-turn", identity, &id);
            connection.execute("INSERT INTO page_turn_episodes(page_id,signature,episode,since) VALUES(?1,?2,?3,?4) ON CONFLICT(page_id) DO UPDATE SET signature=excluded.signature,episode=excluded.episode,since=excluded.since WHERE page_turn_episodes.signature<>excluded.signature",params![id,signature,episode,now])?;
        }
    }
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='page_turn_notification_intents')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        connection.execute("INSERT INTO page_turn_notification_intents(member_id,page_id,episode,created_at) SELECT json_extract(episode.signature,'$[0].member_id'),episode.page_id,episode.episode,episode.since FROM page_turn_episodes episode JOIN inbox_rows rows ON rows.page_id=episode.page_id AND rows.row_kind='turn' WHERE json_extract(episode.signature,'$[1]') IN ('question','approval') AND episode.page_id IN (SELECT value FROM json_each(?1)) ON CONFLICT DO NOTHING",[json!(affected).to_string()])?;
    }
    connection.execute("DELETE FROM page_turn_dirty", [])?;
    Ok(affected)
}

/// Runs once at the semantic commit boundary, before LocalCommit evidence is sealed.
pub(crate) fn reconcile(connection: &Connection, commit: &CommitContext) -> Result<(), StoreError> {
    if !connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='page_turn_dirty')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    let mut ids = initialize(
        connection,
        &format!("{}:{}", commit.store_epoch(), commit.commit_seq()),
        commit.committed_at(),
    )?;
    if ids.is_empty() {
        return Ok(());
    }
    let impacts=connection.prepare("SELECT projection_impact_json FROM local_commit_effects WHERE store_epoch=?1 AND commit_seq=?2")?.query_map(params![commit.store_epoch(),commit.commit_seq()],|r|decode::<ProjectionImpact>(r.get(0)?))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if impacts
        .iter()
        .any(|impact| matches!(impact, ProjectionImpact::All))
    {
        return Ok(());
    }
    ids.retain(|id| !impacts.iter().any(|impact|matches!(impact,ProjectionImpact::Resources { page_ids,.. } if page_ids.contains(id))));
    if ids.is_empty() {
        return Ok(());
    }
    let impact = crate::infrastructure::projection_impact::expand_database_coordinates(
        connection,
        ProjectionImpact::Resources {
            page_ids: ids.clone(),
            database_ids: vec![],
            data_source_ids: vec![],
            view_ids: vec![],
            document_heads: vec![],
        },
    )?;
    // Supplemental Turn changes need authority-scoped read repairs, not row patches:
    // metadata mutations such as Page-key renames intentionally avoid per-row payloads.
    let libraries = connection.prepare("SELECT DISTINCT page.library_id FROM json_each(?1) selected JOIN pages page ON page.block_id=selected.value")?.query_map([json!(ids).to_string()], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for library in libraries {
        crate::database::record_local_projection_read_repairs(
            connection, commit, &library, &impact,
        )?;
    }
    crate::infrastructure::event_log::append_change_log(connection, crate::infrastructure::event_log::NewChangeLogEntry {
        project_id:None, store_epoch:commit.store_epoch(),kind:"project_workspace.changed",operation_id:Some(commit.operation_id()),block_ids:&ids,document_ids:&[],database_block_ids:&[],
        payload_json:&json!({"module":"project_workspace","kind":"workspace_changed","operationKind":"page_turn","inboxChanged":true,"projectIds":[],"sessionIds":[],"threadIds":[],"sessionSummaryScopes":[],"sessionDetailIds":[]}).to_string(),
        projection_impact:&impact,committed_at:commit.committed_at(),
    }, commit)?;
    Ok(())
}

pub(super) fn observer(
    connection: &Connection,
    id: &str,
) -> Result<Option<SessionExecutionObserver>, StoreError> {
    super::session_mutation::validate_id("session_id", id)?;
    row.map(|(since, revision, observation)| {
        Ok(SessionExecutionObserver {
            session_id: id.into(),
            since,
            revision,
            observation: observation.map(decode).transpose()?,
            managed: super::coordinator::managed(connection, id)?,
        })
    })
    .transpose()
}
pub(super) fn observers(
    connection: &Connection,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<SessionExecutionObserver>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Observation window is bounded to 100 Sessions"));
    }
    ids.iter()
        .map(|id| observer(connection, id)?.ok_or_else(|| invalid("Observed Session disappeared")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Facts {
        Facts {
            question_member: None,
            work: PageWork {
                owner: "owner".into(),
                assignee: Some(PageAssignee::Agent {
                    instance_id: "codex".into(),
                    model: "gpt".into(),
                    effort: None,
                }),
                auto_start: false,
            },
            stage: Some("plan".into()),
            active: false,
            active_agent: None,
            observation: None,
            report: None,
            blocker: None,
            holds: vec![],
        }
    }
    fn observation(state: SessionExecutionState) -> SessionExecutionObservation {
        SessionExecutionObservation {
            agent: None,
            state,
            run_id: Some("run".into()),
            run_started_at: Some(0),
            failure_reason: None,
            pending_request_ids: vec![],
            pending_requests: vec![],
            queue: None,
            terminal_status: None,
            person_stopped: false,
            stalled: false,
            progress_fingerprint: None,
            progress_since: 0,
        }
    }
    #[test]
    fn precedence_matrix_covers_every_turn_and_overlapping_facts() {
        use SessionExecutionState as E;
        use TurnReason::*;
        let mut f = base();
        assert_eq!(choose(&f).1, Some(ReadyToStart));
        f.work.auto_start = true;
        assert_eq!(choose(&f).1, Some(Starting));
        f.active = true;
        assert_eq!(choose(&f), (TurnActor::None, None));
        f.work.assignee = Some(PageAssignee::Member {
            member_id: "person".into(),
        });
        f.stage = Some("doing".into());
        assert_eq!(
            choose(&f),
            (
                TurnActor::Member {
                    member_id: "person".into()
                },
                Some(Working)
            )
        );
        f.blocker = Some(nodex_core_contracts::database::DatabaseWorkPage {
            page_id: "blocker".into(),
            page_key: Some("NODEX-2".into()),
            title: "Prerequisite".into(),
            status: None,
        });
        assert_eq!(choose(&f).1, Some(WaitingOnPrerequisite));
        f.stage = Some("review".into());
        assert_eq!(choose(&f).1, Some(Review));
        f.observation = Some(observation(E::Working));
        f.observation.as_mut().unwrap().stalled = true;
        assert_eq!(choose(&f).1, Some(Stalled));
        f.observation = Some(observation(E::Failed));
        assert_eq!(choose(&f).1, Some(Failed));
        f.observation.as_mut().unwrap().person_stopped = true;
        assert_eq!(choose(&f).1, Some(Review));
        f.observation = Some(observation(E::Unavailable));
        assert_eq!(choose(&f).1, Some(Review));
        f.report = Some("failed".into());
        assert_eq!(choose(&f).1, Some(Failed));
        f.report = Some("blocked".into());
        assert_eq!(choose(&f).1, Some(Blocked));
        f.observation = Some(observation(E::Queued));
        f.observation.as_mut().unwrap().queue = Some(SessionExecutionQueue {
            run_id: "run".into(),
            class: SessionExecutionQueueClass::Start,
            position: 2,
            waiting_since: "now".into(),
        });
        assert_eq!(choose(&f), (TurnActor::Queue { position: 2 }, Some(Queued)));
        f.observation = Some(observation(E::Working));
        assert_eq!(choose(&f).1, Some(Working));
        f.observation
            .as_mut()
            .unwrap()
            .pending_requests
            .push(SessionExecutionRequest {
                id: "a".into(),
                question: None,
                options: vec![],
                kind: SessionExecutionRequestKind::Approval,
            });
        assert_eq!(choose(&f).1, Some(Approval));
        f.observation
            .as_mut()
            .unwrap()
            .pending_requests
            .push(SessionExecutionRequest {
                id: "q".into(),
                question: None,
                options: vec![],
                kind: SessionExecutionRequestKind::Question,
            });
        assert_eq!(
            choose(&f),
            (
                TurnActor::Member {
                    member_id: "owner".into()
                },
                Some(Question)
            )
        );
        let mut unassigned = base();
        unassigned.work.assignee = None;
        unassigned.observation = Some(observation(E::Working));
        assert_eq!(choose(&unassigned), (TurnActor::None, None));
        f.holds.push(ExecutionHold {
            scope: ExecutionHoldScope::Space,
            actor: "pauser".into(),
            revision: 1,
            paused_at: "now".into(),
        });
        assert_eq!(
            choose(&f),
            (
                TurnActor::Member {
                    member_id: "pauser".into()
                },
                Some(Paused)
            )
        );
        for stage in ["done", "canceled"] {
            f.stage = Some(stage.into());
            assert_eq!(choose(&f), (TurnActor::None, None));
        }
    }
}
