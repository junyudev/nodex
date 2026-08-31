use crate::domain::agent_backend::binding_from_storage;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspaceThreadStatus,
    ProjectWorkspaceThreadSummary,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) const THREAD_SUMMARY_COLUMNS: &str = "
  thread.thread_id, thread.project_id, link.session_id,
  thread.forked_from_id, thread.parent_thread_id, thread.thread_name,
  thread.thread_source, thread.service_name, thread.agent_nickname,
  thread.agent_role, thread.agent_path, thread.thread_preview,
  thread.model_id,
  thread.reasoning_effort, thread.service_tier, thread.agent_backend_kind,
  thread.agent_backend_definition_id, thread.agent_backend_instance_config_id,
  thread.execution_host_id, thread.cwd,
  thread.managed_worktree_path, thread.projectless_output_directory,
  thread.projectless_workspace_browser_root, thread.status_type,
  thread.status_active_flags_json, thread.archived, thread.created_at,
  thread.updated_at, thread.recency_at, thread.linked_at
";

pub(super) fn read_child_thread_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    parent_thread_id: &str,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceThreadSummary>, StoreError> {
    validate_id(parent_thread_id)?;
    let parent_exists = connection
        .query_row(
            "SELECT 1 FROM codex_threads thread
             LEFT JOIN projects project ON project.id = thread.project_id
             WHERE thread.thread_id = ?1
               AND (thread.project_id IS NULL OR project.library_id = ?2)",
            params![parent_thread_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !parent_exists {
        return Err(not_found(
            "Parent Codex Thread is unavailable in this Library",
        ));
    }
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "workspace_child_thread_window_v1",
        parent_thread_id,
        include_archived,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_child_threads",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Child Thread cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: order_key }] = coordinate.values.as_slice() else {
                return Err(invalid("Child Thread cursor coordinate is invalid"));
            };
            Ok((*order_key, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(parent_thread_id.to_owned()),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(include_archived)),
    ];
    let cursor_predicate = coordinate
        .map(|(order_key, stable_id)| {
            parameters.extend([SqlValue::Integer(order_key), SqlValue::Text(stable_id)]);
            "AND (-thread.recency_at > ?4 \
               OR (-thread.recency_at = ?4 AND thread.thread_id > ?5))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Child Thread window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT {THREAD_SUMMARY_COLUMNS} \
         FROM codex_threads thread \
         LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id \
         LEFT JOIN projects project ON project.id = thread.project_id \
         WHERE thread.parent_thread_id = ?1 \
           AND (thread.project_id IS NULL OR project.library_id = ?2) \
           AND (?3 = 1 OR thread.archived = 0) \
           {cursor_predicate} \
         ORDER BY -thread.recency_at, thread.thread_id LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), thread_summary_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|item| {
            let order_key = item
                .recency_at
                .checked_neg()
                .ok_or_else(|| corrupt("Child Thread timestamp is invalid"))?;
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![KeysetValue::Integer { value: order_key }],
                    stable_id: item.thread_id.clone(),
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

pub(super) fn thread_summary_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProjectWorkspaceThreadSummary> {
    let status_type = match row.get::<_, String>(23)?.as_str() {
        "notLoaded" => Ok(CodexThreadStatusType::NotLoaded),
        "idle" => Ok(CodexThreadStatusType::Idle),
        "systemError" => Ok(CodexThreadStatusType::SystemError),
        "active" => Ok(CodexThreadStatusType::Active),
        _ => Err(rusqlite::Error::InvalidQuery),
    }?;
    let active_flags =
        serde_json::from_str::<Vec<CodexThreadActiveFlag>>(&row.get::<_, String>(24)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(ProjectWorkspaceThreadSummary {
        thread_id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        forked_from_id: row.get(3)?,
        parent_thread_id: row.get(4)?,
        thread_name: row.get(5)?,
        thread_source: row.get(6)?,
        service_name: row.get(7)?,
        agent_nickname: row.get(8)?,
        agent_role: row.get(9)?,
        agent_path: row.get(10)?,
        thread_preview: super::task_window::bounded_preview(&row.get::<_, String>(11)?),
        model_id: row.get(12)?,
        reasoning_effort: row.get(13)?,
        service_tier: row.get(14)?,
        backend_binding: binding_from_storage(
            row.get::<_, String>(15)?.as_str(),
            row.get(16)?,
            row.get(17)?,
        )
        .map_err(|_| rusqlite::Error::InvalidQuery)?,
        execution_host_id: row.get(18)?,
        cwd: row.get(19)?,
        managed_worktree_path: row.get(20)?,
        projectless_output_directory: row.get(21)?,
        projectless_workspace_browser_root: row.get(22)?,
        status: ProjectWorkspaceThreadStatus {
            status_type,
            active_flags,
        },
        archived: row.get::<_, i64>(25)? == 1,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        recency_at: row.get(28)?,
        linked_at: row.get(29)?,
    })
}

fn validate_id(value: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.trim() == value && value.len() <= 512 {
        return Ok(());
    }
    Err(invalid("parent_thread_id is invalid"))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
