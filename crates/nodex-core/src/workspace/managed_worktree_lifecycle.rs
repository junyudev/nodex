use std::collections::BTreeSet;

use nodex_core_contracts::workspace::{
    ProjectLifecycle, ProjectSource, ProjectWorkspaceManagedWorktreeConsumer,
    ProjectWorkspaceManagedWorktreeLifecycleSnapshot,
    ProjectWorkspaceManagedWorktreeProjectProtection,
};
use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_LIFECYCLE_CONSUMERS: usize = 100_000;
const MAX_LIFECYCLE_PROJECTS: usize = 100_000;

pub(super) fn read_managed_worktree_lifecycle_snapshot(
    connection: &Connection,
    library_id: &str,
    projection_revision: i64,
) -> Result<ProjectWorkspaceManagedWorktreeLifecycleSnapshot, StoreError> {
    let raw_consumers = connection
        .prepare(
            "SELECT thread.thread_id, thread.project_id, link.session_id, \
                    thread.execution_host_id, thread.cwd, thread.managed_worktree_path, \
                    thread.archived, pinned.pinned_order, thread.status_type, \
                    thread.status_active_flags_json, thread.created_at, thread.updated_at, \
                    thread.linked_at \
             FROM codex_threads thread \
             LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id \
             LEFT JOIN codex_pinned_threads pinned ON pinned.thread_id = thread.thread_id \
             LEFT JOIN projects project ON project.id = thread.project_id \
             WHERE thread.managed_worktree_path IS NOT NULL \
               AND length(trim(thread.managed_worktree_path)) > 0 \
               AND (thread.project_id IS NULL OR project.library_id = ?1) \
             ORDER BY thread.execution_host_id, thread.managed_worktree_path, thread.thread_id \
             LIMIT ?2",
        )?
        .query_map(
            params![
                library_id,
                i64::try_from(MAX_LIFECYCLE_CONSUMERS + 1)
                    .expect("lifecycle consumer bound fits i64"),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if raw_consumers.len() > MAX_LIFECYCLE_CONSUMERS {
        return Err(corrupt(
            "Managed worktree lifecycle consumer collection exceeds its Core bound",
        ));
    }

    let mut observed_thread_ids = BTreeSet::new();
    let mut consumers = Vec::with_capacity(raw_consumers.len());
    for row in raw_consumers {
        if !observed_thread_ids.insert(row.0.clone()) {
            return Err(corrupt(
                "A managed worktree Thread is linked to multiple Project Sessions",
            ));
        }
        if row.3.trim() != row.3 || row.3.is_empty() || row.3.len() > 512 {
            return Err(corrupt(
                "A managed worktree Thread has an invalid execution host",
            ));
        }
        if row.6 != 0 && row.6 != 1 {
            return Err(corrupt(
                "A managed worktree Thread has an invalid archive state",
            ));
        }
        let runtime_workspace_roots = super::execution::read_writable_roots(connection, &row.0)?;
        consumers.push(ProjectWorkspaceManagedWorktreeConsumer {
            thread_id: row.0,
            project_id: row.1,
            session_id: row.2,
            execution_host_id: row.3,
            cwd: row.4,
            managed_worktree_path: row.5,
            runtime_workspace_roots,
            archived: row.6 == 1,
            pinned_order: row.7,
            status: super::thread::decode_thread_status(&row.8, &row.9)?,
            created_at: row.10,
            updated_at: row.11,
            linked_at: row.12,
        });
    }

    let raw_projects = connection
        .prepare(
            "SELECT project.id, project.lifecycle \
             FROM projects project \
             WHERE project.library_id = ?1 \
             ORDER BY project.id \
             LIMIT ?2",
        )?
        .query_map(
            params![
                library_id,
                i64::try_from(MAX_LIFECYCLE_PROJECTS + 1)
                    .expect("lifecycle Project bound fits i64"),
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if raw_projects.len() > MAX_LIFECYCLE_PROJECTS {
        return Err(corrupt(
            "Managed worktree lifecycle Project collection exceeds its Core bound",
        ));
    }

    let mut projects = Vec::with_capacity(raw_projects.len());
    for (project_id, lifecycle) in raw_projects {
        let lifecycle = match lifecycle.as_str() {
            "active" => ProjectLifecycle::Active,
            "inactive" => ProjectLifecycle::Inactive,
            "archived" => ProjectLifecycle::Archived,
            _ => return Err(corrupt("Managed worktree Project lifecycle is invalid")),
        };
        let sources = connection
            .prepare(
                "SELECT root, \"order\" FROM project_sources \
                 WHERE project_id = ?1 ORDER BY \"order\", created, root_key",
            )?
            .query_map([&project_id], |row| {
                Ok(ProjectSource::from_identity(row.get(0)?, row.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        projects.push(ProjectWorkspaceManagedWorktreeProjectProtection {
            project_id,
            lifecycle,
            primary_workspace_root: sources
                .first()
                .and_then(ProjectSource::local_path)
                .map(str::to_owned),
            sources,
        });
    }

    Ok(ProjectWorkspaceManagedWorktreeLifecycleSnapshot {
        projection_revision,
        consumers,
        projects,
    })
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
