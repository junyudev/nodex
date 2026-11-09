//! Rebuildable, scope-bound Activity over committed product facts.
use super::problems::invalid;
#[cfg(test)]
#[path = "automation_activity_tests.rs"]
mod automation_activity_tests;
#[path = "activity_presentation.rs"]
mod presentation;
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue},
    sqlite::StoreError,
};
use nodex_core_contracts::{
    collection::{CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest},
    inbox::ProjectWorkspaceInboxScope,
    sources::*,
};
use rusqlite::{Connection, params};
pub(super) fn window(
    c: &Connection,
    library: &str,
    head: i64,
    scope: &ProjectWorkspaceInboxScope,
    filter: ActivityFilter,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ActivityRow>, StoreError> {
    let request = normalize_request(request)?;
    if let Some(project) = scope.project_id() {
        super::session_mutation::validate_id("project_id", project)?;
    }
    let fingerprint = cursor::query_fingerprint(&("activity_window_v2", scope, &filter))?;
    let subject = CollectionCursorSubject {
        kind: "activity",
        library_id: library,
        query_fingerprint: &fingerprint,
    };
    let after = request
        .after
        .map(|a| cursor::decode(c, a, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [
                KeysetValue::Text { value: at },
                KeysetValue::Text { value: id },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Invalid Activity cursor"));
            };
            if direction != CursorDirection::Forward {
                return Err(invalid("Invalid Activity cursor direction"));
            }
            Ok((at.clone(), id.clone()))
        })
        .transpose()?;
    let (at, id) = after.map_or((None, None), |(a, i)| (Some(a), Some(i)));
    let category = match filter {
        ActivityFilter::All => None,
        ActivityFilter::Messages => Some("messages"),
        ActivityFilter::Decisions => Some("decisions"),
        ActivityFilter::Problems => Some("problems"),
    };
    // Limit facts before hydrating their labels; Activity never scans every Page or chat.
    let rows = c.prepare(r#"
      WITH selected AS MATERIALIZED (
        SELECT * FROM activity_facts WHERE library_id=?1
          AND (?2 OR project_id IS ?3)
          -- A message Nodex or an Automation handled is also one of their decisions.
          AND (?4 IS NULL OR category=?4 OR (?4='decisions' AND category='messages'
            AND json_extract(actor_json,'$.type')<>'member'))
          AND (?5 IS NULL OR (at,id)<(?5,?6)) ORDER BY at DESC,id DESC LIMIT ?7
      )
      SELECT f.id,f.at,f.actor_json,f.description,f.reason,COALESCE(f.page_id,automation_run.page_id),COALESCE(f.session_id,automation_run.session_id),f.url,json_set(f.evidence_json,'$.thread',json(COALESCE(json_extract(f.evidence_json,'$.thread'),external.thread_json,'null'))),f.category,
        substr(model.title,1,512), prefix.normalized_prefix||'-'||assignment.number,
        substr(COALESCE(NULLIF(trim(thread.thread_name),''),session.no_thread_fallback_title),1,512), project.name,
        substr(COALESCE(NULLIF(trim(decision.automation_name),''),NULLIF(trim(json_extract(decision.frozen_action_json,'$.name')),''),automation.name),1,512),
        CASE
          WHEN f.id LIKE 'message:%' THEN (SELECT author_member_id FROM inbox_entries WHERE page_id=f.page_id)
          WHEN f.id LIKE 'launch:%' THEN (SELECT request.member_id FROM page_work_launches launch
            JOIN session_requesting_members request ON request.session_id=launch.session_id AND request.message_id=launch.message_id
            WHERE launch.launch_id=json_extract(f.evidence_json,'$.launch_id'))
        END
      FROM selected f
      LEFT JOIN automation_decisions decision ON decision.dispatch_id=COALESCE(
        json_extract(f.evidence_json,'$.decision_id'),json_extract(f.evidence_json,'$.action.decision_id'))
      LEFT JOIN automations automation ON automation.automation_id=decision.automation_id
      LEFT JOIN automation_execution_runs automation_run ON automation_run.run_id=(
        SELECT run_id FROM automation_execution_runs
        WHERE dispatch_id=decision.dispatch_id
        ORDER BY created_at,run_id LIMIT 1
      )
      LEFT JOIN external_threads external ON external.id=json_extract(f.evidence_json,'$.event.thread_id')
      LEFT JOIN pages page ON page.block_id=COALESCE(f.page_id,automation_run.page_id)
      LEFT JOIN document_materializations model ON model.document_id=page.document_id
      LEFT JOIN data_sources source ON page.parent_kind='data_source' AND source.id=page.parent_id
      LEFT JOIN page_key_prefixes prefix ON prefix.database_block_id=source.home_database_block_id
        AND prefix.library_id=page.library_id AND prefix.retired_at IS NULL
      LEFT JOIN page_key_assignments assignment ON assignment.database_block_id=source.home_database_block_id
        AND assignment.page_block_id=page.block_id
      LEFT JOIN project_sessions session ON session.id=COALESCE(f.session_id,automation_run.session_id)
      LEFT JOIN project_session_threads link ON link.session_id=session.id
      LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id
      LEFT JOIN projects project ON project.id=COALESCE(json_extract(f.evidence_json,'$.action.project_id'),f.project_id)
      ORDER BY f.at DESC,f.id DESC
    "#)?.query_map(params![library,matches!(scope,ProjectWorkspaceInboxScope::All),scope.project_id(),category,at,id,(request.first+1) as i64],row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    // A message fact carries its message as it stands now, read once per Page in the window.
    let messages = super::inbox_read::read_message_items(
        c,
        library,
        member,
        rows.iter()
            .filter(|(row, ..)| row.category == "messages")
            .filter_map(|(row, ..)| row.page_id.as_deref()),
    )?;
    // Wording relative to a person reads for this reader: "You", "your", or their name.
    let rows = rows
        .into_iter()
        .map(|(mut row, mut labels, requester)| {
            if row.category == "messages" {
                row.message = row
                    .page_id
                    .as_ref()
                    .and_then(|id| messages.get(id))
                    .cloned();
            }
            row.actor_label = format!(
                "by {}",
                crate::infrastructure::actors::label(c, &row.actor, member)?
            );
            labels.requester = requester
                .map(|requester| {
                    crate::infrastructure::actors::member_possessive(c, &requester, member)
                })
                .transpose()?;
            presentation::present(&mut row, &labels)?;
            Ok(row)
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble(
        rows.into_iter()
            .map(|item| WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![
                        KeysetValue::Text {
                            value: item.at.clone(),
                        },
                        KeysetValue::Text {
                            value: item.id.clone(),
                        },
                    ],
                    stable_id: item.id.clone(),
                },
                item,
            })
            .collect::<Vec<_>>(),
        request.first,
        CollectionWindowAuthority {
            projection_revision: head,
        },
        |coordinate| cursor::mint(c, subject, CursorDirection::Forward, coordinate.clone()),
    )
}

fn row(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(ActivityRow, presentation::Labels, Option<String>)> {
    let row = ActivityRow {
        id: r.get(0)?,
        at: r.get(1)?,
        actor: serde_json::from_str(&r.get::<_, String>(2)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        subject: None,
        description: r.get(3)?,
        reason: r.get(4)?,
        page_id: r.get(5)?,
        session_id: r.get(6)?,
        url: r.get(7)?,
        evidence: serde_json::from_str(&r.get::<_, String>(8)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        category: r.get(9)?,
        message: None,
    };
    let labels = presentation::Labels {
        page_title: r.get(10)?,
        page_key: r.get(11)?,
        chat_title: r.get(12)?,
        project_title: r.get(13)?,
        automation_name: r.get(14)?,
        requester: None,
    };
    Ok((row, labels, r.get(15)?))
}
