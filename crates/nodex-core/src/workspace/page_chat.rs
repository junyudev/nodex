use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspacePageChatActivitySummary,
    ProjectWorkspacePageChatItem, ProjectWorkspaceSessionExecutionRef,
    ProjectWorkspaceSessionLinkedPage, ProjectWorkspaceSessionLinkedPageStatus,
    ProjectWorkspaceSessionLinkedPageSummary, ProjectWorkspaceThreadStatus,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::finish_no_op;
use super::session_mutation::{
    SessionAuthority, SessionInvalidationKind, finish_session_mutation, sqlite_now, validate_id,
};

const MAX_INITIAL_PAGE_IDS: usize = 16;
const MAX_ACTIVITY_PAGE_IDS: usize = 200;
const MAX_LINKED_PAGE_SESSION_IDS: usize = 200;
/// Live status for Runtime-bound Sessions is read per Session outside Core; a Page reports at
/// most this many of its most recently updated ones.
const MAX_ACTIVITY_RUNTIME_SESSIONS: i64 = 32;

pub(super) fn validate_initial_page_ids(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<(), StoreError> {
    if page_ids.len() > MAX_INITIAL_PAGE_IDS {
        return Err(resource_exhausted(
            "Initial Linked chat Pages exceed the fixed bound",
        ));
    }
    if page_ids.is_empty() {
        return Ok(());
    }
    validate_page_ids(page_ids, MAX_INITIAL_PAGE_IDS)?;
    for page_id in page_ids {
        crate::library::require_page_read_access(connection, library_id, page_id)?;
    }
    Ok(())
}

pub(super) fn insert_initial_page_links(
    connection: &Connection,
    session_id: &str,
    page_ids: &[String],
    linked_at: &str,
) -> Result<(), StoreError> {
    for page_id in page_ids {
        let changed = connection.execute(
            "INSERT INTO project_session_pages(session_id, page_id, linked_at) \
             VALUES (?1, ?2, ?3)",
            params![session_id, page_id, linked_at],
        )?;
        if changed != 1 {
            return Err(corrupt("Initial Linked chat edge was not inserted"));
        }
    }
    Ok(())
}

/// Adds each Page to an existing Session's Linked chats as part of another decision; Pages
/// already linked stay as they are.
pub(crate) fn link_pages(
    connection: &Connection,
    session_id: &str,
    page_ids: &[String],
    linked_at: &str,
) -> Result<(), StoreError> {
    for page_id in page_ids {
        connection.execute(
            "INSERT OR IGNORE INTO project_session_pages(session_id, page_id, linked_at) \
             VALUES (?1, ?2, ?3)",
            params![session_id, page_id, linked_at],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn link_page(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    page_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_page_access(connection, library_id, page_id)?;
    if authority.archived {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Archived Project Sessions cannot add Linked chats",
            false,
        ));
    }
    let now = sqlite_now(connection)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM project_session_pages WHERE session_id = ?1 AND page_id = ?2",
            params![session_id, page_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "link_session_page",
            authority.project_id.iter().cloned().collect(),
            vec![session_id.to_owned()],
            &now,
        );
    }
    let changed = connection.execute(
        "INSERT INTO project_session_pages(session_id, page_id, linked_at) \
         VALUES (?1, ?2, ?3)",
        params![session_id, page_id, now],
    )?;
    if changed != 1 {
        return Err(corrupt("Linked chat edge was not inserted"));
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "link_session_page",
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn unlink_page(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    authority: &SessionAuthority,
    page_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_page_access(connection, library_id, page_id)?;
    let now = sqlite_now(connection)?;
    let changed = connection.execute(
        "DELETE FROM project_session_pages WHERE session_id = ?1 AND page_id = ?2",
        params![session_id, page_id],
    )?;
    if changed == 0 {
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "unlink_session_page",
            authority.project_id.iter().cloned().collect(),
            vec![session_id.to_owned()],
            &now,
        );
    }
    if changed != 1 {
        return Err(corrupt("Linked chat edge identity is not unique"));
    }
    finish_session_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "unlink_session_page",
        session_id,
        authority,
        authority.thread_id.iter().cloned().collect(),
        SessionInvalidationKind::SummaryAndDetail,
        now,
    )
}

/// Projects the earliest-linked readable, live Page, ordered by linked_at then Page ID.
/// Its Status may be absent; later Pages never supply a fallback Status. Session placement
/// and its Project do not grant content access; the bound Library and Block lifecycle do.
pub(super) fn read_session_linked_page_summaries(
    connection: &Connection,
    library_id: &str,
    session_ids: &[String],
) -> Result<Vec<ProjectWorkspaceSessionLinkedPageSummary>, StoreError> {
    if session_ids.len() > MAX_LINKED_PAGE_SESSION_IDS {
        return Err(resource_exhausted(
            "Session Linked Page request exceeds the fixed bound",
        ));
    }
    let mut unique = BTreeSet::new();
    for session_id in session_ids {
        validate_id("session_id", session_id)?;
        if !unique.insert(session_id) {
            return Err(invalid("Session IDs must be unique"));
        }
    }
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut parameters = vec![SqlValue::Text(library_id.to_owned())];
    let requested = session_ids
        .iter()
        .enumerate()
        .map(|(ordinal, session_id)| {
            parameters.push(SqlValue::Text(session_id.clone()));
            let id_parameter = parameters.len();
            parameters.push(SqlValue::Integer(ordinal as i64));
            format!("(?{id_parameter}, ?{})", parameters.len())
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "WITH requested(session_id, ordinal) AS (VALUES {requested}), \
         ranked_live_links AS ( \
           SELECT session.id AS session_id, requested.ordinal, page.block_id AS page_id, \
             ROW_NUMBER() OVER (PARTITION BY session.id \
               ORDER BY relation.linked_at, relation.page_id) AS link_order \
           FROM requested \
           JOIN project_sessions session ON session.id = requested.session_id AND session.archived = 0 \
             AND (session.project_id IS NULL OR EXISTS ( \
               SELECT 1 FROM projects project WHERE project.id = session.project_id \
                 AND project.library_id = ?1 AND project.lifecycle = 'active')) \
           JOIN project_session_pages relation ON relation.session_id = session.id \
           JOIN pages page ON page.block_id = relation.page_id AND page.library_id = ?1 \
           JOIN blocks block ON block.id = page.block_id AND block.library_id = ?1 \
             AND block.lifecycle = 'active' \
         ), earliest_linked_page AS ( \
           SELECT session_id, ordinal, page_id FROM ranked_live_links WHERE link_order = 1 \
         ) \
         SELECT earliest.session_id, page.block_id, model.title, \
           json_extract(option.value, '$.id'), json_extract(option.value, '$.name') \
         FROM earliest_linked_page earliest \
         JOIN pages page ON page.block_id = earliest.page_id \
         JOIN page_read_model model ON model.page_block_id = page.block_id AND model.library_id = ?1 \
         LEFT JOIN data_source_page_memberships membership \
           ON page.parent_kind = 'data_source' AND membership.data_source_id = page.parent_id \
             AND membership.page_block_id = page.block_id AND membership.removed_at IS NULL \
         LEFT JOIN data_source_properties property \
           ON property.data_source_id = membership.data_source_id AND property.id = 'status' \
             AND property.value_type = 'select' AND property.lifecycle = 'active' \
         LEFT JOIN data_source_property_values value \
           ON value.membership_id = membership.id AND value.data_source_id = membership.data_source_id \
             AND value.property_id = property.id AND value.value_type = 'select' \
         LEFT JOIN json_each(property.config_json, '$.options') option \
           ON json_extract(option.value, '$.id') = json_extract(value.value_json, '$') \
         ORDER BY earliest.ordinal"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(session_id, page_id, title, option_id, label)| {
            let page_key =
                crate::database::current_page_key_for_page(connection, library_id, &page_id)?;
            let status = option_id.zip(label).map(|(option_id, label)| {
                ProjectWorkspaceSessionLinkedPageStatus { option_id, label }
            });
            Ok(ProjectWorkspaceSessionLinkedPageSummary {
                session_id,
                page: ProjectWorkspaceSessionLinkedPage {
                    page_id,
                    page_key,
                    title,
                    status,
                },
            })
        })
        .collect()
}

pub(super) fn read_page_chat_activity_summaries(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<Vec<ProjectWorkspacePageChatActivitySummary>, StoreError> {
    if page_ids.len() > MAX_ACTIVITY_PAGE_IDS {
        return Err(resource_exhausted(
            "Page Chat activity request exceeds the fixed bound",
        ));
    }
    validate_page_ids(page_ids, MAX_ACTIVITY_PAGE_IDS)?;
    if page_ids.is_empty() {
        return Ok(Vec::new());
    }
    for page_id in page_ids {
        crate::library::require_page_read_access(connection, library_id, page_id)?;
    }

    let mut parameters = vec![SqlValue::Text(library_id.to_owned())];
    let requested_values = page_ids
        .iter()
        .enumerate()
        .map(|(ordinal, page_id)| {
            let page_parameter = parameters.len() + 1;
            parameters.push(SqlValue::Text(page_id.clone()));
            let ordinal_parameter = parameters.len() + 1;
            parameters.push(SqlValue::Integer(
                i64::try_from(ordinal).expect("Page Chat activity ordinal fits i64"),
            ));
            format!("(?{page_parameter}, ?{ordinal_parameter})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let has_approval = "EXISTS (SELECT 1 FROM json_each(thread.status_active_flags_json) flag \
      WHERE flag.value = 'waitingOnApproval')";
    let has_user_input = "EXISTS (SELECT 1 FROM json_each(thread.status_active_flags_json) flag \
      WHERE flag.value = 'waitingOnUserInput')";
    let active_thread = "thread.thread_id IS NOT NULL AND thread.archived = 0 \
      AND thread.status_type = 'active'";
    let sql = format!(
        "WITH requested(page_id, ordinal) AS (VALUES {requested_values}) \
         SELECT requested.page_id, \
           COUNT(session.id) AS related_count, \
           COALESCE(SUM(CASE WHEN {active_thread} \
             AND NOT ({has_approval}) AND NOT ({has_user_input}) THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN {active_thread} AND {has_approval} THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN {active_thread} AND {has_user_input} THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN thread.thread_id IS NOT NULL AND thread.archived = 0 \
             AND thread.status_type = 'systemError' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN session.id IS NOT NULL AND session.unread = 1 \
             THEN 1 ELSE 0 END), 0), \
           CASE WHEN COUNT(session.id) = 1 THEN MIN(session.id) ELSE NULL END \
         FROM requested \
         JOIN pages page ON page.block_id = requested.page_id AND page.library_id = ?1 \
         LEFT JOIN project_session_pages relation ON relation.page_id = page.block_id \
         LEFT JOIN project_sessions session \
           ON session.id = relation.session_id AND session.archived = 0 \
           AND (session.project_id IS NULL OR EXISTS ( \
             SELECT 1 FROM projects owner \
             WHERE owner.id = session.project_id AND owner.library_id = ?1 \
           )) \
         LEFT JOIN project_session_threads session_thread ON session_thread.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = session_thread.thread_id \
         GROUP BY requested.page_id, requested.ordinal \
         ORDER BY requested.ordinal"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != page_ids.len() {
        return Err(not_found("One or more Pages are unavailable"));
    }
    let mut runtime_sessions = read_runtime_session_ids(connection, library_id, page_ids)?;
    rows.into_iter()
        .map(
            |(
                page_id,
                related_count,
                working_count,
                waiting_on_approval_count,
                waiting_on_user_input_count,
                error_count,
                unread_count,
                sole_session_id,
            )| {
                Ok(ProjectWorkspacePageChatActivitySummary {
                    runtime_session_ids: runtime_sessions.remove(&page_id).unwrap_or_default(),
                    page_id,
                    related_count: bounded_count(related_count)?,
                    working_count: bounded_count(working_count)?,
                    waiting_on_approval_count: bounded_count(waiting_on_approval_count)?,
                    waiting_on_user_input_count: bounded_count(waiting_on_user_input_count)?,
                    error_count: bounded_count(error_count)?,
                    unread_count: bounded_count(unread_count)?,
                    sole_session_id,
                })
            },
        )
        .collect()
}

/// Runtime-bound linked Sessions per Page, most recently updated first and bounded per Page.
fn read_runtime_session_ids(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<BTreeMap<String, Vec<String>>, StoreError> {
    let mut parameters = vec![
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(MAX_ACTIVITY_RUNTIME_SESSIONS),
    ];
    let requested_values = page_ids
        .iter()
        .map(|page_id| {
            parameters.push(SqlValue::Text(page_id.clone()));
            format!("(?{})", parameters.len())
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "WITH requested(page_id) AS (VALUES {requested_values}), \
         ranked AS ( \
           SELECT relation.page_id, session.id AS session_id, \
             ROW_NUMBER() OVER ( \
               PARTITION BY relation.page_id ORDER BY session.updated_at DESC, session.id \
             ) AS rank \
           FROM requested \
           JOIN project_session_pages relation ON relation.page_id = requested.page_id \
           JOIN project_sessions session \
             ON session.id = relation.session_id AND session.archived = 0 \
             AND (session.project_id IS NULL OR EXISTS ( \
               SELECT 1 FROM projects owner \
               WHERE owner.id = session.project_id AND owner.library_id = ?1 \
             )) \
           JOIN project_session_execution_bindings binding ON binding.session_id = session.id \
         ) \
         SELECT page_id, session_id FROM ranked WHERE rank <= ?2 ORDER BY page_id, rank"
    );
    let mut sessions = BTreeMap::<String, Vec<String>>::new();
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (page_id, session_id) in rows {
        sessions.entry(page_id).or_default().push(session_id);
    }
    Ok(sessions)
}

pub(super) fn read_page_chat_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    page_id: &str,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspacePageChatItem>, StoreError> {
    require_page_access(connection, library_id, page_id)?;
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("workspace_page_chat_window_v3", page_id, include_archived))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_page_chats",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 3 {
                return Err(invalid("Page Chat cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: recency_null,
                },
                KeysetValue::Integer {
                    value: recency_order,
                },
                KeysetValue::Text { value: linked_at },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Page Chat cursor coordinate is invalid"));
            };
            Ok((
                *recency_null,
                *recency_order,
                linked_at.clone(),
                coordinate.stable_id,
            ))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(page_id.to_owned()),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(include_archived)),
    ];
    let cursor_predicate = coordinate
        .map(|(recency_null, recency_order, linked_at, stable_id)| {
            parameters.extend([
                SqlValue::Integer(recency_null),
                SqlValue::Integer(recency_order),
                SqlValue::Text(linked_at),
                SqlValue::Text(stable_id),
            ]);
            "AND (chat.recency_null > ?4 \
              OR (chat.recency_null = ?4 AND chat.recency_order > ?5) \
              OR (chat.recency_null = ?4 AND chat.recency_order = ?5 AND chat.linked_at < ?6) \
              OR (chat.recency_null = ?4 AND chat.recency_order = ?5 AND chat.linked_at = ?6 \
                AND chat.session_id > ?7))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Page Chat window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    // A Runtime-bound Session has no native thread recency; its Session recency orders it.
    let sql = format!(
        "SELECT * FROM ( \
           SELECT session.id AS session_id, session.project_id, project.name, \
             session.no_thread_fallback_title, thread.thread_id, thread.thread_name, \
             COALESCE(substr(thread.thread_preview, 1, 1024), ''), thread.status_type, \
             thread.status_active_flags_json, COALESCE(thread.archived, 0), session.unread, \
             session.archived, \
             COALESCE(thread.recency_at, CASE WHEN binding.session_id IS NOT NULL \
               THEN unixepoch(session.updated_at) * 1000 END) AS conversation_recency_at, \
             relation.linked_at AS linked_at, \
             CASE WHEN thread.thread_id IS NULL AND binding.session_id IS NULL \
               THEN 1 ELSE 0 END AS recency_null, \
             -COALESCE(thread.recency_at, CASE WHEN binding.session_id IS NOT NULL \
               THEN unixepoch(session.updated_at) * 1000 END, 0) AS recency_order, \
             binding.runtime_id, binding.runtime_thread_id \
           FROM project_session_pages relation \
           JOIN pages page ON page.block_id = relation.page_id AND page.library_id = ?2 \
           JOIN project_sessions session ON session.id = relation.session_id \
           LEFT JOIN projects project ON project.id = session.project_id \
           LEFT JOIN project_session_threads session_thread \
             ON session_thread.session_id = session.id \
           LEFT JOIN codex_threads thread ON thread.thread_id = session_thread.thread_id \
           LEFT JOIN project_session_execution_bindings binding \
             ON binding.session_id = session.id \
           WHERE relation.page_id = ?1 \
             AND (session.project_id IS NULL OR project.library_id = ?2) \
             AND (?3 = 1 OR session.archived = 0) \
         ) chat \
         WHERE 1 = 1 {cursor_predicate} \
         ORDER BY chat.recency_null, chat.recency_order, chat.linked_at DESC, chat.session_id \
         LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), page_chat_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows.into_iter().map(|row| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![
                KeysetValue::Integer {
                    value: row.recency_null,
                },
                KeysetValue::Integer {
                    value: row.recency_order,
                },
                KeysetValue::Text {
                    value: row.item.linked_at.clone(),
                },
            ],
            stable_id: row.item.session_id.clone(),
        },
        item: row.item,
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

struct PageChatRow {
    item: ProjectWorkspacePageChatItem,
    recency_null: i64,
    recency_order: i64,
}

fn page_chat_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PageChatRow> {
    let native_thread_id = row.get::<_, Option<String>>(4)?;
    let execution_ref = match (
        row.get::<_, Option<String>>(16)?,
        row.get::<_, Option<String>>(17)?,
    ) {
        (Some(runtime_id), Some(thread_id)) => Some(ProjectWorkspaceSessionExecutionRef {
            runtime_id,
            thread_id,
        }),
        _ => None,
    };
    let status = native_thread_id
        .as_ref()
        .map(|_| -> rusqlite::Result<ProjectWorkspaceThreadStatus> {
            let status_type = match row.get::<_, String>(7)?.as_str() {
                "notLoaded" => Ok(CodexThreadStatusType::NotLoaded),
                "idle" => Ok(CodexThreadStatusType::Idle),
                "systemError" => Ok(CodexThreadStatusType::SystemError),
                "active" => Ok(CodexThreadStatusType::Active),
                _ => Err(rusqlite::Error::InvalidQuery),
            }?;
            let active_flags =
                serde_json::from_str::<Vec<CodexThreadActiveFlag>>(&row.get::<_, String>(8)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(ProjectWorkspaceThreadStatus {
                status_type,
                active_flags,
            })
        })
        .transpose()?;
    let fallback_title = row.get::<_, String>(3)?;
    let thread_preview = super::task_window::bounded_preview(&row.get::<_, String>(6)?);
    let display_title = super::read::project_session_display_title(
        row.get::<_, Option<String>>(5)?.as_deref(),
        native_thread_id.as_ref().map(|_| thread_preview.as_str()),
        &fallback_title,
    );
    let thread_id = native_thread_id.or_else(|| {
        execution_ref
            .as_ref()
            .map(|reference| reference.thread_id.clone())
    });
    Ok(PageChatRow {
        item: ProjectWorkspacePageChatItem {
            session_id: row.get(0)?,
            project_id: row.get(1)?,
            project_name: row.get(2)?,
            display_title,
            thread_id,
            execution_ref,
            thread_preview,
            status,
            thread_archived: row.get::<_, i64>(9)? == 1,
            unread: row.get::<_, i64>(10)? == 1,
            session_archived: row.get::<_, i64>(11)? == 1,
            conversation_recency_at: row.get(12)?,
            linked_at: row.get(13)?,
        },
        recency_null: row.get(14)?,
        recency_order: row.get(15)?,
    })
}

fn require_page_access(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    validate_id("page_id", page_id)?;
    crate::library::require_page_read_access(connection, library_id, page_id)
}

fn validate_page_ids(page_ids: &[String], maximum: usize) -> Result<(), StoreError> {
    if page_ids.len() > maximum {
        return Err(resource_exhausted("Page identity batch exceeds its bound"));
    }
    let mut unique = BTreeSet::new();
    for page_id in page_ids {
        validate_id("page_id", page_id)?;
        if !unique.insert(page_id) {
            return Err(invalid("Page IDs must be unique"));
        }
    }
    Ok(())
}

fn bounded_count(value: i64) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| corrupt("Page Chat activity count exceeds u32"))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn resource_exhausted(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::collection::CollectionWindowRequest;
    use nodex_core_contracts::workspace::{
        CodexThreadActiveFlag, CodexThreadStatusType, ProjectSessionIntent, ProjectWorkspaceIntent,
        ProjectWorkspaceRead, ProjectWorkspaceReadValue, ProjectWorkspaceThreadPatch,
        ProjectWorkspaceThreadStatus,
    };
    use nodex_core_contracts::{
        CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
    };

    use super::MAX_ACTIVITY_PAGE_IDS;
    use crate::workspace::test_support::{
        apply, context, create_library_page, create_project, read, request, seeded_workspace,
    };

    fn create_page_session(
        workspace: &crate::workspace::test_support::TestWorkspace,
        operation_id: &str,
        session_id: &str,
        page_id: &str,
    ) {
        apply(
            &workspace.module,
            operation_id,
            ProjectWorkspaceIntent::CreateSession {
                session_id: session_id.to_owned(),
                project_id: Some("project:default".to_owned()),
                title: session_id.to_owned(),
                initial_page_ids: vec![page_id.to_owned()],
            },
        );
    }

    #[test]
    fn creates_session_and_initial_page_edges_atomically() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:related", "project:default");

        let outcome = workspace
            .module
            .apply(
                &context(),
                request(
                    "create-page-chat",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session:page-chat".to_owned(),
                        project_id: Some("project:default".to_owned()),
                        title: "Page chat".to_owned(),
                        initial_page_ids: vec!["page:related".to_owned()],
                    },
                ),
            )
            .expect("atomic Page-backed Session create");
        assert!(outcome.event.is_some());
        let stored = workspace
            .kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT count(*) FROM project_sessions WHERE id = 'session:page-chat'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT count(*) FROM project_session_pages \
                         WHERE session_id = 'session:page-chat' AND page_id = 'page:related'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read atomic records");
        assert_eq!(stored, (1, 1));

        create_project(&workspace.module, "create-other-project", "project:other");
        create_library_page(&workspace, "page:other", "project:other");
        apply(
            &workspace.module,
            "create-cross-project-page-chat",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:cross-project".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "Cross Project Pages".to_owned(),
                initial_page_ids: vec!["page:related".to_owned(), "page:other".to_owned()],
            },
        );
        let cross_project_edges = workspace.kernel.readers().read_default(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id = 'session:cross-project'", [], |row| row.get::<_, i64>(0))?)
        }).expect("cross Project edges");
        assert_eq!(cross_project_edges, 2);
        let error = workspace
            .module
            .apply(
                &context(),
                request(
                    "reject-page-chat",
                    ProjectWorkspaceIntent::CreateSession {
                        session_id: "session:must-rollback".to_owned(),
                        project_id: Some("project:default".to_owned()),
                        title: "Must roll back".to_owned(),
                        initial_page_ids: vec![
                            "page:related".to_owned(),
                            "page:missing".to_owned(),
                        ],
                    },
                ),
            )
            .expect_err("reject missing initial Page");
        assert_eq!(error.code, CoreErrorCode::NotFound);
        let rolled_back = workspace
            .kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT count(*) FROM project_sessions \
                         WHERE id = 'session:must-rollback'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT count(*) FROM project_session_pages \
                         WHERE session_id = 'session:must-rollback'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read rolled-back records");
        assert_eq!(rolled_back, (0, 0));
    }

    #[test]
    fn projects_orthogonal_execution_unread_and_windowed_related_chats() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:activity", "project:default");
        create_page_session(
            &workspace,
            "create-working-chat",
            "session:working",
            "page:activity",
        );
        apply(
            &workspace.module,
            "create-working-thread",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:working".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(Some("project:default".to_owned())),
                    thread_name: Some(Some("Working chat".to_owned())),
                    thread_preview: Some("Working preview".to_owned()),
                    status: Some(ProjectWorkspaceThreadStatus {
                        status_type: CodexThreadStatusType::Active,
                        active_flags: Vec::new(),
                    }),
                    created_at: Some(10),
                    updated_at: Some(10),
                    recency_at: Some(10),
                    linked_at: Some("2026-07-19T06:01:00.000Z".to_owned()),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        apply(
            &workspace.module,
            "link-working-thread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:working".to_owned(),
                intent: ProjectSessionIntent::LinkThread {
                    thread_id: "thread:working".to_owned(),
                    expected_project_id: Some("project:default".to_owned()),
                    thread_patch: None,
                    execution_location: None,
                },
            },
        );
        apply(
            &workspace.module,
            "mark-working-unread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:working".to_owned(),
                intent: ProjectSessionIntent::SetUnread { unread: true },
            },
        );
        create_page_session(
            &workspace,
            "create-threadless-chat",
            "session:threadless",
            "page:activity",
        );

        let ProjectWorkspaceReadValue::PageChatActivitySummaries {
            summaries,
            projection_revision,
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: vec!["page:activity".to_owned()],
            },
        )
        else {
            panic!("Page Chat activity summaries");
        };
        assert!(projection_revision > 0);
        assert_eq!(summaries[0].related_count, 2);
        assert_eq!(summaries[0].working_count, 1);
        assert_eq!(summaries[0].unread_count, 1);
        assert_eq!(summaries[0].sole_session_id, None);

        let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatWindow {
                page_id: "page:activity".to_owned(),
                include_archived: Some(false),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(1),
                },
            },
        ) else {
            panic!("Page Chat window");
        };
        assert_eq!(chats.items.len(), 1);
        assert_eq!(chats.items[0].session_id, "session:working");
        assert_eq!(chats.items[0].display_title, "Working chat");
        assert!(chats.items[0].unread);
        let next_cursor = chats.next_cursor.expect("second Linked chat page");
        let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatWindow {
                page_id: "page:activity".to_owned(),
                include_archived: Some(false),
                window: CollectionWindowRequest {
                    after: Some(next_cursor),
                    first: Some(1),
                },
            },
        ) else {
            panic!("Page Chat continuation");
        };
        assert_eq!(chats.items.len(), 1);
        assert_eq!(chats.items[0].session_id, "session:threadless");
        assert!(chats.items[0].thread_id.is_none());

        apply(
            &workspace.module,
            "wait-on-working-thread",
            ProjectWorkspaceIntent::UpdateThread {
                thread_id: "thread:working".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    status: Some(ProjectWorkspaceThreadStatus {
                        status_type: CodexThreadStatusType::Active,
                        active_flags: vec![
                            CodexThreadActiveFlag::WaitingOnApproval,
                            CodexThreadActiveFlag::WaitingOnUserInput,
                        ],
                    }),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: vec!["page:activity".to_owned()],
            },
        ) else {
            panic!("waiting Page Chat activity");
        };
        assert_eq!(summaries[0].working_count, 0);
        assert_eq!(summaries[0].waiting_on_approval_count, 1);
        assert_eq!(summaries[0].waiting_on_user_input_count, 1);
        assert_eq!(summaries[0].unread_count, 1);

        apply(
            &workspace.module,
            "detach-working-thread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:working".to_owned(),
                intent: ProjectSessionIntent::UnlinkThread {
                    thread_id: "thread:working".to_owned(),
                },
            },
        );
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: vec!["page:activity".to_owned()],
            },
        ) else {
            panic!("threadless Page Chat activity");
        };
        assert_eq!(summaries[0].related_count, 2);
        assert_eq!(summaries[0].working_count, 0);
        assert_eq!(summaries[0].waiting_on_approval_count, 0);
        assert_eq!(summaries[0].waiting_on_user_input_count, 0);
        assert_eq!(summaries[0].unread_count, 1);

        let linked_at = workspace
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT linked_at FROM project_session_pages \
                         WHERE session_id = 'session:working' AND page_id = 'page:activity'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Into::into)
            })
            .expect("Linked chat timestamp");
        let duplicate = workspace
            .module
            .apply(
                &context(),
                request(
                    "duplicate-page-link",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "session:working".to_owned(),
                        intent: ProjectSessionIntent::LinkPage {
                            page_id: "page:activity".to_owned(),
                        },
                    },
                ),
            )
            .expect("idempotent Page link");
        assert!(duplicate.event.is_none());
        let stable_linked_at = workspace
            .kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT linked_at FROM project_session_pages \
                         WHERE session_id = 'session:working' AND page_id = 'page:activity'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Into::into)
            })
            .expect("stable Linked chat timestamp");
        assert_eq!(stable_linked_at, linked_at);

        apply(
            &workspace.module,
            "archive-threadless-chat",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:threadless".to_owned(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        apply(
            &workspace.module,
            "unlink-archived-chat",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:threadless".to_owned(),
                intent: ProjectSessionIntent::UnlinkPage {
                    page_id: "page:activity".to_owned(),
                },
            },
        );
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: vec!["page:activity".to_owned()],
            },
        ) else {
            panic!("single Page Chat activity");
        };
        assert_eq!(summaries[0].related_count, 1);
        assert_eq!(
            summaries[0].sole_session_id.as_deref(),
            Some("session:working")
        );
    }

    #[test]
    fn lists_runtime_sessions_by_session_recency_with_their_execution_root() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:runtime", "project:default");
        create_page_session(
            &workspace,
            "create-threadless-chat",
            "session:threadless",
            "page:runtime",
        );
        create_page_session(
            &workspace,
            "create-native-chat",
            "session:native",
            "page:runtime",
        );
        apply(
            &workspace.module,
            "create-native-thread",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:native".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(Some("project:default".to_owned())),
                    thread_name: Some(Some("Native chat".to_owned())),
                    thread_preview: Some("Native preview".to_owned()),
                    created_at: Some(10),
                    updated_at: Some(10),
                    recency_at: Some(10),
                    linked_at: Some("2026-07-19T06:01:00.000Z".to_owned()),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        apply(
            &workspace.module,
            "link-native-thread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:native".to_owned(),
                intent: ProjectSessionIntent::LinkThread {
                    thread_id: "thread:native".to_owned(),
                    expected_project_id: Some("project:default".to_owned()),
                    thread_patch: None,
                    execution_location: None,
                },
            },
        );
        apply(
            &workspace.module,
            "launch-runtime-chat",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                side_chat_source_session_id: None,
                session_id: "session:runtime".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "Runtime chat".to_owned(),
                initial_page_ids: vec!["page:runtime".to_owned()],
                runtime_id: "runtime:primary".to_owned(),
                runtime_thread_id: "root:runtime".to_owned(),
                launch_request_id: "launch:runtime".to_owned(),
            },
        );

        let window = |after: Option<String>| {
            let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
                &workspace.module,
                ProjectWorkspaceRead::PageChatWindow {
                    page_id: "page:runtime".to_owned(),
                    include_archived: Some(false),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(1),
                    },
                },
            ) else {
                panic!("Page Chat window");
            };
            chats
        };
        let first = window(None);
        let runtime = &first.items[0];
        assert_eq!(runtime.session_id, "session:runtime");
        assert_eq!(runtime.display_title, "Runtime chat");
        assert_eq!(runtime.thread_id.as_deref(), Some("root:runtime"));
        assert_eq!(
            runtime
                .execution_ref
                .as_ref()
                .map(|reference| (reference.runtime_id.as_str(), reference.thread_id.as_str())),
            Some(("runtime:primary", "root:runtime"))
        );
        assert!(runtime.status.is_none());
        assert!(
            runtime
                .conversation_recency_at
                .is_some_and(|recency| recency > 10)
        );
        let second = window(first.next_cursor.clone());
        assert_eq!(second.items[0].session_id, "session:native");
        assert!(second.items[0].execution_ref.is_none());
        let third = window(second.next_cursor.clone());
        assert_eq!(third.items[0].session_id, "session:threadless");
        assert!(third.items[0].thread_id.is_none());
        assert!(third.next_cursor.is_none());

        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: vec!["page:runtime".to_owned()],
            },
        ) else {
            panic!("Page Chat activity summaries");
        };
        assert_eq!(summaries[0].related_count, 3);
        assert_eq!(summaries[0].runtime_session_ids, vec!["session:runtime"]);
    }

    #[test]
    fn rejects_ambiguous_unbounded_or_missing_page_reads() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:bounded", "project:default");
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_ids: Vec::new(),
            },
        ) else {
            panic!("empty Page Chat batch");
        };
        assert!(summaries.is_empty());
        for page_ids in [
            vec!["page:bounded".to_owned(), "page:bounded".to_owned()],
            vec![" ".to_owned()],
        ] {
            let error = workspace
                .module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::PageChatActivitySummaries { page_ids },
                    },
                )
                .expect_err("invalid Page Chat batch");
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
        }
        let error = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::PageChatActivitySummaries {
                        page_ids: (0..=MAX_ACTIVITY_PAGE_IDS)
                            .map(|index| format!("page:{index}"))
                            .collect(),
                    },
                },
            )
            .expect_err("bounded Page Chat batch");
        assert_eq!(error.code, CoreErrorCode::ResourceExhausted);
        let error = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::PageChatWindow {
                        page_id: "page:missing".to_owned(),
                        include_archived: Some(false),
                        window: CollectionWindowRequest::default(),
                    },
                },
            )
            .expect_err("missing Page Chat window");
        assert_eq!(error.code, CoreErrorCode::NotFound);
    }

    fn library_apply(
        workspace: &crate::workspace::test_support::TestWorkspace,
        operation_id: &str,
        intent: nodex_core_contracts::library::LibraryIntent,
    ) {
        crate::library::LibraryModule::new("profile-1", "library-1", &workspace.kernel)
            .apply(
                &context(),
                nodex_core_contracts::ModuleApplyRequest {
                    contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".to_owned()),
                    intent,
                },
            )
            .expect("Library mutation");
    }

    fn database_apply(
        workspace: &crate::workspace::test_support::TestWorkspace,
        operation_id: &str,
        intent: nodex_core_contracts::database::DatabaseIntent,
    ) {
        crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel)
            .apply(
                &context(),
                nodex_core_contracts::ModuleApplyRequest {
                    contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".to_owned()),
                    intent: vec![intent],
                },
            )
            .expect("Database mutation");
    }

    fn linked_pages(
        workspace: &crate::workspace::test_support::TestWorkspace,
        session_ids: &[&str],
    ) -> Vec<nodex_core_contracts::workspace::ProjectWorkspaceSessionLinkedPageSummary> {
        let ProjectWorkspaceReadValue::SessionLinkedPageSummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::SessionLinkedPageSummaries {
                session_ids: session_ids.iter().map(|id| (*id).to_owned()).collect(),
            },
        ) else {
            panic!("Session Linked Page summaries");
        };
        summaries
    }

    #[test]
    fn linked_page_summary_selects_earliest_live_page_for_active_sessions() {
        use nodex_core_contracts::library::{LibraryIntent, LibraryPageLifecycleMutation};
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:one", "project:default");
        create_library_page(&workspace, "page:two", "project:default");
        create_page_session(&workspace, "create-single", "session:single", "page:one");
        apply(
            &workspace.module,
            "create-zero",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:zero".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "No links".to_owned(),
                initial_page_ids: vec![],
            },
        );
        apply(
            &workspace.module,
            "create-many",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:many".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "Many links".to_owned(),
                // Same-operation links use Page ID order, regardless of request order.
                initial_page_ids: vec!["page:two".to_owned(), "page:one".to_owned()],
            },
        );
        let summaries = linked_pages(
            &workspace,
            &[
                "session:zero",
                "session:single",
                "session:many",
                "session:missing",
            ],
        );
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].session_id, "session:single");
        assert_eq!(summaries[1].session_id, "session:many");
        assert_eq!(summaries[0].page, summaries[1].page);
        assert_eq!(summaries[0].page.page_id, "page:one");
        assert_eq!(summaries[0].page.title, "page:one");
        assert_eq!(summaries[0].page.page_key, None);
        assert_eq!(summaries[0].page.status, None);

        library_apply(
            &workspace,
            "archive-one",
            LibraryIntent::ApplyPageLifecycle {
                mutation: Box::new(LibraryPageLifecycleMutation::ArchivePage {
                    page_id: "page:one".to_owned(),
                    expected_metadata_revision: 1,
                }),
            },
        );
        assert_eq!(
            linked_pages(&workspace, &["session:many"])[0].page.page_id,
            "page:two"
        );
        assert!(linked_pages(&workspace, &["session:single"]).is_empty());
        library_apply(
            &workspace,
            "unarchive-one",
            LibraryIntent::ApplyPageLifecycle {
                mutation: Box::new(LibraryPageLifecycleMutation::UnarchivePage {
                    page_id: "page:one".to_owned(),
                    expected_metadata_revision: 2,
                }),
            },
        );
        assert_eq!(
            linked_pages(&workspace, &["session:many"])[0].page.page_id,
            "page:one"
        );
        apply(
            &workspace.module,
            "archive-single",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:single".to_owned(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        assert!(linked_pages(&workspace, &["session:single"]).is_empty());
        library_apply(
            &workspace,
            "delete-one",
            LibraryIntent::ApplyPageLifecycle {
                mutation: Box::new(LibraryPageLifecycleMutation::DeletePage {
                    page_id: "page:one".to_owned(),
                    expected_metadata_revision: 3,
                    expected_parent_revision: 1,
                    parent_document_head: None,
                }),
            },
        );
        assert_eq!(
            linked_pages(&workspace, &["session:many"])[0].page.page_id,
            "page:two"
        );
        for lifecycle in [
            nodex_core_contracts::workspace::ProjectLifecycle::Inactive,
            nodex_core_contracts::workspace::ProjectLifecycle::Archived,
        ] {
            apply(
                &workspace.module,
                &format!("set-project-{lifecycle:?}"),
                ProjectWorkspaceIntent::SetProjectLifecycle {
                    project_id: "project:default".to_owned(),
                    lifecycle,
                },
            );
            assert!(linked_pages(&workspace, &["session:many"]).is_empty());
        }
    }

    #[test]
    fn linked_page_summary_orders_by_link_time_before_page_id_and_advances_on_unlink() {
        let workspace = seeded_workspace();
        for page_id in ["page:a", "page:z"] {
            create_library_page(&workspace, page_id, "project:default");
        }
        apply(
            &workspace.module,
            "create-ordered",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:ordered".to_owned(),
                project_id: None,
                title: "Ordered links".to_owned(),
                initial_page_ids: vec![],
            },
        );
        // Exact edge timestamps distinguish chronological order from the Page-ID tie-break.
        workspace
            .kernel
            .writer()
            .call(|connection| {
                super::link_pages(
                    connection,
                    "session:ordered",
                    &["page:z".to_owned()],
                    "2026-07-19T06:00:00.000Z",
                )?;
                super::link_pages(
                    connection,
                    "session:ordered",
                    &["page:a".to_owned()],
                    "2026-07-19T06:01:00.000Z",
                )
            })
            .expect("timestamped Linked chat edges");
        assert_eq!(
            linked_pages(&workspace, &["session:ordered"])[0]
                .page
                .page_id,
            "page:z"
        );
        apply(
            &workspace.module,
            "unlink-earliest",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:ordered".to_owned(),
                intent: ProjectSessionIntent::UnlinkPage {
                    page_id: "page:z".to_owned(),
                },
            },
        );
        assert_eq!(
            linked_pages(&workspace, &["session:ordered"])[0]
                .page
                .page_id,
            "page:a"
        );
    }

    #[test]
    fn linked_page_summary_uses_current_keys_and_status_option_registry() {
        use nodex_core_contracts::database::{
            DatabaseIntent, DatabasePagePropertyAddress, DatabasePropertySchema,
            DatabasePropertyValueEdit, DatabasePropertyValueInput, DatabasePropertyValueMutation,
            DatabaseTransferTarget,
        };
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "create-lab",
            ProjectWorkspaceIntent::CreateProject {
                project_id: "project:lab".to_owned(),
                name: "Lab".to_owned(),
                description: String::new(),
                appearance: None,
                source_roots: vec!["/workspace/lab".to_owned()],
                page_key_prefix: Some("LAB".to_owned()),
            },
        );
        let (database_id, data_source_id) = workspace.kernel.readers().read_default(|connection| {
            Ok(connection.query_row("SELECT project.database_block_id, source.id FROM projects project JOIN data_sources source ON source.home_database_block_id = project.database_block_id WHERE project.id = 'project:lab'", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?)
        }).expect("Project Database coordinates");
        create_library_page(&workspace, "page:work", "project:default");
        create_page_session(&workspace, "create-work-chat", "session:work", "page:work");
        assert_eq!(
            linked_pages(&workspace, &["session:work"])[0].page.status,
            None
        );
        database_apply(
            &workspace,
            "move-work",
            DatabaseIntent::TransferPage {
                page_id: "page:work".to_owned(),
                expected_parent_revision: 1,
                expected_active_membership_revision: 0,
                target: DatabaseTransferTarget::DataSource {
                    data_source_id: data_source_id.clone(),
                },
            },
        );
        let in_source = linked_pages(&workspace, &["session:work"]);
        assert_eq!(in_source[0].page.page_key.as_deref(), Some("LAB-1"));
        create_library_page(&workspace, "page:z-later", "project:default");
        database_apply(
            &workspace,
            "move-later",
            DatabaseIntent::TransferPage {
                page_id: "page:z-later".to_owned(),
                expected_parent_revision: 1,
                expected_active_membership_revision: 0,
                target: DatabaseTransferTarget::DataSource {
                    data_source_id: data_source_id.clone(),
                },
            },
        );
        apply(
            &workspace.module,
            "link-later",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:work".to_owned(),
                intent: ProjectSessionIntent::LinkPage {
                    page_id: "page:z-later".to_owned(),
                },
            },
        );
        create_page_session(
            &workspace,
            "create-later-chat",
            "session:later",
            "page:z-later",
        );
        assert!(
            linked_pages(&workspace, &["session:later"])[0]
                .page
                .status
                .is_some()
        );
        let value_revision = workspace.kernel.readers().read_default(|connection| {
            Ok(connection.query_row("SELECT value.revision FROM data_source_property_values value JOIN data_source_page_memberships membership ON membership.id = value.membership_id WHERE membership.page_block_id = 'page:work' AND value.property_id = 'status'", [], |row| row.get::<_, i64>(0))?)
        }).expect("current Status value revision");
        database_apply(
            &workspace,
            "set-build",
            DatabaseIntent::EditPropertyValues {
                edits: vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id: "page:work".to_owned(),
                        data_source_id: data_source_id.clone(),
                        property_id: "status".to_owned(),
                    },
                    edit: DatabasePropertyValueEdit::Replace {
                        expected_value_revision: value_revision,
                        value: DatabasePropertyValueInput::Select {
                            option_id: "build".to_owned(),
                        },
                    },
                }],
            },
        );
        database_apply(
            &workspace,
            "rename-status-property",
            DatabaseIntent::PutProperty {
                data_source_id: data_source_id.clone(),
                property_id: "status".to_owned(),
                expected_data_source_revision: 1,
                expected_property_revision: 1,
                name: "Progress".to_owned(),
                schema: DatabasePropertySchema::Select,
                before_property_id: None,
            },
        );
        database_apply(
            &workspace,
            "rename-build",
            DatabaseIntent::PutOption {
                data_source_id: data_source_id.clone(),
                property_id: "status".to_owned(),
                option_id: "build".to_owned(),
                name: "In progress".to_owned(),
                color: None,
                expected_property_revision: 2,
            },
        );
        let summary = linked_pages(&workspace, &["session:work"]);
        assert_eq!(summary[0].page.page_id, "page:work");
        assert_eq!(
            summary[0]
                .page
                .status
                .as_ref()
                .map(|status| (status.option_id.as_str(), status.label.as_str())),
            Some(("build", "In progress"))
        );
        create_library_page(&workspace, "page:notes", "project:default");
        apply(
            &workspace.module,
            "create-notes-chat",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:notes".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "Notes first".to_owned(),
                initial_page_ids: vec!["page:work".to_owned(), "page:notes".to_owned()],
            },
        );
        let notes = linked_pages(&workspace, &["session:notes"]);
        assert_eq!(notes[0].page.page_id, "page:notes");
        assert_eq!(notes[0].page.status, None);
        database_apply(
            &workspace,
            "rename-lab-prefix",
            DatabaseIntent::RenamePageKeyPrefix {
                database_id: database_id.clone(),
                expected_revision: 1,
                prefix: "RND".to_owned(),
            },
        );
        assert_eq!(
            linked_pages(&workspace, &["session:work"])[0]
                .page
                .page_key
                .as_deref(),
            Some("RND-1")
        );
        database_apply(
            &workspace,
            "clear-status",
            DatabaseIntent::EditPropertyValues {
                edits: vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id: "page:work".to_owned(),
                        data_source_id: data_source_id.clone(),
                        property_id: "status".to_owned(),
                    },
                    edit: DatabasePropertyValueEdit::Replace {
                        expected_value_revision: value_revision + 1,
                        value: DatabasePropertyValueInput::Empty,
                    },
                }],
            },
        );
        let without_status = linked_pages(&workspace, &["session:work"]);
        assert_eq!(without_status[0].page.page_id, "page:work");
        assert_eq!(without_status[0].page.status, None);
        database_apply(
            &workspace,
            "detach-work",
            DatabaseIntent::TransferPage {
                page_id: "page:work".to_owned(),
                expected_parent_revision: 2,
                expected_active_membership_revision: 1,
                target: DatabaseTransferTarget::Library {
                    library_id: "library-1".to_owned(),
                },
            },
        );
        let detached = linked_pages(&workspace, &["session:work"]);
        assert_eq!(detached[0].page.page_id, "page:work");
        assert_eq!(detached[0].page.status, None);
        assert_eq!(detached[0].page.page_key, None);
    }

    #[test]
    fn rejects_unbounded_or_ambiguous_session_linked_page_reads() {
        let workspace = seeded_workspace();
        assert!(linked_pages(&workspace, &[]).is_empty());
        for (ids, expected) in [
            (
                vec!["session:same".to_owned(); 2],
                CoreErrorCode::InvalidInput,
            ),
            (vec![" ".to_owned()], CoreErrorCode::InvalidInput),
            (
                (0..=super::MAX_LINKED_PAGE_SESSION_IDS)
                    .map(|index| format!("session:{index}"))
                    .collect(),
                CoreErrorCode::ResourceExhausted,
            ),
        ] {
            let error = workspace
                .module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::SessionLinkedPageSummaries { session_ids: ids },
                    },
                )
                .expect_err("invalid Session Linked Page read");
            assert_eq!(error.code, expected);
        }
    }
}
