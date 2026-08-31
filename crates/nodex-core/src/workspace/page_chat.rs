use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspacePageChatActivitySummary,
    ProjectWorkspacePageChatItem, ProjectWorkspaceThreadStatus,
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

pub(super) fn validate_initial_page_ids(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
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
    let Some(project_id) = project_id else {
        return Err(invalid(
            "Initial Linked chat Pages require a Project-owned Session",
        ));
    };
    validate_page_ids(page_ids, MAX_INITIAL_PAGE_IDS)?;
    for page_id in page_ids {
        crate::library::require_page_read_access(connection, library_id, project_id, page_id)?;
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
    page_access_project_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_page_access(connection, library_id, page_access_project_id, page_id)?;
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
    page_access_project_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_page_access(connection, library_id, page_access_project_id, page_id)?;
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

pub(super) fn read_page_chat_activity_summaries(
    connection: &Connection,
    library_id: &str,
    page_access_project_id: &str,
    page_ids: &[String],
) -> Result<Vec<ProjectWorkspacePageChatActivitySummary>, StoreError> {
    validate_id("page_access_project_id", page_access_project_id)?;
    if page_ids.len() > MAX_ACTIVITY_PAGE_IDS {
        return Err(resource_exhausted(
            "Page Chat activity request exceeds the fixed bound",
        ));
    }
    validate_page_ids(page_ids, MAX_ACTIVITY_PAGE_IDS)?;
    if page_ids.is_empty() {
        return Ok(Vec::new());
    }
    require_page_access_project(connection, library_id, page_access_project_id)?;
    for page_id in page_ids {
        crate::library::require_page_read_access(
            connection,
            library_id,
            page_access_project_id,
            page_id,
        )?;
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

pub(super) fn read_page_chat_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    page_access_project_id: &str,
    page_id: &str,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspacePageChatItem>, StoreError> {
    require_page_access(connection, library_id, page_access_project_id, page_id)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "workspace_page_chat_window_v1",
        page_access_project_id,
        page_id,
        include_archived,
    ))?;
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
            "AND (CASE WHEN thread.thread_id IS NULL THEN 1 ELSE 0 END > ?4 \
              OR (CASE WHEN thread.thread_id IS NULL THEN 1 ELSE 0 END = ?4 \
                AND -COALESCE(thread.recency_at, 0) > ?5) \
              OR (CASE WHEN thread.thread_id IS NULL THEN 1 ELSE 0 END = ?4 \
                AND -COALESCE(thread.recency_at, 0) = ?5 AND relation.linked_at < ?6) \
              OR (CASE WHEN thread.thread_id IS NULL THEN 1 ELSE 0 END = ?4 \
                AND -COALESCE(thread.recency_at, 0) = ?5 AND relation.linked_at = ?6 \
                AND session.id > ?7))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Page Chat window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT session.id, session.project_id, project.name, \
           session.no_thread_fallback_title, thread.thread_id, thread.thread_name, \
           COALESCE(substr(thread.thread_preview, 1, 1024), ''), thread.status_type, \
           thread.status_active_flags_json, COALESCE(thread.archived, 0), session.unread, \
           session.archived, thread.recency_at, relation.linked_at, \
           CASE WHEN thread.thread_id IS NULL THEN 1 ELSE 0 END AS recency_null, \
           -COALESCE(thread.recency_at, 0) AS recency_order \
         FROM project_session_pages relation \
         JOIN pages page ON page.block_id = relation.page_id AND page.library_id = ?2 \
         JOIN project_sessions session ON session.id = relation.session_id \
         LEFT JOIN projects project ON project.id = session.project_id \
         LEFT JOIN project_session_threads session_thread ON session_thread.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = session_thread.thread_id \
         WHERE relation.page_id = ?1 \
           AND (session.project_id IS NULL OR project.library_id = ?2) \
           AND (?3 = 1 OR session.archived = 0) \
           {cursor_predicate} \
         ORDER BY recency_null, recency_order, relation.linked_at DESC, session.id \
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
    let thread_id = row.get::<_, Option<String>>(4)?;
    let status = thread_id
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
        thread_id.as_ref().map(|_| thread_preview.as_str()),
        &fallback_title,
    );
    Ok(PageChatRow {
        item: ProjectWorkspacePageChatItem {
            session_id: row.get(0)?,
            project_id: row.get(1)?,
            project_name: row.get(2)?,
            display_title,
            thread_id,
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
    project_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    validate_id("page_access_project_id", project_id)?;
    validate_id("page_id", page_id)?;
    crate::library::require_page_read_access(connection, library_id, project_id, page_id)
}

fn require_page_access_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    validate_id("page_access_project_id", project_id)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }
    Err(not_found("Page access Project is unavailable"))
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
        apply, context, create_page_with_project_access, create_project, read, request,
        seeded_workspace,
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
        create_page_with_project_access(&workspace, "page:related", "project:default");

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
        create_page_with_project_access(&workspace, "page:other", "project:other");
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
                        initial_page_ids: vec!["page:related".to_owned(), "page:other".to_owned()],
                    },
                ),
            )
            .expect_err("reject inaccessible initial Page");
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
        create_page_with_project_access(&workspace, "page:activity", "project:default");
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
                page_access_project_id: "project:default".to_owned(),
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
                page_access_project_id: "project:default".to_owned(),
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
                page_access_project_id: "project:default".to_owned(),
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
                page_access_project_id: "project:default".to_owned(),
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
                page_access_project_id: "project:default".to_owned(),
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
                            page_access_project_id: "project:default".to_owned(),
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
                    page_access_project_id: "project:default".to_owned(),
                },
            },
        );
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_access_project_id: "project:default".to_owned(),
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
    fn rejects_ambiguous_unbounded_or_unauthorized_page_reads() {
        let workspace = seeded_workspace();
        create_page_with_project_access(&workspace, "page:bounded", "project:default");
        let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::PageChatActivitySummaries {
                page_access_project_id: "project:missing".to_owned(),
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
                        read: ProjectWorkspaceRead::PageChatActivitySummaries {
                            page_access_project_id: "project:default".to_owned(),
                            page_ids,
                        },
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
                        page_access_project_id: "project:default".to_owned(),
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
                        page_access_project_id: "project:missing".to_owned(),
                        page_id: "page:bounded".to_owned(),
                        include_archived: Some(false),
                        window: CollectionWindowRequest::default(),
                    },
                },
            )
            .expect_err("unauthorized Page Chat window");
        assert_eq!(error.code, CoreErrorCode::NotFound);
    }
}
