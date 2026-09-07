use std::time::{SystemTime, UNIX_EPOCH};

use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexPermissionMode, ProjectWorkspaceBackgroundProcess,
    ProjectWorkspaceBackgroundProcessSource, ProjectWorkspaceTurnAuthority,
    ProjectWorkspaceTurnAuthorityResolution, ProjectWorkspaceTurnAuthorityScope,
    ProjectWorkspaceTurnAuthoritySource,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::json;

use crate::document::sha256;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{WorkspaceMutationEffects, finish_mutation};
use super::session_mutation::sqlite_now;
use super::thread::{read_permission_mode, read_projectless_permission_mode};

const AUTHORITY_PROVENANCE_VERSION: i64 = 1;
const FULL_ACCESS_PERMISSION_PROFILE_ID: &str = ":danger-full-access";
const MAX_ID_BYTES: usize = 512;
const MAX_WRITABLE_ROOTS: usize = 128;
const MAX_WRITABLE_ROOT_INPUTS: usize = 1_024;
const MAX_PATH_BYTES: usize = 16_384;
const MAX_BACKGROUND_PROCESSES: usize = 200;
const MAX_PROCESS_COMMAND_BYTES: usize = 1024 * 1024;
const MAX_PROCESS_SHORT_TEXT_BYTES: usize = 16_384;

struct AuthorityCoordinates {
    library_id: String,
    profile_id: String,
    store_epoch: String,
}

struct AuthorityRow {
    thread_id: String,
    turn_id: String,
    root_thread_id: String,
    actor_project_id: Option<String>,
    library_id: String,
    profile_id: String,
    store_epoch: String,
    scope: String,
    source: String,
    permission_profile_id: Option<String>,
    authority_fingerprint: String,
    provenance_version: i64,
    created_at: String,
    read_only: bool,
}

