//! Relocates managed execution paths without rewriting prompts, tool results or native IDs.
use crate::Result;
use crate::files::invalid;
use rusqlite::{Connection, params_from_iter};
use std::path::Path;

const THREAD_EVENTS: &[&str] = &[
    "thread.created",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
    "thread.settled",
    "thread.unsettled",
    "thread.snoozed",
    "thread.unsnoozed",
    "thread.pinned",
    "thread.auto-settle-set",
    "thread.unpinned",
    "thread.pin-reordered",
    "thread.active-reordered",
    "thread.visited",
    "thread.marked-unread",
    "thread.metadata-updated",
    "thread.pull-request-synced",
    "thread.runtime-mode-updated",
    "thread.interaction-mode-updated",
    "thread.model-selection-updated",
    "thread.provider-switched",
];

fn has_column(connection: &Connection, table: &str, field: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        [table, field],
        |row| row.get(0),
    )?)
}

fn normalized_value(value: &str) -> String {
    if std::path::MAIN_SEPARATOR == '/' {
        return value.to_owned();
    }
    format!("replace(replace(replace({value},char(92),'/'),'//?/UNC/','//'),'//?/','')")
}
fn owned_path(value: &str, source: &str) -> String {
    format!(
        "({value}={source} OR substr({value},1,length({source})+1)={source} || '/') AND instr({value},'/../')=0 AND instr({value},'/./')=0 AND substr({value},-3)<>'/..' AND substr({value},-2)<>'/.'"
    )
}

fn column(
    connection: &Connection,
    table: &str,
    field: &str,
    source: &str,
    target: &str,
) -> Result<()> {
    if !has_column(connection, table, field)? {
        return Ok(());
    }
    let value = normalized_value(field);
    let condition = owned_path(&value, "?1");
    connection.execute(
        &format!("UPDATE {table} SET {field}=?2 || substr({value},length(?1)+1) WHERE {condition}"),
        [source, target],
    )?;
    Ok(())
}

