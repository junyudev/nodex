//! Work prerequisites are outgoing Relations. Incoming reads and readiness are derived;
//! unavailable/moved/archived prerequisites remain blockers, never implicit completion.
use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
    MAX_COLLECTION_WINDOW_JSON_BYTES,
};
use nodex_core_contracts::database::{
    DatabasePrerequisitesSummary, DatabaseRowSummary, DatabaseWorkPage, DatabaseWorkSummary,
    ReadyWorkPage, WorkPrerequisite,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_GRAPH_EDGES: usize = 1_000_000;
const MAX_READY_PREREQUISITES: usize = 10_000;

/// Validate all retained edges, including unavailable memberships, so restoring content
/// cannot resurrect a cycle. Iterative DFS keeps deep DAGs independent of call-stack size.
/// Called once after the complete Relation batch, allowing transient cycles repaired by
/// later removals in the same transaction.
pub(crate) fn validate_graph(
    connection: &Connection,
    code: StoreErrorCode,
) -> Result<(), StoreError> {
    let edges = connection.prepare(
        "SELECT membership.page_block_id, edge.target_page_block_id \
         FROM data_source_relation_edges edge JOIN data_source_page_memberships membership \
           ON membership.id = edge.source_membership_id AND membership.data_source_id = edge.source_data_source_id \
         WHERE edge.property_id = 'blocked_by' ORDER BY membership.page_block_id, edge.target_page_block_id LIMIT ?1"
    )?.query_map([MAX_GRAPH_EDGES as i64 + 1], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if edges.len() > MAX_GRAPH_EDGES {
        return Err(exhausted("Prerequisite graph exceeds validation budget"));
    }
    let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (source, target) in edges {
        graph.entry(source).or_default().push(target);
    }
    let mut complete = BTreeSet::new();
    for root in graph.keys() {
        validate_component(root, &graph, &mut complete, code)?;
    }
    Ok(())
}

fn validate_component<'a>(
    root: &'a str,
    graph: &'a BTreeMap<String, Vec<String>>,
    complete: &mut BTreeSet<&'a str>,
    code: StoreErrorCode,
) -> Result<(), StoreError> {
    if complete.contains(root) {
        return Ok(());
    }
    let mut path = Vec::new();
    let mut visiting = BTreeMap::new();
    let mut stack = vec![(root, false)];
    while let Some((page, exiting)) = stack.pop() {
        if exiting {
            visiting.remove(page);
            path.pop();
            complete.insert(page);
            continue;
        }
        if let Some(start) = visiting.get(page).copied() {
            let mut cycle = path[start..].iter().take(32).copied().collect::<Vec<_>>();
            if path.len() - start > 32 {
                cycle.push("…");
            }
            cycle.push(page);
            return Err(StoreError::new(
                code,
                format!("Prerequisite cycle: {}", cycle.join(" -> ")),
                false,
            ));
        }
        if complete.contains(page) {
            continue;
        }
        visiting.insert(page, path.len());
        path.push(page);
        stack.push((page, true));
        for target in graph.get(page).into_iter().flatten().rev() {
            stack.push((target.as_str(), false));
        }
    }
    Ok(())
}

// Work prerequisites pin each target to its Source when linked, including other Projects.
// Moving or removing the target keeps the edge unsatisfied until it returns.
const TARGET_JOINS: &str = "\
 LEFT JOIN pages target_page ON target_page.block_id = edge.target_page_block_id \
 LEFT JOIN blocks target ON target.id = target_page.block_id \
 LEFT JOIN data_sources target_source ON target_source.id = COALESCE(edge.target_data_source_id, edge.source_data_source_id) \
 LEFT JOIN database_containers target_database ON target_database.block_id = target_source.home_database_block_id \
 LEFT JOIN data_source_page_memberships target_membership \
   ON target_membership.page_block_id = target_page.block_id \
  AND target_membership.data_source_id = target_source.id AND target_membership.removed_at IS NULL \
 LEFT JOIN data_source_property_values status ON status.data_source_id = target_membership.data_source_id \
  AND status.membership_id = target_membership.id AND status.property_id = 'status' \
 LEFT JOIN data_source_properties status_property ON status_property.data_source_id = status.data_source_id \
  AND status_property.id = 'status' AND status_property.lifecycle = 'active' \
 LEFT JOIN project_session_pages report ON report.page_id = target_page.block_id \
  AND report.session_id = (SELECT latest.session_id FROM project_session_pages latest \
   WHERE latest.page_id = target_page.block_id AND latest.report_outcome IS NOT NULL \
   ORDER BY latest.report_at DESC, latest.report_revision DESC, latest.session_id LIMIT 1)";

struct PrerequisiteSatisfactionSql {
    predicate: &'static str,
    revision: &'static str,
}

/// The single satisfaction/revision seam for readiness, summaries and epochs.
fn prerequisite_satisfaction_sql() -> PrerequisiteSatisfactionSql {
    PrerequisiteSatisfactionSql {
        predicate: "COALESCE(target.lifecycle = 'active' AND target_source.lifecycle = 'active' \
         AND target_database.lifecycle = 'active' AND target_membership.id IS NOT NULL \
         AND target_page.parent_kind = 'data_source' AND target_page.parent_id = target_source.id \
         AND status_property.id IS NOT NULL AND json_extract(status.value_json, '$') = 'done', 0)",
        revision: "'status:' || target_membership.id || ':' || status.revision",
    }
}

fn facts_cte() -> String {
    format!(
        "WITH facts AS (SELECT source.page_block_id AS page_id, edge.target_page_block_id AS prerequisite_id, \
      {satisfied} AS satisfied, CASE WHEN {satisfied} THEN {revision} END AS satisfying_revision, \
      CASE WHEN target.lifecycle = 'active' THEN COALESCE(model.title, '') ELSE '' END AS title, \
      CASE WHEN target.lifecycle = 'active' THEN json_extract(status.value_json, '$') END AS status, \
      CASE WHEN target.lifecycle = 'active' THEN (SELECT prefix.normalized_prefix || '-' || assignment.number \
        FROM page_key_assignments assignment JOIN data_sources current_source ON current_source.id = target_page.parent_id AND target_page.parent_kind = 'data_source' JOIN page_key_prefixes prefix \
          ON prefix.database_block_id = assignment.database_block_id AND prefix.retired_at IS NULL \
        WHERE assignment.page_block_id = target_page.block_id AND assignment.database_block_id = current_source.home_database_block_id) END AS page_key, report.report_outcome, report.report_summary, report.report_at, report.report_revision, report.report_status_moved \
      FROM json_each(?1) selected JOIN data_source_page_memberships source ON source.page_block_id = selected.value AND source.removed_at IS NULL \
      JOIN data_source_properties property ON property.data_source_id = source.data_source_id AND property.id = 'blocked_by' AND property.lifecycle = 'active' \
      JOIN data_source_relation_edges edge ON edge.source_data_source_id = source.data_source_id AND edge.source_membership_id = source.id AND edge.property_id = 'blocked_by' \
      {TARGET_JOINS} LEFT JOIN page_read_model model ON model.page_block_id = target_page.block_id)",
        satisfied = prerequisite_satisfaction_sql().predicate,
        revision = prerequisite_satisfaction_sql().revision
    )
}

pub(crate) fn hydrate_summaries(
    connection: &Connection,
    rows: &mut [DatabaseRowSummary],
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids = rows
        .iter()
        .map(|row| row.page_id.as_str())
        .collect::<Vec<_>>();
    let summaries = summaries(connection, &ids)?;
    // The intrinsic selection is independent of the View's selected Properties. One
    // bounded batch reads it even for compact Board/List rows without intrinsic hydration.
    let agents = connection
        .prepare(
            "SELECT property.block_id, property.value_json FROM json_each(?1) selected \
         JOIN block_properties property ON property.block_id = selected.value \
         AND property.property_key = 'work' WHERE json_type(property.value_json) <> 'null'",
        )?
        .query_map([json!(ids).to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (id, json) = row?;
            let value = serde_json::from_str(&json).map_err(|_| {
                StoreError::new(
                    StoreErrorCode::StoreCorrupt,
                    "Stored Page work JSON is invalid",
                    false,
                )
            })?;
            let work = crate::library::parse_page_work(&value).map_err(|error| {
                StoreError::new(StoreErrorCode::StoreCorrupt, error.message, false)
            })?;
            Ok((id, work))
        })
        .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
    let mut turns = BTreeMap::new();
    for chunk in agents.keys().cloned().collect::<Vec<_>>().chunks(200) {
        let page_ids = chunk.iter().map(|id| id.to_owned()).collect::<Vec<_>>();
        for turn in crate::workspace::page_turn::turns(connection, &page_ids)? {
            turns.insert(turn.page_id.clone(), turn);
        }
    }
    let prs=connection.prepare("SELECT pr.page_id,pr.workspace_id,pr.repository,pr.number,pr.url,pr.state,pr.observed_at FROM json_each(?1) selected JOIN page_pull_requests pr ON pr.page_id=selected.value")?.query_map([json!(ids).to_string()],|r|Ok(nodex_core_contracts::workspace::PagePullRequest {page_id:r.get(0)?,workspace_id:r.get(1)?,repository:r.get(2)?,number:r.get(3)?,url:r.get(4)?,state:r.get(5)?,observed_at:r.get(6)?}))?.map(|r|r.map(|pr|(pr.page_id.clone(),pr))).collect::<rusqlite::Result<BTreeMap<_,_>>>()?;
    for row in rows {
        let prerequisites = summaries.get(&row.page_id).cloned().unwrap_or_default();
        let page_work = agents.get(&row.page_id);
        if let Some(work) = page_work {
            row.database_values.insert(
                "owner".into(),
                json!({"kind":"member","member_id":work.owner}),
            );
            row.database_values
                .insert("assignee".into(), json!(work.assignee));
        }
        row.work = DatabaseWorkSummary {
            turn: turns.remove(&row.page_id),
            pull_request: prs.get(&row.page_id).cloned(),
            unsatisfied_count: prerequisites.unsatisfied_count,
            blockers: prerequisites.blockers,
            owner: page_work.map(|work| work.owner.clone()),
            assignee: page_work.and_then(|work| work.assignee.clone()),
            auto_start: page_work.is_some_and(|work| work.auto_start),
        };
    }
    Ok(())
}

pub(crate) fn summaries(
    connection: &Connection,
    page_ids: &[&str],
) -> Result<BTreeMap<String, DatabasePrerequisitesSummary>, StoreError> {
    if page_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    // Only count + top three blockers cross SQLite, regardless of outgoing edge count.
    let sql = format!(
        "{}, ranked AS (SELECT *, count(*) OVER (PARTITION BY page_id) AS total, \
      row_number() OVER (PARTITION BY page_id ORDER BY prerequisite_id) AS ordinal FROM facts WHERE NOT satisfied) \
      SELECT page_id, total, prerequisite_id, page_key, substr(title, 1, 512), status FROM ranked WHERE ordinal <= 3 ORDER BY page_id, ordinal",
        facts_cte()
    );
    let facts = connection
        .prepare(&sql)?
        .query_map([json!(page_ids).to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                DatabaseWorkPage {
                    page_id: row.get(2)?,
                    page_key: row.get(3)?,
                    title: row.get(4)?,
                    status: row.get(5)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result: BTreeMap<String, DatabasePrerequisitesSummary> = BTreeMap::new();
    for (id, total, blocker) in facts {
        let summary = result.entry(id).or_default();
        summary.unsatisfied_count = total;
        summary.blockers.push(blocker);
    }
    Ok(result)
}

fn require_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    let exists = connection.query_row("SELECT 1 FROM pages page JOIN blocks block ON block.id = page.block_id WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle <> 'deleted'", params![page_id, library_id], |_| Ok(() )).optional()?;
    exists
        .ok_or_else(|| StoreError::new(StoreErrorCode::NotFound, "Work Page is unavailable", false))
}

pub(crate) fn prerequisites(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<DatabasePrerequisitesSummary, StoreError> {
    require_page(connection, library_id, page_id)?;
    Ok(summaries(connection, &[page_id])?
        .remove(page_id)
        .unwrap_or_default())
}

pub(crate) fn ready_work(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    limit: Option<u32>,
    after_page_id: Option<&str>,
) -> Result<Vec<ReadyWorkPage>, StoreError> {
    ready_work_filtered(
        connection,
        library_id,
        project_id,
        limit,
        None,
        after_page_id,
    )
}

pub(crate) fn ready_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<ReadyWorkPage>, StoreError> {
    Ok(
        ready_work_filtered(connection, library_id, None, Some(1), Some(page_id), None)?
            .into_iter()
            .next(),
    )
}
fn ready_work_filtered(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    limit: Option<u32>,
    page_id: Option<&str>,
    after_page_id: Option<&str>,
) -> Result<Vec<ReadyWorkPage>, StoreError> {
    if after_page_id.is_some_and(|id| {
        id.is_empty() || id.len() > 512 || id.trim() != id || id.chars().any(char::is_control)
    }) {
        return Err(invalid(
            "ReadyWork after_page_id must be a canonical Page identity of at most 512 bytes",
        ));
    }
    let limit = limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err(invalid("ReadyWork limit must be between 1 and 100"));
    }
    let sql = format!(
        "SELECT page.block_id, project.id, work.value_json, work.revision, current_status.revision, page.status_person_revision FROM projects project \
      JOIN database_containers database ON database.block_id = COALESCE(project.database_block_id, (SELECT binding.database_block_id FROM project_database_bindings binding WHERE binding.project_id = project.id AND binding.lifecycle = 'active')) \
      JOIN data_sources source ON source.home_database_block_id = database.block_id \
      JOIN pages page ON page.parent_kind = 'data_source' AND page.parent_id = source.id \
      JOIN blocks block ON block.id = page.block_id \
      JOIN data_source_page_memberships membership ON membership.page_block_id = page.block_id AND membership.data_source_id = source.id AND membership.removed_at IS NULL \
      JOIN block_properties work ON work.block_id = page.block_id AND work.property_key = 'work' AND work.value_type = 'json' AND json_extract(work.value_json, '$.assignee.kind') = 'agent' \
      JOIN data_source_property_values current_status ON current_status.data_source_id = source.id AND current_status.membership_id = membership.id AND current_status.property_id = 'status' \
      WHERE project.library_id = ?1 AND project.lifecycle = 'active' AND database.lifecycle = 'active' AND source.lifecycle = 'active' AND block.lifecycle = 'active' \
        AND (?2 IS NULL OR project.id = ?2) AND (?4 IS NULL OR page.block_id = ?4) AND (?5 IS NULL OR page.block_id > ?5) AND json_extract(current_status.value_json, '$') IN ('triage', 'plan') \
        AND NOT EXISTS (SELECT 1 FROM page_active_chats active WHERE active.page_id = page.block_id) \
        AND NOT EXISTS (SELECT 1 FROM inbox_intake intake WHERE intake.page_id=page.block_id AND (intake.triage OR intake.recovery)) \
        AND NOT EXISTS (SELECT 1 FROM data_source_relation_edges edge \
          JOIN data_source_properties property ON property.data_source_id = edge.source_data_source_id AND property.id = 'blocked_by' AND property.lifecycle = 'active' \
          {TARGET_JOINS} WHERE edge.source_data_source_id = source.id AND edge.source_membership_id = membership.id \
          AND edge.property_id = 'blocked_by' AND NOT ({satisfied})) \
      ORDER BY page.block_id, project.id LIMIT ?3",
        satisfied = prerequisite_satisfaction_sql().predicate
    );
    let candidates = connection
        .prepare(&sql)?
        .query_map(
            params![library_id, project_id, limit, page_id, after_page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let ids = candidates
        .iter()
        .map(|(id, _, _, _, _, _)| id.as_str())
        .collect::<Vec<_>>();
    let sql = format!(
        "{} SELECT page_id, prerequisite_id, satisfied, satisfying_revision FROM facts ORDER BY page_id, prerequisite_id LIMIT ?2",
        facts_cte()
    );
    let facts = connection
        .prepare(&sql)?
        .query_map(
            params![json!(ids).to_string(), MAX_READY_PREREQUISITES as i64 + 1],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    WorkPrerequisite {
                        page_id: row.get(1)?,
                        satisfied: row.get(2)?,
                        satisfying_revision: row.get(3)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if facts.len() > MAX_READY_PREREQUISITES {
        return Err(exhausted("ReadyWork prerequisites exceed response budget"));
    }
    let mut by_page: BTreeMap<String, Vec<WorkPrerequisite>> = BTreeMap::new();
    for (id, fact) in facts {
        by_page.entry(id).or_default().push(fact);
    }
    let pages = candidates
        .into_iter()
        .map(
            |(page_id, project_id, value, work_revision, status_revision, person_revision)| {
                let value = serde_json::from_str(&value).map_err(|_| {
                    StoreError::new(
                        StoreErrorCode::StoreCorrupt,
                        "Invalid Page work JSON",
                        false,
                    )
                })?;
                let page_work = crate::library::parse_page_work(&value).map_err(|error| {
                    StoreError::new(StoreErrorCode::StoreCorrupt, error.message, false)
                })?;
                let prerequisites = by_page.get(&page_id).cloned().unwrap_or_default();
                let readiness_epoch = format!(
                    "{}:{}",
                    page_id,
                    crate::document::sha256(
                        json!([
                            "done-prerequisites-v2",
                            page_id,
                            work_revision,
                            &page_work,
                            status_revision,
                            person_revision,
                            prerequisites
                        ])
                        .to_string()
                        .as_bytes()
                    )
                );
                Ok(ReadyWorkPage {
                    page_id,
                    project_id,
                    page_work,
                    prerequisites,
                    readiness_epoch,
                })
            },
        )
        .collect::<Result<Vec<_>, StoreError>>()?;
    if serde_json::to_vec(&pages)
        .map_err(|_| invalid("ReadyWork cannot be encoded"))?
        .len()
        > MAX_COLLECTION_WINDOW_JSON_BYTES
    {
        return Err(exhausted("ReadyWork response exceeds byte budget"));
    }
    Ok(pages)
}

pub(crate) fn blocking(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    commit_head: i64,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabaseWorkPage>, StoreError> {
    require_page(connection, library_id, page_id)?;
    let normalized = normalize_request(request)?;
    if normalized.first > 100 {
        return Err(invalid("Blocking window cannot exceed 100 Pages"));
    }
    let fingerprint = cursor::query_fingerprint(&("database_blocking_v1", page_id))?;
    let subject = CollectionCursorSubject {
        kind: "database_blocking",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Blocking cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let candidates = connection.prepare("SELECT DISTINCT membership.page_block_id, substr(model.title,1,512), json_extract(status.value_json, '$') \
      FROM data_source_relation_edges edge INDEXED BY idx_data_source_relation_edges_target \
      JOIN data_source_page_memberships membership ON membership.id = edge.source_membership_id AND membership.data_source_id = edge.source_data_source_id AND membership.removed_at IS NULL \
      JOIN data_sources source ON source.id = membership.data_source_id AND source.lifecycle = 'active' \
      JOIN database_containers database ON database.block_id = source.home_database_block_id AND database.lifecycle = 'active' \
      JOIN pages page ON page.block_id = membership.page_block_id AND page.parent_kind = 'data_source' AND page.parent_id = source.id \
      JOIN blocks block ON block.id = page.block_id AND block.library_id = ?1 AND block.lifecycle = 'active' \
      JOIN data_source_properties property ON property.data_source_id = source.id AND property.id = 'blocked_by' AND property.lifecycle = 'active' \
      JOIN page_read_model model ON model.page_block_id = page.block_id \
      LEFT JOIN data_source_property_values status ON status.data_source_id = source.id AND status.membership_id = membership.id AND status.property_id = 'status' \
      WHERE edge.target_page_block_id = ?2 AND edge.property_id = 'blocked_by' AND (?3 IS NULL OR page.block_id > ?3) \
      ORDER BY membership.page_block_id LIMIT ?4")?.query_map(params![library_id, page_id, after, normalized.first as i64 + 1], |row| Ok(DatabaseWorkPage { page_id: row.get(0)?, page_key: None, title: row.get(1)?, status: row.get(2)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = candidates
        .into_iter()
        .map(|mut item| {
            item.page_key =
                super::page_key::current_page_key_for_page(connection, library_id, &item.page_id)?;
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![],
                    stable_id: item.page_id.clone(),
                },
                item,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
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

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn exhausted(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

/// One bounded brief context; Main reads the Page body through Library's canonical NFM read.
pub(crate) fn work_context(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<nodex_core_contracts::database::PageWorkContext, StoreError> {
    use nodex_core_contracts::database::{PageWorkContext, PageWorkPrerequisite};
    require_page(connection, library_id, page_id)?;
    let (project_id,title,status,page_work): (String,String,Option<String>,Option<String>) = connection.query_row(
        "SELECT project.id,COALESCE(model.title,''),json_extract(status.value_json,'$'),work.value_json FROM pages page \
         JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active' \
         JOIN data_sources source ON page.parent_kind='data_source' AND page.parent_id=source.id AND source.lifecycle='active' \
         JOIN database_containers database ON database.block_id=source.home_database_block_id AND database.lifecycle='active' \
         JOIN projects project ON project.library_id=?1 AND project.lifecycle='active' AND database.block_id=COALESCE(project.database_block_id,(SELECT binding.database_block_id FROM project_database_bindings binding WHERE binding.project_id=project.id AND binding.lifecycle='active')) \
         JOIN data_source_page_memberships member ON member.page_block_id=page.block_id AND member.data_source_id=source.id AND member.removed_at IS NULL \
         LEFT JOIN data_source_property_values status ON status.membership_id=member.id AND status.property_id='status' \
         LEFT JOIN page_read_model model ON model.page_block_id=page.block_id \
         LEFT JOIN block_properties work ON work.block_id=page.block_id AND work.property_key='work' AND work.value_type='json' \
         WHERE page.block_id=?2 ORDER BY project.id LIMIT 1",params![library_id,page_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||invalid("Work requires an active Page in an active Project's primary Database"))?;
    let sql = format!(
        "{} SELECT prerequisite_id,page_key,substr(title,1,512),status,satisfied,satisfying_revision,report_outcome,report_summary,report_at,report_revision,report_status_moved FROM facts ORDER BY prerequisite_id LIMIT 101",
        facts_cte()
    );
    let prerequisites = connection
        .prepare(&sql)?
        .query_map([json!([page_id]).to_string()], |r| {
            let outcome: Option<String> = r.get(6)?;
            Ok(PageWorkPrerequisite {
                page: DatabaseWorkPage {
                    page_id: r.get(0)?,
                    page_key: r.get(1)?,
                    title: r.get(2)?,
                    status: r.get(3)?,
                },
                satisfied: r.get(4)?,
                satisfying_revision: r.get(5)?,
                latest_report: outcome
                    .map(|outcome| -> rusqlite::Result<_> {
                        Ok(nodex_core_contracts::workspace::PageWorkReport {
                            status_moved: r.get(10)?,
                            outcome: serde_json::from_value(json!(outcome))
                                .map_err(|_| rusqlite::Error::InvalidQuery)?,
                            summary: r.get(7)?,
                            at: r.get(8)?,
                            revision: r.get(9)?,
                        })
                    })
                    .transpose()?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if prerequisites.len() > 100 {
        return Err(exhausted("Work brief exceeds 100 prerequisites"));
    }
    let page_work = page_work
        .map(|v| serde_json::from_str(&v).map_err(|_| invalid("Invalid Agent work")))
        .transpose()?
        .map(|v| crate::library::parse_page_work(&v))
        .transpose()?;
    let active_chat = connection
        .query_row(
            "SELECT session_id,revision,set_at FROM page_active_chats WHERE page_id=?1",
            [page_id],
            |r| {
                Ok(nodex_core_contracts::workspace::PageActiveChat {
                    session_id: r.get(0)?,
                    revision: r.get(1)?,
                    set_at: r.get(2)?,
                })
            },
        )
        .optional()?;
    let value = PageWorkContext {
        turn: crate::workspace::page_turn::turns(connection, &[page_id.into()])?.remove(0),
        active_chat,
        page: DatabaseWorkPage {
            page_id: page_id.into(),
            page_key: super::current_page_key_for_page(connection, library_id, page_id)?,
            title,
            status,
        },
        project_id,
        page_work,
        prerequisites,
    };
    if serde_json::to_vec(&value)
        .map_err(|_| invalid("Work context cannot be encoded"))?
        .len()
        > MAX_COLLECTION_WINDOW_JSON_BYTES
    {
        return Err(exhausted("Work context exceeds response byte budget"));
    }
    Ok(value)
}

/// Reuse Relation mutation and projection authority for a plan's freshly created cards.
pub(crate) fn initialize_prerequisites(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    targets: &[String],
    now: &str,
) -> Result<(), StoreError> {
    if targets.is_empty() {
        return Ok(());
    }
    let source: String = connection.query_row(
        "SELECT parent_id FROM pages WHERE block_id=?1 AND parent_kind='data_source'",
        [page_id],
        |r| r.get(0),
    )?;
    let result = super::relation::apply_value_edit(
        connection,
        library_id,
        None,
        &nodex_core_contracts::database::DatabasePagePropertyAddress {
            page_id: page_id.to_owned(),
            data_source_id: source,
            property_id: "blocked_by".into(),
        },
        super::relation::RelationValueEdit::PatchMany {
            add_page_ids: targets,
            remove_edge_ids: &[],
        },
        now,
    )?;
    super::synchronize_relation_value_projections(connection, &result.affected_values, None, now)?;
    Ok(())
}
