use nodex_core_contracts::workspace::{
    ProjectLifecycle, ProjectSource, ProjectWorkspaceBootstrap, ProjectWorkspaceBootstrapStatus,
    ProjectWorkspaceExecutionContext, ProjectWorkspaceProject, ProjectWorkspaceRead,
    ProjectWorkspaceReadValue, ProjectWorkspaceSessionSummary,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

use crate::domain::project_appearance::project_appearance_from_storage;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::execution;
use super::thread::{read_permission_mode, read_projectless_permission_mode, read_thread};

const MAX_ID_LENGTH: usize = 512;

pub(super) struct ProjectRow {
    pub(super) id: String,
    pub(super) library_id: String,
    pub(super) database_id: Option<String>,
    pub(super) lifecycle: String,
    pub(super) binding_revision: i64,
    pub(super) name: String,
    pub(super) description: String,
    pub(super) appearance_color: String,
    pub(super) appearance_marker_kind: String,
    pub(super) appearance_marker_value: String,
    pub(super) pinned_order: Option<i64>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) default_database_view_id: Option<String>,
}

struct SessionRow {
    id: String,
    project_id: Option<String>,
    fallback_title: String,
    order: i64,
    pinned: i64,
    pinned_order: Option<i64>,
    archived: i64,
    archived_at: Option<String>,
    unread: i64,
    thread_id: Option<String>,
    thread_name: Option<String>,
    thread_preview: Option<String>,
    created_at: String,
    updated_at: String,
}