fn json_field(
    connection: &Connection,
    table: &str,
    field: &str,
    selector: &str,
    events: Option<&[&str]>,
    condition: &str,
    relocation: (&str, &str),
) -> Result<()> {
    let (source, target) = relocation;
    if !has_column(connection, table, field)? {
        return Ok(());
    }
    let events = events.unwrap_or_default();
    let event_filter = if events.is_empty() {
        String::new()
    } else {
        format!(
            "event_type IN ({}) AND ",
            (0..events.len())
                .map(|index| format!("?{}", index + 4))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let value = normalized_value(&format!("json_extract({field},?3)"));
    let owned = owned_path(&value, "?1");
    let sql = format!(
        "UPDATE {table} SET {field}=json_set({field},?3,?2 || substr({value},length(?1)+1)) WHERE {event_filter}{condition} json_type({field},?3)='text' AND {owned}"
    );
    let mut arguments = vec![source, target, selector];
    arguments.extend(events);
    connection.execute(&sql, params_from_iter(arguments))?;
    Ok(())
}

/// Table names, event tags and JSON selectors are execution contracts, never model input.
pub(crate) fn relocate(connection: &Connection, source: &Path, target: &Path) -> Result<()> {
    if !source.is_absolute()
        || !target.is_absolute()
        || [source, target]
            .iter()
            .any(|path| nodex_platform::private_fs::has_traversal(path))
    {
        return Err(invalid(
            "Execution relocation requires canonical absolute Profile paths",
        ));
    }
    let source_key = nodex_platform::private_fs::path_key(source)?;
    let target_key = nodex_platform::private_fs::path_key(target)?;
    let source = source_key.as_str();
    let target = target_key.as_str();
    if source == target {
        return Ok(());
    }
    let transaction = connection.unchecked_transaction()?;
    for (table, field) in [
        ("projection_projects", "workspace_root"),
        ("projection_projects", "favicon_path"),
        ("projection_threads", "worktree_path"),
        ("orchestration_v2_thread_launch_workflows", "worktree_path"),
    ] {
        column(&transaction, table, field, source, target)?;
    }
    for (table, selector) in [
        ("orchestration_v2_projection_threads", "$.worktreePath"),
        ("orchestration_v2_projection_provider_sessions", "$.cwd"),
        ("orchestration_v2_projection_checkpoint_scopes", "$.cwd"),
        (
            "orchestration_v2_projection_subagents",
            "$.workflow.runHandles.transcriptDir",
        ),
        (
            "orchestration_v2_projection_subagents",
            "$.workflow.runHandles.scriptPath",
        ),
    ] {
        json_field(
            &transaction,
            table,
            "payload_json",
            selector,
            None,
            "",
            (source, target),
        )?;
    }
    json_field(
        &transaction,
        "scheduled_tasks",
        "workspace_strategy_json",
        "$.worktreePath",
        None,
        "json_extract(workspace_strategy_json,'$.type')='existing_worktree' AND",
        (source, target),
    )?;
    for table in ["orchestration_events", "orchestration_v2_events"] {
        for (selector, events) in [
            ("$.worktreePath", THREAD_EVENTS),
            (
                "$.cwd",
                &["provider-session.attached", "provider-session.updated"][..],
            ),
            ("$.cwd", &["checkpoint-scope.created"][..]),
            (
                "$.workflow.runHandles.transcriptDir",
                &["subagent.updated"][..],
            ),
            (
                "$.workflow.runHandles.scriptPath",
                &["subagent.updated"][..],
            ),
        ] {
            json_field(
                &transaction,
                table,
                "payload_json",
                selector,
                Some(events),
                "",
                (source, target),
            )?;
        }
    }
    for selector in [
        "$.workspaceRoot",
        "$.faviconPath",
        "$.repositoryIdentity.rootPath",
    ] {
        json_field(
            &transaction,
            "orchestration_events",
            "payload_json",
            selector,
            Some(&["project.created", "project.meta-updated"]),
            "",
            (source, target),
        )?;
    }
    transaction.commit()?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(windows)]
    #[test]
    fn relocates_windows_drive_and_verbatim_paths_without_traversing_siblings() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE projection_projects(workspace_root TEXT)")
            .unwrap();
        let paths = [
            r"C:\source\tasks\a",
            r"\\?\C:\source\tasks\b",
            r"C:\source-other\repo",
            r"C:\source\tasks\..\outside",
        ];
        for path in paths {
            connection
                .execute("INSERT INTO projection_projects VALUES (?1)", [path])
                .unwrap();
        }
        relocate(
            &connection,
            Path::new(r"\\?\C:\source"),
            Path::new(r"C:\clone"),
        )
        .unwrap();
        let mut statement = connection
            .prepare("SELECT workspace_root FROM projection_projects ORDER BY rowid")
            .unwrap();
        let actual = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            actual,
            vec!["C:/clone/tasks/a", "C:/clone/tasks/b", paths[2], paths[3]]
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_literal_backslashes_in_unix_profile_names() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE projection_projects(workspace_root TEXT)")
            .unwrap();
        connection
            .execute(
                "INSERT INTO projection_projects VALUES (?1)",
                [r"/source\literal/tasks/a"],
            )
            .unwrap();
        relocate(
            &connection,
            Path::new(r"/source\literal"),
            Path::new(r"/clone\literal"),
        )
        .unwrap();
        let actual: String = connection
            .query_row(
                "SELECT workspace_root FROM projection_projects",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actual, r"/clone\literal/tasks/a");
    }

    #[test]
    fn relocates_owned_fields_and_replay_without_changing_history_or_external_workspaces() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT); CREATE TABLE orchestration_events(event_type TEXT,payload_json TEXT); CREATE TABLE projection_projects(workspace_root TEXT,favicon_path TEXT); CREATE TABLE scheduled_tasks(workspace_strategy_json TEXT)").unwrap();
        let source = if cfg!(windows) {
            "C:/profile/source"
        } else {
            "/profile/source"
        };
        let target = if cfg!(windows) {
            "C:/profile/clone"
        } else {
            "/profile/clone"
        };
        let body = json!({"worktreePath":format!("{source}/tasks/root"), "message":{"cwd":format!("{source}/do-not-change")}, "nativeThreadRef":"native-id"});
        connection
            .execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES (?1)",
                [body.to_string()],
            )
            .unwrap();
        for (kind, payload) in [
            ("thread.created", body.clone()),
            ("message.updated", body.clone()),
            (
                "project.created",
                json!({"workspaceRoot":"/external/repo", "repositoryIdentity":{"rootPath":format!("{source}/tasks/repo")}}),
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO orchestration_events VALUES (?1,?2)",
                    [kind, &payload.to_string()],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO projection_projects VALUES (?1,?2)",
                [format!("{source}-other/repo"), format!("{source}/icon.png")],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO scheduled_tasks VALUES (?1)",
                [
                    json!({"type":"existing_worktree", "worktreePath":format!("{source}/tasks/a")})
                        .to_string(),
                ],
            )
            .unwrap();
        relocate(&connection, Path::new(source), Path::new(target)).unwrap();
        let projected: String = connection
            .query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let projected: serde_json::Value = serde_json::from_str(&projected).unwrap();
        assert_eq!(projected["worktreePath"], format!("{target}/tasks/root"));
        assert_eq!(projected["message"], body["message"]);
        assert_eq!(projected["nativeThreadRef"], body["nativeThreadRef"]);
        let untouched: String = connection
            .query_row(
                "SELECT payload_json FROM orchestration_events WHERE event_type='message.updated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&untouched).unwrap(),
            body
        );
        let workspace: String = connection
            .query_row(
                "SELECT workspace_root FROM projection_projects",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(workspace, format!("{source}-other/repo"));
        let replay: String = connection.query_row("SELECT json_extract(payload_json,'$.repositoryIdentity.rootPath') FROM orchestration_events WHERE event_type='project.created'", [], |row| row.get(0)).unwrap();
        assert_eq!(replay, format!("{target}/tasks/repo"));
    }
}
