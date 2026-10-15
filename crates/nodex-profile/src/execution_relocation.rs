//! Relocates managed execution paths without rewriting prompts, tool results or native IDs.
use crate::Result;
use crate::files::invalid;
use rusqlite::{Connection, params_from_iter};
use std::path::{Component, Path};

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
    connection.execute(&format!("UPDATE {table} SET {field}=?2 || substr({field},length(?1)+1) WHERE ({field}=?1 OR substr({field},1,length(?1)+1)=?1 || '/') AND instr({field},'/../')=0 AND instr({field},'/./')=0"), [source, target])?;
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
    let event_filter = events.map_or(String::new(), |events| {
        format!("event_type IN ({}) AND ", vec!["?"; events.len()].join(","))
    });
    let value = format!("json_extract({field},?)");
    let sql = format!(
        "UPDATE {table} SET {field}=json_set({field},?,? || substr({value},length(?)+1)) WHERE {event_filter}{condition} json_type({field},?)='text' AND ({value}=? OR substr({value},1,length(?)+1)=? || '/') AND instr({value},'/../')=0 AND instr({value},'/./')=0"
    );
    let mut arguments = vec![selector, target, selector, source];
    arguments.extend(events.unwrap_or_default());
    arguments.extend([
        selector, selector, source, selector, source, source, selector, selector,
    ]);
    connection.execute(&sql, params_from_iter(arguments))?;
    Ok(())
}

/// Table names, event tags and JSON selectors are execution contracts, never model input.
pub(crate) fn relocate(connection: &Connection, source: &Path, target: &Path) -> Result<()> {
    if !source.is_absolute()
        || !target.is_absolute()
        || [source, target].iter().any(|path| {
            path.components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        })
    {
        return Err(invalid(
            "Execution relocation requires canonical absolute Profile paths",
        ));
    }
    let source = source
        .to_str()
        .ok_or_else(|| invalid("Source Profile path is not UTF-8"))?;
    let target = target
        .to_str()
        .ok_or_else(|| invalid("Target Profile path is not UTF-8"))?;
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

    #[test]
    fn relocates_owned_fields_and_replay_without_changing_history_or_external_workspaces() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT); CREATE TABLE orchestration_events(event_type TEXT,payload_json TEXT); CREATE TABLE projection_projects(workspace_root TEXT,favicon_path TEXT); CREATE TABLE scheduled_tasks(workspace_strategy_json TEXT)").unwrap();
        let source = "/profile/source";
        let target = "/profile/clone";
        let body = json!({"worktreePath":"/profile/source/tasks/root", "message":{"cwd":"/profile/source/do-not-change"}, "nativeThreadRef":"native-id"});
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
                json!({"workspaceRoot":"/external/repo", "repositoryIdentity":{"rootPath":"/profile/source/tasks/repo"}}),
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
                ["/profile/source-other/repo", "/profile/source/icon.png"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO scheduled_tasks VALUES (?1)",
                [
                    json!({"type":"existing_worktree", "worktreePath":"/profile/source/tasks/a"})
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
        assert_eq!(projected["worktreePath"], "/profile/clone/tasks/root");
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
        assert_eq!(workspace, "/profile/source-other/repo");
        let replay: String = connection.query_row("SELECT json_extract(payload_json,'$.repositoryIdentity.rootPath') FROM orchestration_events WHERE event_type='project.created'", [], |row| row.get(0)).unwrap();
        assert_eq!(replay, "/profile/clone/tasks/repo");
    }
}