pub(super) fn read(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    assets_root: &Path,
    request: ProjectWorkspaceRead,
) -> Result<ProjectWorkspaceReadValue, StoreError> {
    match request {
        ProjectWorkspaceRead::ProjectBootstrap => {
            let project_count = connection.query_row(
                "SELECT count(*) FROM projects WHERE library_id = ?1",
                [library_id],
                |row| row.get::<_, i64>(0),
            )?;
            Ok(ProjectWorkspaceReadValue::ProjectBootstrap {
                bootstrap: ProjectWorkspaceBootstrap {
                    status: if project_count == 0 {
                        ProjectWorkspaceBootstrapStatus::Empty
                    } else {
                        ProjectWorkspaceBootstrapStatus::Ready
                    },
                },
            })
        }
        ProjectWorkspaceRead::ProjectWindow {
            include_archived,
            window,
        } => Ok(ProjectWorkspaceReadValue::ProjectWindow {
            projects: super::project_window::read_project_window(
                connection,
                library_id,
                commit_head,
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::Project { project_id } => {
            validate_id("project_id", &project_id)?;
            Ok(ProjectWorkspaceReadValue::Project {
                project: read_project(connection, library_id, &project_id)?
                    .ok_or_else(|| not_found("Project is unavailable in this Library"))?,
            })
        }
        ProjectWorkspaceRead::ProjectActivitySummaries { project_ids } => {
            Ok(ProjectWorkspaceReadValue::ProjectActivitySummaries {
                summaries: super::project_activity_summary::read_project_activity_summaries(
                    connection,
                    library_id,
                    &project_ids,
                )?,
                projection_revision: commit_head,
            })
        }
        ProjectWorkspaceRead::PageChatActivitySummaries {
            page_access_project_id,
            page_ids,
        } => Ok(ProjectWorkspaceReadValue::PageChatActivitySummaries {
            summaries: super::page_chat::read_page_chat_activity_summaries(
                connection,
                library_id,
                &page_access_project_id,
                &page_ids,
            )?,
            projection_revision: commit_head,
        }),
        ProjectWorkspaceRead::PageChatWindow {
            page_access_project_id,
            page_id,
            include_archived,
            window,
        } => Ok(ProjectWorkspaceReadValue::PageChatWindow {
            chats: super::page_chat::read_page_chat_window(
                connection,
                library_id,
                commit_head,
                &page_access_project_id,
                &page_id,
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::ProjectPermissionMode { project_id } => {
            validate_id("project_id", &project_id)?;
            require_project(connection, library_id, &project_id)?;
            Ok(ProjectWorkspaceReadValue::ProjectPermissionMode {
                mode: read_permission_mode(connection, &project_id)?,
            })
        }
        ProjectWorkspaceRead::ProjectlessPermissionMode => {
            Ok(ProjectWorkspaceReadValue::ProjectlessPermissionMode {
                mode: read_projectless_permission_mode(connection)?,
            })
        }
        ProjectWorkspaceRead::TaskWindow {
            project_id,
            include_archived,
            window,
        } => Ok(ProjectWorkspaceReadValue::TaskWindow {
            tasks: super::task_window::read_task_window(
                connection,
                library_id,
                commit_head,
                project_id.as_deref(),
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::SidebarOverview {
            include_archived,
            pinned_window,
        } => Ok(ProjectWorkspaceReadValue::SidebarOverview {
            pinned_tasks: super::task_window::read_pinned_task_window(
                connection,
                library_id,
                commit_head,
                include_archived.unwrap_or(false),
                &pinned_window,
            )?,
        }),
        ProjectWorkspaceRead::SidebarSectionWindow {
            include_deleted,
            window,
        } => Ok(ProjectWorkspaceReadValue::SidebarSectionWindow {
            sections: super::sidebar_section::read_section_window(
                connection,
                library_id,
                commit_head,
                include_deleted.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::SidebarSectionItemWindow {
            section_id,
            include_archived,
            window,
        } => Ok(ProjectWorkspaceReadValue::SidebarSectionItemWindow {
            items: super::sidebar_section::read_section_item_window(
                connection,
                library_id,
                commit_head,
                &section_id,
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::SidebarSectionPlacement { item } => {
            Ok(ProjectWorkspaceReadValue::SidebarSectionPlacement {
                section_id: super::sidebar_section::read_direct_placement(
                    connection, library_id, &item,
                )?,
            })
        }
        ProjectWorkspaceRead::SidebarSectionHostLinkWindow { host_id, window } => {
            Ok(ProjectWorkspaceReadValue::SidebarSectionHostLinkWindow {
                links: super::sidebar_section::read_host_link_window(
                    connection,
                    library_id,
                    commit_head,
                    &host_id,
                    &window,
                )?,
            })
        }
        ProjectWorkspaceRead::Session { session_id } => {
            validate_id("session_id", &session_id)?;
            let row = read_session(connection, library_id, &session_id)?
                .ok_or_else(|| not_found("Project Session is unavailable"))?;
            Ok(ProjectWorkspaceReadValue::Session {
                session: session_summary(row),
            })
        }
        ProjectWorkspaceRead::Thread { thread_id } => {
            validate_id("thread_id", &thread_id)?;
            Ok(ProjectWorkspaceReadValue::Thread {
                thread: Box::new(
                    read_thread(connection, library_id, &thread_id)?
                        .ok_or_else(|| not_found("Codex Thread is unavailable in this Library"))?,
                ),
            })
        }
        ProjectWorkspaceRead::QueuedFollowUpLedger { thread_id } => {
            validate_id("thread_id", &thread_id)?;
            Ok(ProjectWorkspaceReadValue::QueuedFollowUpLedger {
                ledger: super::queued_follow_up::read_ledger(
                    connection,
                    library_id,
                    &thread_id,
                    assets_root,
                )?,
            })
        }
        ProjectWorkspaceRead::ChildThreadWindow {
            parent_thread_id,
            include_archived,
            window,
        } => Ok(ProjectWorkspaceReadValue::ChildThreadWindow {
            threads: super::child_thread_window::read_child_thread_window(
                connection,
                library_id,
                commit_head,
                &parent_thread_id,
                include_archived.unwrap_or(false),
                &window,
            )?,
        }),
        ProjectWorkspaceRead::ExecutionContext { thread_id } => {
            validate_id("thread_id", &thread_id)?;
            let thread = read_thread(connection, library_id, &thread_id)?
                .ok_or_else(|| not_found("Codex Thread is unavailable in this Library"))?;
            let project = thread
                .project_id
                .as_deref()
                .map(|project_id| {
                    read_project(connection, library_id, project_id)?.ok_or_else(|| {
                        corrupt("Codex Thread Project is unavailable in its Library")
                    })
                })
                .transpose()?;
            let permission_mode = match thread.project_id.as_deref() {
                Some(project_id) => read_permission_mode(connection, project_id)?,
                None => read_projectless_permission_mode(connection)?,
            };
            Ok(ProjectWorkspaceReadValue::ExecutionContext {
                context: Box::new(ProjectWorkspaceExecutionContext {
                    thread,
                    project,
                    permission_mode,
                }),
            })
        }
        ProjectWorkspaceRead::TurnAuthority {
            thread_id,
            turn_id,
            root_thread_id,
            actor_project_id,
        } => Ok(ProjectWorkspaceReadValue::TurnAuthority {
            resolution: execution::resolve_turn_authority(
                connection,
                library_id,
                &thread_id,
                &turn_id,
                &root_thread_id,
                &actor_project_id,
            )?,
        }),
        ProjectWorkspaceRead::BackgroundProcessWindow { thread_id, window } => {
            Ok(ProjectWorkspaceReadValue::BackgroundProcessWindow {
                processes: execution::read_background_process_window(
                    connection,
                    library_id,
                    commit_head,
                    thread_id.as_deref(),
                    &window,
                )?,
            })
        }
        ProjectWorkspaceRead::ManagedWorktreeWindow { project_id, window } => {
            Ok(ProjectWorkspaceReadValue::ManagedWorktreeWindow {
                worktrees: super::managed_worktree_window::read_managed_worktree_window(
                    connection,
                    library_id,
                    commit_head,
                    project_id.as_deref(),
                    &window,
                )?,
            })
        }
        ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot => Ok(
            ProjectWorkspaceReadValue::ManagedWorktreeLifecycleSnapshot {
                snapshot:
                    super::managed_worktree_lifecycle::read_managed_worktree_lifecycle_snapshot(
                        connection,
                        library_id,
                        commit_head,
                    )?,
            },
        ),
    }
}

pub(super) fn read_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<Option<ProjectWorkspaceProject>, StoreError> {
    connection
        .query_row(
            "SELECT project.id, project.library_id, project.database_block_id, \
               project.lifecycle, project.binding_revision, project.name, project.description, \
               project.appearance_color, project.appearance_marker_kind, \
               project.appearance_marker_value, pinned.\"order\", project.created, project.updated, \
               default_view.id \
             FROM projects project \
             LEFT JOIN pinned_project_order pinned ON pinned.project_id = project.id \
             LEFT JOIN database_containers container \
               ON container.block_id = project.database_block_id \
             LEFT JOIN database_views default_view \
               ON default_view.id = container.default_view_id \
              AND default_view.lifecycle = 'active' \
             WHERE project.id = ?1 AND project.library_id = ?2",
            params![project_id, library_id],
            project_row,
        )
        .optional()?
        .map(|row| project(connection, row))
        .transpose()
}

pub(super) fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get(0)?,
        library_id: row.get(1)?,
        database_id: row.get(2)?,
        lifecycle: row.get(3)?,
        binding_revision: row.get(4)?,
        name: row.get(5)?,
        description: row.get(6)?,
        appearance_color: row.get(7)?,
        appearance_marker_kind: row.get(8)?,
        appearance_marker_value: row.get(9)?,
        pinned_order: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        default_database_view_id: row.get(13)?,
    })
}

pub(super) fn project(
    connection: &Connection,
    row: ProjectRow,
) -> Result<ProjectWorkspaceProject, StoreError> {
    let database_id = row
        .database_id
        .ok_or_else(|| corrupt("Project has no primary Database binding"))?;
    let lifecycle = match row.lifecycle.as_str() {
        "active" => ProjectLifecycle::Active,
        "inactive" => ProjectLifecycle::Inactive,
        "archived" => ProjectLifecycle::Archived,
        _ => return Err(corrupt("Project lifecycle is invalid")),
    };
    let appearance = project_appearance_from_storage(
        &row.appearance_color,
        &row.appearance_marker_kind,
        &row.appearance_marker_value,
    )
    .map_err(corrupt)?;
    let sources = connection
        .prepare(
            "SELECT root, \"order\" FROM project_sources \
             WHERE project_id = ?1 ORDER BY \"order\", created, root_key",
        )?
        .query_map([&row.id], |source| {
            Ok(ProjectSource {
                root: source.get(0)?,
                order: source.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ProjectWorkspaceProject {
        id: row.id,
        library_id: row.library_id,
        database_id,
        default_database_view_id: row.default_database_view_id,
        lifecycle,
        binding_revision: row.binding_revision,
        name: row.name,
        description: row.description,
        appearance,
        primary_workspace_root: sources.first().map(|source| source.root.clone()),
        sources,
        pinned: row.pinned_order.is_some(),
        pinned_order: row.pinned_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn read_session(
    connection: &Connection,
    library_id: &str,
    session_id: &str,
) -> Result<Option<SessionRow>, StoreError> {
    connection
        .query_row(
            "SELECT session.id, session.project_id, session.no_thread_fallback_title, \
               session.\"order\", session.pinned, session.pinned_order, session.archived, \
               session.archived_at, session.unread, \
               thread.thread_id, thread.thread_name, \
               thread.thread_preview, session.created_at, session.updated_at \
             FROM project_sessions session \
             LEFT JOIN project_session_threads link ON link.session_id = session.id \
             LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
             WHERE session.id = ?1 \
               AND (session.project_id IS NULL OR EXISTS (\
                 SELECT 1 FROM projects owner \
                 WHERE owner.id = session.project_id AND owner.library_id = ?2\
               ))",
            params![session_id, library_id],
            session_row,
        )
        .optional()
        .map_err(Into::into)
}

fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        fallback_title: row.get(2)?,
        order: row.get(3)?,
        pinned: row.get(4)?,
        pinned_order: row.get(5)?,
        archived: row.get(6)?,
        archived_at: row.get(7)?,
        unread: row.get(8)?,
        thread_id: row.get(9)?,
        thread_name: row.get(10)?,
        thread_preview: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn session_summary(row: SessionRow) -> ProjectWorkspaceSessionSummary {
    let display_title = project_session_display_title(
        row.thread_name.as_deref(),
        row.thread_preview.as_deref(),
        &row.fallback_title,
    );
    ProjectWorkspaceSessionSummary {
        id: row.id,
        project_id: row.project_id,
        no_thread_fallback_title: row.fallback_title,
        display_title,
        order: row.order,
        pinned: row.pinned == 1,
        pinned_order: row.pinned_order,
        archived: row.archived == 1,
        archived_at: row.archived_at,
        unread: row.unread == 1,
        thread_id: row.thread_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) fn project_session_display_title(
    thread_name: Option<&str>,
    thread_preview: Option<&str>,
    fallback_title: &str,
) -> String {
    [thread_name, thread_preview, Some(fallback_title)]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|title| !title.is_empty())
        .unwrap_or("New thread")
        .to_owned()
}

fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    if connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    Err(not_found("Project is unavailable in this Library"))
}

fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    if !value.trim().is_empty() && value.len() <= MAX_ID_LENGTH {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::InvalidInput,
        format!("{name} must contain 1 to {MAX_ID_LENGTH} bytes"),
        false,
    ))
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
        ProjectMarker, ProjectMarkerColor, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, CoreErrorCode, LibraryId, ModuleReadRequest,
        PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, ProjectId,
    };
    use tempfile::{TempDir, tempdir};

    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::workspace::ProjectWorkspaceModule;

    const NOW: &str = "2026-07-19T03:30:00.000Z";

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:workspace-read".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn seeded_module() -> (TempDir, SqliteStoreKernel, ProjectWorkspaceModule) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile-foreign', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-foreign', 'profile-foreign', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute_batch(
                        "INSERT INTO projects( \
                           id, library_id, database_block_id, lifecycle, binding_revision, \
                           name, description, appearance_color, appearance_marker_kind, \
                           appearance_marker_value, created, updated \
                         ) VALUES \
                           ('project-1', 'library-1', 'database-1', 'active', 3, \
                            'Workspace', 'Primary project', 'black', 'emoji', '🚀', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:31:00.000Z'), \
                           ('project-2', 'library-1', 'database-2', 'archived', 2, \
                            'Archived', '', 'black', 'icon', 'folder', \
                            '2026-07-19T03:32:00.000Z', '2026-07-19T03:32:00.000Z'), \
                           ('project-foreign', 'library-foreign', 'database-foreign', 'active', 1, \
                            'Foreign', '', 'black', 'icon', 'folder', \
                            '2026-07-19T03:33:00.000Z', '2026-07-19T03:33:00.000Z'); \
                         INSERT INTO project_order(project_id, \"order\", updated) VALUES \
                           ('project-1', 0, '2026-07-19T03:31:00.000Z'), \
                           ('project-2', 1, '2026-07-19T03:32:00.000Z'); \
                         INSERT INTO pinned_project_order(project_id, \"order\", updated) \
                           VALUES ('project-1', 4, '2026-07-19T03:31:00.000Z'); \
                         INSERT INTO project_sources( \
                           project_id, root, root_key, \"order\", created, updated \
                         ) VALUES \
                           ('project-1', '/workspace/one', '/workspace/one', 0, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('project-1', '/workspace/two', '/workspace/two', 1, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO blocks( \
                           id, library_id, type, lifecycle, placement_revision, \
                           metadata_revision, created_at, updated_at \
                         ) VALUES \
                           ('database-1', 'library-1', 'database', 'active', 1, 1, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('database-2', 'library-1', 'database', 'active', 1, 1, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO library_block_placements( \
                           block_id, library_id, rank_key, revision, created_at, updated_at \
                         ) VALUES \
                           ('database-1', 'library-1', '3fffffffffffffffffffffffffffffff', 1, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('database-2', 'library-1', '7fffffffffffffffffffffffffffffff', 1, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO database_containers( \
                           block_id, library_id, name, lifecycle, created_at, updated_at \
                         ) VALUES \
                           ('database-1', 'library-1', 'Primary DB', 'active', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('database-2', 'library-1', 'Secondary DB', 'active', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO data_sources( \
                           id, library_id, home_database_block_id, name, schema_key, \
                           lifecycle, rank_key, created_at, updated_at \
                         ) VALUES \
                           ('source-1', 'library-1', 'database-1', 'Source', 'nodex.database', \
                            'active', 'a', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('source-2', 'library-1', 'database-2', 'Source', 'nodex.database', \
                            'active', 'a', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO database_views( \
                           id, database_block_id, data_source_id, name, layout, config_json, \
                           rank_key, lifecycle, created_at, updated_at \
                         ) VALUES \
                           ('view-1', 'database-1', 'source-1', 'Board', 'board', '{}', \
                            'a', 'active', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'), \
                           ('view-2', 'database-2', 'source-2', 'Board', 'board', '{}', \
                            'a', 'deleted', \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         UPDATE database_containers SET default_view_id = 'view-1' \
                           WHERE block_id = 'database-1'; \
                         INSERT INTO project_sessions( \
                           id, project_id, no_thread_fallback_title, \"order\", pinned, \
                           pinned_order, archived, archived_at, unread, created_at, updated_at \
                         ) VALUES \
                           ('session-project', 'project-1', 'Fallback', 2, 1, 0, 0, NULL, 1, \
                            '2026-07-19T03:31:00.000Z', '2026-07-19T03:34:00.000Z'), \
                           ('session-archived', 'project-1', 'Archived session', 3, 0, NULL, 1, \
                            '2026-07-19T03:35:00.000Z', 0, \
                            '2026-07-19T03:32:00.000Z', '2026-07-19T03:35:00.000Z'), \
                           ('session-archived-project', 'project-2', 'Archived project', 0, 0, \
                            NULL, 0, NULL, 0, \
                            '2026-07-19T03:32:00.000Z', '2026-07-19T03:35:00.000Z'), \
                           ('session-foreign', 'project-foreign', 'Foreign session', 0, 0, NULL, \
                            0, NULL, 0, \
                            '2026-07-19T03:33:00.000Z', '2026-07-19T03:33:00.000Z'), \
                           ('session-projectless', NULL, 'Projectless', 0, 0, NULL, 0, NULL, 0, \
                            '2026-07-19T03:30:00.000Z', '2026-07-19T03:30:00.000Z'); \
                         INSERT INTO codex_threads( \
                           thread_id, project_id, thread_name, thread_preview, model_provider, \
                           managed_worktree_path, status_type, status_active_flags_json, archived, \
                           created_at, updated_at, recency_at, linked_at \
                         ) VALUES \
                           ('thread-1', 'project-1', '', 'Thread preview', 'openai', \
                            '/worktrees/shared', 'idle', '[]', 0, 1, 2, 2, \
                            '2026-07-19T03:33:00.000Z'), \
                           ('thread-2', 'project-1', 'Other', '', 'openai', \
                            '/worktrees/shared', 'idle', '[]', 0, 1, 2, 2, \
                            '2026-07-19T03:33:00.000Z'), \
                           ('thread-3', 'project-1', 'Third', '', 'openai', \
                            '/worktrees/zeta', 'idle', '[]', 0, 1, 2, 2, \
                            '2026-07-19T03:33:00.000Z'), \
                           ('thread-foreign', 'project-foreign', 'Foreign', '', 'openai', \
                            '/worktrees/foreign', 'idle', '[]', 0, 1, 2, 2, \
                            '2026-07-19T03:33:00.000Z'); \
                         INSERT INTO project_session_threads(session_id, thread_id, linked_at) \
                           VALUES ('session-project', 'thread-1', \
                            '2026-07-19T03:33:00.000Z'), \
                           ('session-foreign', 'thread-foreign', \
                            '2026-07-19T03:33:00.000Z');",
                    )?;
                    crate::database::create_page_key_namespace(
                        transaction,
                        "library-1",
                        "database-1",
                        None,
                        "Workspace",
                        NOW,
                    )?;
                    crate::database::create_page_key_namespace(
                        transaction,
                        "library-1",
                        "database-2",
                        None,
                        "Archived",
                        NOW,
                    )?;
                    Ok(())
                })
            })
            .expect("seed Workspace");
        let module = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        (directory, kernel, module)
    }

    fn read(
        module: &ProjectWorkspaceModule,
        read: ProjectWorkspaceRead,
    ) -> ProjectWorkspaceReadValue {
        module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read,
                },
            )
            .expect("Workspace read")
            .value
    }

    #[test]
    fn reads_coherent_project_task_thread_and_worktree_snapshots() {
        let (_directory, _kernel, module) = seeded_module();
        let ProjectWorkspaceReadValue::ProjectWindow { projects } = read(
            &module,
            ProjectWorkspaceRead::ProjectWindow {
                include_archived: Some(false),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("Project window");
        };
        let projects = projects.items;
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "project-1");
        assert_eq!(projects[0].database_id, "database-1");
        assert_eq!(
            projects[0].default_database_view_id.as_deref(),
            Some("view-1")
        );
        assert_eq!(projects[0].binding_revision, 3);
        assert_eq!(projects[0].appearance.color, ProjectMarkerColor::Black);
        assert_eq!(
            projects[0].appearance.marker,
            ProjectMarker::Emoji {
                emoji: "🚀".to_owned(),
            }
        );
        assert_eq!(
            projects[0].primary_workspace_root.as_deref(),
            Some("/workspace/one")
        );
        assert_eq!(projects[0].sources.len(), 2);
        assert!(projects[0].pinned);
        assert_eq!(projects[0].pinned_order, Some(4));
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: Some("project-1".to_owned()),
                include_archived: Some(true),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("Project task window");
        };
        assert_eq!(tasks.items.len(), 2);
        assert!(tasks.items.iter().any(|task| task.session.archived));
        let linked = tasks
            .items
            .iter()
            .find(|task| task.session.id == "session-project")
            .expect("linked Project task");
        assert_eq!(linked.session.display_title, "Thread preview");
        assert!(linked.session.unread);
        assert_eq!(
            linked
                .thread
                .as_ref()
                .map(|thread| thread.thread_id.as_str()),
            Some("thread-1")
        );

        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: None,
                include_archived: None,
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("Projectless task window");
        };
        assert_eq!(tasks.items.len(), 1);
        assert_eq!(tasks.items[0].session.id, "session-projectless");

        let ProjectWorkspaceReadValue::ProjectWindow { projects } = read(
            &module,
            ProjectWorkspaceRead::ProjectWindow {
                include_archived: Some(true),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("all Project window");
        };
        assert_eq!(projects.items.len(), 2);
        assert_eq!(projects.items[1].binding_revision, 2);
        assert_eq!(projects.items[1].default_database_view_id, None);

        let ProjectWorkspaceReadValue::Project { project } = read(
            &module,
            ProjectWorkspaceRead::Project {
                project_id: "project-2".to_owned(),
            },
        ) else {
            panic!("project snapshot");
        };
        assert_eq!(
            project.lifecycle,
            nodex_core_contracts::workspace::ProjectLifecycle::Archived
        );
        assert_eq!(project.default_database_view_id, None);

        let ProjectWorkspaceReadValue::Session { session } = read(
            &module,
            ProjectWorkspaceRead::Session {
                session_id: "session-project".to_owned(),
            },
        ) else {
            panic!("session snapshot");
        };
        assert_eq!(session.display_title, "Thread preview");

        let ProjectWorkspaceReadValue::Thread { thread } = read(
            &module,
            ProjectWorkspaceRead::Thread {
                thread_id: "thread-1".to_owned(),
            },
        ) else {
            panic!("thread snapshot");
        };
        assert_eq!(thread.session_id.as_deref(), Some("session-project"));
        assert_eq!(thread.project_id.as_deref(), Some("project-1"));

        let ProjectWorkspaceReadValue::ManagedWorktreeWindow { worktrees } = read(
            &module,
            ProjectWorkspaceRead::ManagedWorktreeWindow {
                project_id: Some("project-1".to_owned()),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(50),
                },
            },
        ) else {
            panic!("managed worktrees snapshot");
        };
        assert_eq!(
            worktrees
                .items
                .iter()
                .map(|worktree| worktree.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/worktrees/shared", "/worktrees/zeta"]
        );

        let foreign_session = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::Session {
                        session_id: "session-foreign".to_owned(),
                    },
                },
            )
            .expect_err("foreign Library Session must remain hidden");
        assert_eq!(foreign_session.code, CoreErrorCode::NotFound);

        let foreign_thread = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::Thread {
                        thread_id: "thread-foreign".to_owned(),
                    },
                },
            )
            .expect_err("foreign Library Thread must remain hidden");
        assert_eq!(foreign_thread.code, CoreErrorCode::NotFound);
    }

    #[test]
    fn fails_closed_for_adapter_identity() {
        let (_directory, _kernel, module) = seeded_module();
        let mut foreign = context();
        foreign.library_id = LibraryId("library-foreign".to_owned());
        let unauthorized = module
            .read(
                &foreign,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::ProjectWindow {
                        include_archived: Some(false),
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(50),
                        },
                    },
                },
            )
            .expect_err("reject foreign Adapter identity");
        assert_eq!(unauthorized.code, CoreErrorCode::Unauthorized);
    }
}