pub(super) fn read_writable_roots(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<String>, StoreError> {
    let roots = connection
        .prepare(
            "SELECT root FROM codex_thread_writable_roots \
             WHERE thread_id = ?1 ORDER BY root_order, root",
        )?
        .query_map([thread_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if roots.len() > MAX_WRITABLE_ROOTS || roots.iter().any(|root| !valid_workspace_root(root)) {
        return Err(corrupt(
            "Codex Thread writable roots violate their Core invariant",
        ));
    }
    Ok(roots)
}

pub(super) fn resolve_turn_authority(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    turn_id: &str,
    root_thread_id: &str,
    actor_project_id: Option<&str>,
) -> Result<ProjectWorkspaceTurnAuthorityResolution, StoreError> {
    for (name, value) in [
        ("thread_id", thread_id),
        ("turn_id", turn_id),
        ("root_thread_id", root_thread_id),
    ] {
        validate_id(name, value)?;
    }
    if let Some(project_id) = actor_project_id {
        validate_id("actor_project_id", project_id)?;
    }
    let coordinates = require_authority_coordinates(connection, library_id, actor_project_id)?;
    let Some(row) = read_authority_row(connection, thread_id, turn_id)? else {
        if actor_project_id.is_none() {
            return Ok(ProjectWorkspaceTurnAuthorityResolution {
                authority: None,
                persisted: false,
                read_only: true,
                frozen_at_ms: None,
            });
        }
        return Ok(ProjectWorkspaceTurnAuthorityResolution {
            authority: Some(ProjectWorkspaceTurnAuthority {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                root_thread_id: root_thread_id.to_owned(),
                actor_project_id: actor_project_id.map(str::to_owned),
                library_id: coordinates.library_id,
                store_epoch: coordinates.store_epoch,
                scope: ProjectWorkspaceTurnAuthorityScope::Project,
                source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            }),
            persisted: false,
            read_only: true,
            frozen_at_ms: None,
        });
    };
    let authority = validate_authority_row(&row)?;
    let matches_current_coordinates = authority.root_thread_id == root_thread_id
        && authority.actor_project_id.as_deref() == actor_project_id
        && authority.library_id == coordinates.library_id
        && row.profile_id == coordinates.profile_id
        && authority.store_epoch == coordinates.store_epoch;
    Ok(ProjectWorkspaceTurnAuthorityResolution {
        authority: matches_current_coordinates.then_some(authority),
        persisted: true,
        read_only: row.read_only,
        frozen_at_ms: matches_current_coordinates
            .then(|| timestamp_millis(&row.created_at))
            .transpose()?,
    })
}

pub(crate) fn validate_persisted_turn_authority(
    connection: &Connection,
    library_id: &str,
    provenance: &AgentTurnProvenance,
) -> Result<String, StoreError> {
    let supplied = &provenance.authority;
    for (name, value) in [
        ("profile_id", provenance.profile_id.as_str()),
        ("thread_id", supplied.thread_id.as_str()),
        ("turn_id", supplied.turn_id.as_str()),
        ("root_thread_id", supplied.root_thread_id.as_str()),
        ("library_id", supplied.library_id.as_str()),
        ("store_epoch", supplied.store_epoch.as_str()),
    ] {
        validate_id(name, value)?;
    }
    let coordinates = require_authority_coordinates(
        connection,
        library_id,
        supplied.actor_project_id.as_deref(),
    )?;
    if supplied.library_id != library_id
        || supplied.library_id != coordinates.library_id
        || provenance.profile_id != coordinates.profile_id
        || supplied.store_epoch != coordinates.store_epoch
    {
        return Err(unauthorized(
            "Agent Turn provenance no longer matches current Profile authority",
        ));
    }
    require_thread_project(
        connection,
        library_id,
        &supplied.thread_id,
        supplied.actor_project_id.as_deref(),
    )?;
    require_thread_project(
        connection,
        library_id,
        &supplied.root_thread_id,
        supplied.actor_project_id.as_deref(),
    )?;
    let row = read_authority_row(connection, &supplied.thread_id, &supplied.turn_id)?
        .ok_or_else(|| unauthorized("Agent Turn has no persisted authority"))?;
    let persisted = validate_authority_row(&row)?;
    if persisted != *supplied || row.profile_id != provenance.profile_id {
        return Err(unauthorized(
            "Agent Turn provenance does not match its persisted authority",
        ));
    }
    Ok(row.authority_fingerprint)
}

/// Called after validating exact persisted provenance in the same transaction.
pub(crate) fn turn_is_read_only(
    connection: &Connection,
    thread_id: &str,
    turn_id: &str,
) -> Result<bool, StoreError> {
    Ok(read_authority_row(connection, thread_id, turn_id)?.is_none_or(|row| row.read_only))
}

pub(super) fn read_background_process_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    thread_id: Option<&str>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceBackgroundProcess>, StoreError> {
    if let Some(thread_id) = thread_id {
        validate_id("thread_id", thread_id)?;
        require_visible_thread(connection, library_id, thread_id)?;
    }
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("workspace_background_process_window_v1", thread_id))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_background_processes",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Background process cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: order_key }] = coordinate.values.as_slice() else {
                return Err(invalid("Background process cursor coordinate is invalid"));
            };
            Ok((*order_key, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        thread_id.map_or(SqlValue::Null, |value| SqlValue::Text(value.to_owned())),
        SqlValue::Text(library_id.to_owned()),
    ];
    let cursor_predicate = coordinate
        .map(|(order_key, stable_id)| {
            parameters.extend([SqlValue::Integer(order_key), SqlValue::Text(stable_id)]);
            "AND (-process.updated_at_ms > ?3 \
               OR (-process.updated_at_ms = ?3 AND process.process_record_id > ?4))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Background process window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "SELECT process.process_record_id, process.thread_id, process.thread_title, \
           process.item_id, process.turn_id, process.command, process.cwd, \
           process.app_server_process_id, process.os_pid, process.terminal_session_id, \
           process.source, process.started_at_ms, process.updated_at_ms \
         FROM codex_background_processes process \
         JOIN codex_threads thread ON thread.thread_id = process.thread_id \
         LEFT JOIN projects project ON project.id = thread.project_id \
         WHERE (?1 IS NULL OR process.thread_id = ?1) \
           AND (thread.project_id IS NULL OR project.library_id = ?2) \
           {cursor_predicate} \
         ORDER BY -process.updated_at_ms, process.process_record_id \
         LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok(AuthorityBackgroundRow {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                thread_title: row.get(2)?,
                item_id: row.get(3)?,
                turn_id: row.get(4)?,
                command: row.get(5)?,
                cwd: row.get(6)?,
                process_id: row.get(7)?,
                os_pid: row.get(8)?,
                terminal_session_id: row.get(9)?,
                source: row.get(10)?,
                started_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|row| {
            let order_key = row
                .updated_at_ms
                .checked_neg()
                .ok_or_else(|| corrupt("Background process timestamp is invalid"))?;
            let item = background_process_from_row(row)?;
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![KeysetValue::Integer { value: order_key }],
                    stable_id: item.id.clone(),
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

#[allow(clippy::too_many_arguments)]
pub(super) fn freeze_turn_authority(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    turn_id: &str,
    root_thread_id: &str,
    actor_project_id: Option<&str>,
    source: ProjectWorkspaceTurnAuthoritySource,
    mut read_only: bool,
    inherited_from: Option<(&str, &str)>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host_adapter(context)?;
    for (name, value) in [
        ("thread_id", thread_id),
        ("turn_id", turn_id),
        ("root_thread_id", root_thread_id),
    ] {
        validate_id(name, value)?;
    }
    if context.project_id.as_ref().map(|id| id.0.as_str()) != actor_project_id {
        return Err(unauthorized(
            "Turn authority actor does not match the bound Project identity",
        ));
    }
    if let Some(project_id) = actor_project_id {
        validate_id("actor_project_id", project_id)?;
    }
    let coordinates = require_authority_coordinates(connection, library_id, actor_project_id)?;
    require_thread_project(connection, library_id, thread_id, actor_project_id)?;
    require_thread_project(connection, library_id, root_thread_id, actor_project_id)?;

    let (scope, permission_profile_id) = match source {
        ProjectWorkspaceTurnAuthoritySource::ProjectTurn => {
            if actor_project_id.is_none() {
                return Err(unauthorized("Project authority requires an actor Project"));
            }
            if inherited_from.is_some() {
                return Err(invalid(
                    "project_turn authority cannot name inherited provenance",
                ));
            }
            (ProjectWorkspaceTurnAuthorityScope::Project, None)
        }
        ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess => {
            if inherited_from.is_some() {
                return Err(invalid(
                    "builtin_full_access authority cannot name inherited provenance",
                ));
            }
            let mode = match actor_project_id {
                Some(project_id) => read_permission_mode(connection, project_id)?,
                None => read_projectless_permission_mode(connection)?,
            };
            if mode != Some(CodexPermissionMode::FullAccess) {
                return Err(unauthorized(
                    "builtin full access requires the persisted full-access permission mode",
                ));
            }
            (
                ProjectWorkspaceTurnAuthorityScope::Library,
                Some(FULL_ACCESS_PERMISSION_PROFILE_ID),
            )
        }
        ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess => {
            let (parent_thread_id, parent_turn_id) = inherited_from.ok_or_else(|| {
                invalid("inherited authority requires an exact parent Turn coordinate")
            })?;
            validate_id("inherited_from.thread_id", parent_thread_id)?;
            validate_id("inherited_from.turn_id", parent_turn_id)?;
            require_thread_project(connection, library_id, parent_thread_id, actor_project_id)?;
            let parent_row = read_authority_row(connection, parent_thread_id, parent_turn_id)?
                .ok_or_else(|| not_found("Inherited parent Turn authority is unavailable"))?;
            let parent = validate_authority_row(&parent_row)?;
            read_only |= parent_row.read_only;
            let inherits_current_library_authority = parent.scope
                == ProjectWorkspaceTurnAuthorityScope::Library
                && parent.root_thread_id == root_thread_id
                && parent.actor_project_id.as_deref() == actor_project_id
                && parent.library_id == coordinates.library_id
                && parent_row.profile_id == coordinates.profile_id
                && parent.store_epoch == coordinates.store_epoch;
            if !inherits_current_library_authority {
                return Err(unauthorized(
                    "Inherited parent Turn has no current Library authority",
                ));
            }
            (
                ProjectWorkspaceTurnAuthorityScope::Library,
                Some(FULL_ACCESS_PERMISSION_PROFILE_ID),
            )
        }
    };
    let existing = read_authority_row(connection, thread_id, turn_id)?;
    let created_at = existing
        .as_ref()
        .map(|row| row.created_at.clone())
        .unwrap_or(sqlite_now(connection)?);
    let authority = ProjectWorkspaceTurnAuthority {
        thread_id: thread_id.to_owned(),
        turn_id: turn_id.to_owned(),
        root_thread_id: root_thread_id.to_owned(),
        actor_project_id: actor_project_id.map(str::to_owned),
        library_id: coordinates.library_id,
        store_epoch: coordinates.store_epoch,
        scope,
        source,
    };
    let fingerprint = authority_fingerprint(&authority)?;
    let proposed = AuthorityRow {
        thread_id: authority.thread_id.clone(),
        turn_id: authority.turn_id.clone(),
        root_thread_id: authority.root_thread_id.clone(),
        actor_project_id: authority.actor_project_id.clone(),
        library_id: authority.library_id.clone(),
        profile_id: coordinates.profile_id,
        store_epoch: authority.store_epoch.clone(),
        scope: authority_scope_literal(authority.scope).to_owned(),
        source: authority_source_literal(authority.source).to_owned(),
        permission_profile_id: permission_profile_id.map(str::to_owned),
        authority_fingerprint: fingerprint,
        provenance_version: AUTHORITY_PROVENANCE_VERSION,
        created_at,
        read_only,
    };
    if let Some(existing) = existing {
        if !authority_rows_match(&existing, &proposed) {
            return Err(conflict(
                "Codex Turn is already frozen with different authority provenance",
            ));
        }
    } else {
        connection.execute(
            "INSERT INTO nodex_agent_turn_authorities(\
               thread_id, turn_id, root_thread_id, actor_project_id, library_id, profile_id, \
               store_epoch, scope, source, permission_profile_id, authority_fingerprint, \
               provenance_version, created_at, read_only\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                proposed.thread_id,
                proposed.turn_id,
                proposed.root_thread_id,
                proposed.actor_project_id,
                proposed.library_id,
                proposed.profile_id,
                proposed.store_epoch,
                proposed.scope,
                proposed.source,
                proposed.permission_profile_id,
                proposed.authority_fingerprint,
                proposed.provenance_version,
                proposed.created_at,
                proposed.read_only,
            ],
        )?;
    }
    finish_execution_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "freeze_turn_authority",
        actor_project_id,
        thread_id,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mutate_writable_roots(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    roots: &[String],
    merge: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    if roots.len() > MAX_WRITABLE_ROOT_INPUTS {
        return Err(invalid("Writable root input exceeds its Core bound"));
    }
    let project_id = require_mutable_thread(connection, library_id, thread_id)?;
    let mut candidates = if merge {
        read_writable_roots(connection, thread_id)?
    } else {
        Vec::new()
    };
    candidates.extend_from_slice(roots);
    let next = normalize_roots_input(&candidates);
    replace_writable_roots_records(connection, thread_id, &next)?;
    finish_execution_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        if merge {
            "merge_thread_writable_roots"
        } else {
            "replace_thread_writable_roots"
        },
        project_id.as_deref(),
        thread_id,
    )
}

/** Writes the exact normalized root set inside an already-owned Workspace mutation. */
pub(super) fn replace_writable_roots_records(
    connection: &Connection,
    thread_id: &str,
    roots: &[String],
) -> Result<(), StoreError> {
    validate_id("thread_id", thread_id)?;
    if roots.len() > MAX_WRITABLE_ROOT_INPUTS {
        return Err(invalid("Writable root input exceeds its Core bound"));
    }
    let next = normalize_roots_input(roots);
    connection.execute(
        "DELETE FROM codex_thread_writable_roots WHERE thread_id = ?1",
        [thread_id],
    )?;
    let now = unix_time_millis()?;
    for (order, root) in next.into_iter().enumerate() {
        connection.execute(
            "INSERT INTO codex_thread_writable_roots(\
               thread_id, root, root_order, updated_at_unix_ms\
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                thread_id,
                root,
                i64::try_from(order).expect("writable root bound fits i64"),
                now,
            ],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn upsert_background_process(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    process: &ProjectWorkspaceBackgroundProcess,
    preserve_started_at: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let normalized = normalize_background_process(process)?;
    let normalized_thread_id = normalized.thread_id.clone();
    let project_id = require_mutable_thread(connection, library_id, &normalized_thread_id)?;
    let expected_id = format!("{}:{}", normalized.thread_id, normalized.item_id);
    if normalized.id != expected_id {
        return Err(invalid(
            "Background process id must be derived from its Thread and item ids",
        ));
    }
    connection.execute(
        "INSERT INTO codex_background_processes(\
           process_record_id, thread_id, thread_title, item_id, turn_id, command, cwd, \
           app_server_process_id, os_pid, terminal_session_id, source, started_at_ms, updated_at_ms\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(process_record_id) DO UPDATE SET \
           thread_id = excluded.thread_id, \
           thread_title = COALESCE(excluded.thread_title, codex_background_processes.thread_title), \
           item_id = excluded.item_id, \
           turn_id = COALESCE(excluded.turn_id, codex_background_processes.turn_id), \
           command = excluded.command, \
           cwd = COALESCE(excluded.cwd, codex_background_processes.cwd), \
           app_server_process_id = COALESCE(\
             excluded.app_server_process_id, codex_background_processes.app_server_process_id\
           ), \
           os_pid = COALESCE(excluded.os_pid, codex_background_processes.os_pid), \
           terminal_session_id = COALESCE(\
             excluded.terminal_session_id, codex_background_processes.terminal_session_id\
           ), \
           source = excluded.source, \
           started_at_ms = CASE WHEN ?14 = 1 \
             THEN codex_background_processes.started_at_ms ELSE excluded.started_at_ms END, \
           updated_at_ms = excluded.updated_at_ms",
        params![
            normalized.id,
            normalized.thread_id,
            normalized.thread_title,
            normalized.item_id,
            normalized.turn_id,
            normalized.command,
            normalized.cwd,
            normalized.process_id,
            normalized.os_pid,
            normalized.terminal_session_id,
            background_source_literal(normalized.source),
            normalized.started_at_ms,
            normalized.updated_at_ms,
            i64::from(preserve_started_at),
        ],
    )?;
    connection.execute(
        "DELETE FROM codex_background_processes \
         WHERE process_record_id NOT IN (\
           SELECT process_record_id FROM codex_background_processes \
           ORDER BY updated_at_ms DESC, process_record_id ASC LIMIT ?1\
         )",
        [i64::try_from(MAX_BACKGROUND_PROCESSES).expect("background process bound fits i64")],
    )?;
    finish_execution_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "upsert_background_process",
        project_id.as_deref(),
        &normalized_thread_id,
    )
}

#[derive(Debug)]
struct AuthorityBackgroundRow {
    id: String,
    thread_id: String,
    thread_title: Option<String>,
    item_id: String,
    turn_id: Option<String>,
    command: String,
    cwd: Option<String>,
    process_id: Option<String>,
    os_pid: Option<i64>,
    terminal_session_id: Option<String>,
    source: String,
    started_at_ms: i64,
    updated_at_ms: i64,
}

fn background_process_from_row(
    row: AuthorityBackgroundRow,
) -> Result<ProjectWorkspaceBackgroundProcess, StoreError> {
    let source = match row.source.as_str() {
        "app-server" => ProjectWorkspaceBackgroundProcessSource::AppServer,
        "terminal-action" => ProjectWorkspaceBackgroundProcessSource::TerminalAction,
        _ => return Err(corrupt("Background process has an invalid source")),
    };
    let record = ProjectWorkspaceBackgroundProcess {
        id: row.id,
        thread_id: row.thread_id,
        thread_title: row.thread_title,
        item_id: row.item_id,
        turn_id: row.turn_id,
        command: row.command,
        cwd: row.cwd,
        process_id: row.process_id,
        os_pid: row.os_pid,
        terminal_session_id: row.terminal_session_id,
        source,
        started_at_ms: row.started_at_ms,
        updated_at_ms: row.updated_at_ms,
    };
    let normalized = normalize_background_process(&record)?;
    let expected_id = format!("{}:{}", normalized.thread_id, normalized.item_id);
    if normalized != record || normalized.id != expected_id {
        return Err(corrupt(
            "Background process violates its persisted Core invariant",
        ));
    }
    Ok(normalized)
}

fn normalize_background_process(
    process: &ProjectWorkspaceBackgroundProcess,
) -> Result<ProjectWorkspaceBackgroundProcess, StoreError> {
    let id = required_string("process.id", &process.id, MAX_PROCESS_SHORT_TEXT_BYTES)?;
    let thread_id = required_string("process.thread_id", &process.thread_id, MAX_ID_BYTES)?;
    let item_id = required_string("process.item_id", &process.item_id, MAX_ID_BYTES)?;
    let command = required_string(
        "process.command",
        &process.command,
        MAX_PROCESS_COMMAND_BYTES,
    )?;
    Ok(ProjectWorkspaceBackgroundProcess {
        id,
        thread_id,
        thread_title: nullable_string(
            "process.thread_title",
            process.thread_title.as_deref(),
            MAX_PROCESS_SHORT_TEXT_BYTES,
        )?,
        item_id,
        turn_id: nullable_string("process.turn_id", process.turn_id.as_deref(), MAX_ID_BYTES)?,
        command,
        cwd: nullable_string("process.cwd", process.cwd.as_deref(), MAX_PATH_BYTES)?,
        process_id: nullable_string(
            "process.process_id",
            process.process_id.as_deref(),
            MAX_ID_BYTES,
        )?,
        os_pid: process.os_pid.filter(|pid| *pid > 0),
        terminal_session_id: nullable_string(
            "process.terminal_session_id",
            process.terminal_session_id.as_deref(),
            MAX_ID_BYTES,
        )?,
        source: process.source,
        started_at_ms: process.started_at_ms.max(0),
        updated_at_ms: process.updated_at_ms.max(0),
    })
}

fn read_authority_row(
    connection: &Connection,
    thread_id: &str,
    turn_id: &str,
) -> Result<Option<AuthorityRow>, StoreError> {
    connection
        .query_row(
            "SELECT thread_id, turn_id, root_thread_id, actor_project_id, library_id, \
               profile_id, store_epoch, scope, source, permission_profile_id, \
               authority_fingerprint, provenance_version, created_at, read_only \
             FROM nodex_agent_turn_authorities \
             WHERE thread_id = ?1 AND turn_id = ?2",
            params![thread_id, turn_id],
            |row| {
                Ok(AuthorityRow {
                    thread_id: row.get(0)?,
                    turn_id: row.get(1)?,
                    root_thread_id: row.get(2)?,
                    actor_project_id: row.get(3)?,
                    library_id: row.get(4)?,
                    profile_id: row.get(5)?,
                    store_epoch: row.get(6)?,
                    scope: row.get(7)?,
                    source: row.get(8)?,
                    permission_profile_id: row.get(9)?,
                    authority_fingerprint: row.get(10)?,
                    provenance_version: row.get(11)?,
                    created_at: row.get(12)?,
                    read_only: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn validate_authority_row(row: &AuthorityRow) -> Result<ProjectWorkspaceTurnAuthority, StoreError> {
    let scope = match row.scope.as_str() {
        "project" => ProjectWorkspaceTurnAuthorityScope::Project,
        "library" => ProjectWorkspaceTurnAuthorityScope::Library,
        _ => return Err(corrupt("Turn authority has an invalid scope")),
    };
    let source = match row.source.as_str() {
        "project_turn" => ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
        "builtin_full_access" => ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
        "inherited_builtin_full_access" => {
            ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess
        }
        _ => return Err(corrupt("Turn authority has an invalid source")),
    };
    let source_matches_scope = matches!(
        (scope, source),
        (
            ProjectWorkspaceTurnAuthorityScope::Project,
            ProjectWorkspaceTurnAuthoritySource::ProjectTurn
        ) | (
            ProjectWorkspaceTurnAuthorityScope::Library,
            ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess
                | ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess
        )
    );
    let permission_matches_scope = match scope {
        ProjectWorkspaceTurnAuthorityScope::Project => row.permission_profile_id.is_none(),
        ProjectWorkspaceTurnAuthorityScope::Library => {
            row.permission_profile_id.as_deref() == Some(FULL_ACCESS_PERMISSION_PROFILE_ID)
        }
    };
    if row.provenance_version != AUTHORITY_PROVENANCE_VERSION
        || !source_matches_scope
        || !permission_matches_scope
        || (row.actor_project_id.is_none() && scope != ProjectWorkspaceTurnAuthorityScope::Library)
        || row
            .actor_project_id
            .as_deref()
            .is_some_and(|id| validate_id("actor_project_id", id).is_err())
    {
        return Err(corrupt("Turn authority provenance is invalid"));
    }
    let authority = ProjectWorkspaceTurnAuthority {
        thread_id: row.thread_id.clone(),
        turn_id: row.turn_id.clone(),
        root_thread_id: row.root_thread_id.clone(),
        actor_project_id: row.actor_project_id.clone(),
        library_id: row.library_id.clone(),
        store_epoch: row.store_epoch.clone(),
        scope,
        source,
    };
    if authority_fingerprint(&authority)? != row.authority_fingerprint {
        return Err(corrupt("Turn authority fingerprint is invalid"));
    }
    Ok(authority)
}

fn authority_fingerprint(authority: &ProjectWorkspaceTurnAuthority) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(&json!([
        AUTHORITY_PROVENANCE_VERSION,
        authority.thread_id,
        authority.turn_id,
        authority.root_thread_id,
        authority.actor_project_id,
        authority.library_id,
        authority.store_epoch,
        authority_scope_literal(authority.scope),
        authority_source_literal(authority.source),
    ]))
    .map_err(|_| internal("Turn authority cannot be fingerprinted"))?;
    Ok(sha256(&bytes))
}

fn authority_rows_match(left: &AuthorityRow, right: &AuthorityRow) -> bool {
    left.thread_id == right.thread_id
        && left.turn_id == right.turn_id
        && left.root_thread_id == right.root_thread_id
        && left.actor_project_id == right.actor_project_id
        && left.library_id == right.library_id
        && left.profile_id == right.profile_id
        && left.store_epoch == right.store_epoch
        && left.scope == right.scope
        && left.read_only == right.read_only
        && left.source == right.source
        && left.permission_profile_id == right.permission_profile_id
        && left.authority_fingerprint == right.authority_fingerprint
        && left.provenance_version == right.provenance_version
}

fn require_authority_coordinates(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
) -> Result<AuthorityCoordinates, StoreError> {
    if let Some(project_id) = project_id {
        validate_id("actor_project_id", project_id)?;
    }
    connection
        .query_row(
            "SELECT library.id, library.profile_id, metadata.store_epoch \
         FROM libraries library JOIN block_store_metadata metadata ON metadata.id = 1 \
         WHERE library.id = ?1 AND (?2 IS NULL OR EXISTS( \
           SELECT 1 FROM projects project WHERE project.id = ?2 \
           AND project.library_id = library.id AND project.lifecycle = 'active'))",
            params![library_id, project_id],
            |row| {
                Ok(AuthorityCoordinates {
                    library_id: row.get(0)?,
                    profile_id: row.get(1)?,
                    store_epoch: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Turn authority context is unavailable in this Library"))
}

fn require_mutable_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<Option<String>, StoreError> {
    let project_id = require_visible_thread(connection, library_id, thread_id)?;
    if let Some(project_id) = project_id.as_deref() {
        require_authority_coordinates(connection, library_id, Some(project_id))?;
    }
    Ok(project_id)
}

fn require_visible_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT thread.project_id FROM codex_threads thread \
             LEFT JOIN projects project ON project.id = thread.project_id \
             WHERE thread.thread_id = ?1 \
               AND (thread.project_id IS NULL OR project.library_id = ?2)",
            params![thread_id, library_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Codex Thread is unavailable in this Library"))
}

fn require_thread_project(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    expected_project_id: Option<&str>,
) -> Result<(), StoreError> {
    let project_id = require_visible_thread(connection, library_id, thread_id)?;
    if project_id.as_deref() == expected_project_id {
        return Ok(());
    }
    Err(unauthorized(
        "Turn authority Thread does not belong to the actor Project",
    ))
}

#[allow(clippy::too_many_arguments)]
fn finish_execution_mutation(
    connection: &Connection,
    _library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation_kind: &'static str,
    project_id: Option<&str>,
    thread_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let change_project_id = project_id.map(str::to_owned);
    finish_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        WorkspaceMutationEffects {
            operation_kind,
            project_catalog_change: None,
            change_project_id,
            project_ids: project_id.into_iter().map(str::to_owned).collect(),
            session_ids: Vec::new(),
            thread_ids: vec![thread_id.to_owned()],
            session_summary_scopes: Vec::new(),
            session_detail_ids: Vec::new(),
            block_ids: Vec::new(),
            document_ids: Vec::new(),
            database_ids: Vec::new(),
            page_ids: Vec::new(),
            data_source_ids: Vec::new(),
            view_ids: Vec::new(),
            document_heads: Vec::new(),
            committed_at: sqlite_now(connection)?,
            queued_follow_up_ledger: None,
        },
    )
}

fn normalize_roots_input(roots: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for root in roots {
        if normalized.len() == MAX_WRITABLE_ROOTS {
            break;
        }
        if valid_workspace_root(root) && !normalized.contains(root) {
            normalized.push(root.clone());
        }
    }
    normalized
}

fn valid_workspace_root(root: &str) -> bool {
    if root.is_empty() || root.len() > MAX_PATH_BYTES {
        return false;
    }
    let bytes = root.as_bytes();
    if root.starts_with('/') && !root.starts_with("//") {
        return true;
    }
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    if let Some(network_root) = root.strip_prefix("\\\\") {
        return network_root_has_server_and_share(network_root, '\\');
    }
    root.strip_prefix("//")
        .is_some_and(|network_root| network_root_has_server_and_share(network_root, '/'))
}

fn network_root_has_server_and_share(root: &str, separator: char) -> bool {
    let mut parts = root.split(separator);
    parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_some_and(|part| !part.is_empty())
}

fn required_string(name: &str, value: &str, max_bytes: usize) -> Result<String, StoreError> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.len() > max_bytes {
        return Err(invalid(format!(
            "{name} must contain between 1 and {max_bytes} bytes"
        )));
    }
    Ok(normalized.to_owned())
}

fn nullable_string(
    name: &str,
    value: Option<&str>,
    max_bytes: usize,
) -> Result<Option<String>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.len() > max_bytes {
        return Err(invalid(format!("{name} exceeds {max_bytes} bytes")));
    }
    Ok(Some(normalized.to_owned()))
}

fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    required_string(name, value, MAX_ID_BYTES).map(|_| ())
}

fn require_host_adapter(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(unauthorized(
        "Only a trusted Electron Host Adapter may freeze Turn authority",
    ))
}

fn authority_scope_literal(scope: ProjectWorkspaceTurnAuthorityScope) -> &'static str {
    match scope {
        ProjectWorkspaceTurnAuthorityScope::Project => "project",
        ProjectWorkspaceTurnAuthorityScope::Library => "library",
    }
}

fn authority_source_literal(source: ProjectWorkspaceTurnAuthoritySource) -> &'static str {
    match source {
        ProjectWorkspaceTurnAuthoritySource::ProjectTurn => "project_turn",
        ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess => "builtin_full_access",
        ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess => {
            "inherited_builtin_full_access"
        }
    }
}

fn background_source_literal(source: ProjectWorkspaceBackgroundProcessSource) -> &'static str {
    match source {
        ProjectWorkspaceBackgroundProcessSource::AppServer => "app-server",
        ProjectWorkspaceBackgroundProcessSource::TerminalAction => "terminal-action",
    }
}

fn unix_time_millis() -> Result<i64, StoreError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| internal("System clock precedes the Unix epoch"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| internal("System time exceeds SQLite integer range"))
}

fn timestamp_millis(value: &str) -> Result<i64, StoreError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .map_err(|_| corrupt("Turn authority creation time is invalid"))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message.into(), false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message.into(), false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message.into(), false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message.into(), false)
}

#[cfg(test)]
mod tests {
    use super::{normalize_roots_input, valid_workspace_root};

    #[test]
    fn workspace_roots_match_codex_absolute_path_rules() {
        assert!(valid_workspace_root("/workspace/a"));
        assert!(valid_workspace_root("C:\\workspace"));
        assert!(valid_workspace_root("\\\\server\\share"));
        assert!(valid_workspace_root("//server/share"));
        assert!(!valid_workspace_root("relative"));
        assert!(!valid_workspace_root(" /workspace/a "));
        assert!(!valid_workspace_root("//server"));

        assert_eq!(
            normalize_roots_input(&[
                "relative".to_owned(),
                "/workspace/a".to_owned(),
                "/workspace/a".to_owned(),
                "/workspace/b".to_owned(),
            ]),
            ["/workspace/a", "/workspace/b"]
        );
    }
}
