use std::collections::BTreeSet;

use nodex_core_contracts::workspace::ProjectWorkspaceProjectActivitySummary;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_PROJECT_ACTIVITY_SUMMARY_PROJECTS: usize = 200;

pub(super) fn read_project_activity_summaries(
    connection: &Connection,
    library_id: &str,
    project_ids: &[String],
) -> Result<Vec<ProjectWorkspaceProjectActivitySummary>, StoreError> {
    validate_project_ids(project_ids)?;
    if project_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut parameters = vec![SqlValue::Text(library_id.to_owned())];
    let requested_values = project_ids
        .iter()
        .enumerate()
        .map(|(ordinal, project_id)| {
            let project_parameter = parameters.len() + 1;
            parameters.push(SqlValue::Text(project_id.clone()));
            let ordinal_parameter = parameters.len() + 1;
            parameters.push(SqlValue::Integer(
                i64::try_from(ordinal).expect("Project activity ordinal fits i64"),
            ));
            format!("(?{project_parameter}, ?{ordinal_parameter})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let waiting_predicate = "thread.status_type = 'active' AND EXISTS (\
      SELECT 1 FROM json_each(thread.status_active_flags_json) flag \
      WHERE flag.value IN ('waitingOnApproval', 'waitingOnUserInput')\
    )";
    let sql = format!(
        "WITH requested(project_id, ordinal) AS (VALUES {requested_values}) \
         SELECT requested.project_id, \
           COUNT(session.id) AS task_count, \
           COALESCE(SUM(CASE WHEN session.id IS NOT NULL AND {waiting_predicate} \
             THEN 1 ELSE 0 END), 0) AS waiting_count, \
           COALESCE(SUM(CASE WHEN session.id IS NOT NULL \
             AND NOT ({waiting_predicate}) AND session.unread = 1 \
             THEN 1 ELSE 0 END), 0) AS unread_count, \
           COALESCE(SUM(CASE WHEN session.id IS NOT NULL \
             AND NOT ({waiting_predicate}) AND session.unread = 0 \
             AND thread.status_type = 'active' THEN 1 ELSE 0 END), 0) AS active_count \
         FROM requested \
         JOIN projects project \
           ON project.id = requested.project_id AND project.library_id = ?1 \
         LEFT JOIN project_sessions session \
           ON session.project_id = project.id AND session.archived = 0 \
         LEFT JOIN project_session_threads link ON link.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         GROUP BY requested.project_id, requested.ordinal \
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
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != project_ids.len() {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "One or more Projects are unavailable in this Library",
            false,
        ));
    }
    rows.into_iter()
        .map(
            |(project_id, task_count, waiting_count, unread_count, active_count)| {
                Ok(ProjectWorkspaceProjectActivitySummary {
                    project_id,
                    task_count: bounded_count(task_count)?,
                    waiting_count: bounded_count(waiting_count)?,
                    unread_count: bounded_count(unread_count)?,
                    active_count: bounded_count(active_count)?,
                })
            },
        )
        .collect()
}

fn validate_project_ids(project_ids: &[String]) -> Result<(), StoreError> {
    if project_ids.len() > MAX_PROJECT_ACTIVITY_SUMMARY_PROJECTS {
        return Err(invalid(
            "Project activity summary request exceeds its fixed bound",
        ));
    }
    let mut unique = BTreeSet::new();
    for project_id in project_ids {
        if project_id.trim().is_empty() || project_id.len() > 512 {
            return Err(invalid("project_id is invalid"));
        }
        if !unique.insert(project_id) {
            return Err(invalid(
                "Project activity summary Project IDs must be unique",
            ));
        }
    }
    Ok(())
}

fn bounded_count(value: i64) -> Result<u32, StoreError> {
    u32::try_from(value).map_err(|_| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Project activity count exceeds its contract bound",
            false,
        )
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::workspace::{ProjectWorkspaceRead, ProjectWorkspaceReadValue};
    use nodex_core_contracts::{
        CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
    };

    use super::MAX_PROJECT_ACTIVITY_SUMMARY_PROJECTS;
    use crate::workspace::test_support::{
        context, create_project, create_session_thread, read, seeded_workspace,
    };

    #[test]
    fn summarizes_complete_project_lanes_with_attention_precedence() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "create-project-a", "project:a");
        create_project(&workspace.module, "create-project-b", "project:b");
        for index in 0..66 {
            create_session_thread(
                &workspace.module,
                &format!("task-{index}"),
                &format!("session:{index:03}"),
                &format!("thread:{index:03}"),
                Some("project:a"),
                index,
            );
        }
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_threads SET status_type = 'active', \
                       status_active_flags_json = '[\"waitingOnApproval\"]' \
                     WHERE thread_id = 'thread:000'",
                    [],
                )?;
                connection.execute(
                    "UPDATE project_sessions SET unread = 1 WHERE id = 'session:000'",
                    [],
                )?;
                connection.execute(
                    "UPDATE codex_threads SET status_type = 'active', \
                       status_active_flags_json = '[]' WHERE thread_id IN ('thread:001', 'thread:002')",
                    [],
                )?;
                connection.execute(
                    "UPDATE project_sessions SET unread = 1 WHERE id = 'session:001'",
                    [],
                )?;
                connection.execute(
                    "UPDATE project_sessions SET archived = 1, archived_at = ?1 \
                     WHERE id = 'session:065'",
                    [crate::workspace::test_support::NOW],
                )?;
                connection.execute(
                    "DELETE FROM project_sessions WHERE project_id = 'project:b'",
                    [],
                )?;
                Ok(())
            })
            .expect("seed activity states");

        let ProjectWorkspaceReadValue::ProjectActivitySummaries {
            summaries,
            projection_revision,
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::ProjectActivitySummaries {
                project_ids: vec!["project:b".to_owned(), "project:a".to_owned()],
            },
        )
        else {
            panic!("Project activity summaries");
        };
        assert!(projection_revision > 0);
        assert_eq!(
            summaries,
            vec![
                nodex_core_contracts::workspace::ProjectWorkspaceProjectActivitySummary {
                    project_id: "project:b".to_owned(),
                    task_count: 0,
                    waiting_count: 0,
                    unread_count: 0,
                    active_count: 0,
                },
                nodex_core_contracts::workspace::ProjectWorkspaceProjectActivitySummary {
                    project_id: "project:a".to_owned(),
                    task_count: 65,
                    waiting_count: 1,
                    unread_count: 1,
                    active_count: 1,
                },
            ]
        );

        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &workspace.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: Some("project:a".to_owned()),
                include_archived: Some(false),
                placement_scope: Default::default(),
                window: nodex_core_contracts::collection::CollectionWindowRequest {
                    after: None,
                    first: Some(5),
                },
            },
        ) else {
            panic!("Task window");
        };
        assert_eq!(tasks.items.len(), 5);
        assert_eq!(summaries[1].task_count, 65);
    }

    #[test]
    fn rejects_unbounded_ambiguous_or_foreign_project_batches() {
        let workspace = seeded_workspace();
        for project_ids in [
            vec!["project:default".to_owned(), "project:default".to_owned()],
            vec![" ".to_owned()],
            (0..=MAX_PROJECT_ACTIVITY_SUMMARY_PROJECTS)
                .map(|index| format!("project:{index}"))
                .collect(),
        ] {
            let error = workspace
                .module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::ProjectActivitySummaries { project_ids },
                    },
                )
                .expect_err("invalid Project activity batch");
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
        }
        let error = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::ProjectActivitySummaries {
                        project_ids: vec!["project:missing".to_owned()],
                    },
                },
            )
            .expect_err("missing Project activity batch");
        assert_eq!(error.code, CoreErrorCode::NotFound);
    }
}
