use std::collections::HashMap;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryAccess, LibraryInheritedProjectAccessSource, LibraryProjectAccessRow,
    LibraryProjectDirectGrant, LibraryResourceProjectAccess, LibraryResourceTarget,
};
use nodex_core_contracts::workspace::ProjectLifecycle;
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::project_appearance::project_appearance_from_storage;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

struct TargetCoordinates {
    target_kind: &'static str,
    target_id: String,
    ancestor_pages: HashMap<String, String>,
    owning_database: Option<(String, String)>,
}

type ProjectGrantRow = (String, String, String, i64);

struct PageHierarchy {
    pages: HashMap<String, String>,
    owning_database: Option<(String, String)>,
}

pub(super) fn read(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    target: LibraryResourceTarget,
) -> Result<LibraryResourceProjectAccess, StoreError> {
    super::require_trusted_library_authority(context)?;

    let coordinates = target_coordinates(connection, library_id, &target)?;
    let project_rows = connection
        .prepare(
            "SELECT project.id, project.name, project.lifecycle, \
               COALESCE(project.database_block_id, ( \
                 SELECT binding.database_block_id FROM project_database_bindings binding \
                 WHERE binding.project_id = project.id AND binding.library_id = project.library_id \
                   AND binding.lifecycle = 'active' \
               )), project.appearance_color, \
               appearance_marker_kind, appearance_marker_value \
             FROM projects project WHERE project.library_id = ?1 \
             ORDER BY CASE lifecycle WHEN 'active' THEN 0 WHEN 'inactive' THEN 1 ELSE 2 END, \
               name COLLATE NOCASE, id",
        )?
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let grant_rows = connection
        .prepare(
            "SELECT grant_row.project_id, grant_row.root_kind, grant_row.root_id, \
               grant_row.access, grant_row.revision \
             FROM project_resource_grants grant_row \
             JOIN projects project ON project.id = grant_row.project_id \
             WHERE project.library_id = ?1 AND grant_row.lifecycle = 'active' \
             ORDER BY grant_row.project_id, \
               CASE grant_row.access WHEN 'read_write' THEN 0 ELSE 1 END, \
               CASE grant_row.root_kind WHEN 'page' THEN 0 ELSE 1 END, grant_row.root_id",
        )?
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ),
            ))
        })?
        .collect::<rusqlite::Result<Vec<(String, ProjectGrantRow)>>>()?;
    let mut grants_by_project = HashMap::<String, Vec<ProjectGrantRow>>::new();
    for (project_id, grant) in grant_rows {
        grants_by_project.entry(project_id).or_default().push(grant);
    }

    let mut projects = Vec::with_capacity(project_rows.len());
    for (
        project_id,
        project_name,
        lifecycle,
        primary_database_id,
        color,
        marker_kind,
        marker_value,
    ) in project_rows
    {
        let lifecycle = project_lifecycle(&lifecycle)?;
        let appearance = project_appearance_from_storage(&color, &marker_kind, &marker_value)
            .map_err(corrupt)?;
        let grants = grants_by_project.remove(&project_id).unwrap_or_default();

        let direct_grant = grants
            .iter()
            .find(|(kind, id, _, _)| {
                kind == coordinates.target_kind && id == &coordinates.target_id
            })
            .map(|(_, _, access, revision)| -> Result<_, StoreError> {
                Ok(LibraryProjectDirectGrant {
                    access: parse_access(access)?,
                    revision: *revision,
                })
            })
            .transpose()?;

        let mut inherited_sources = Vec::new();
        if let Some((database_id, database_name)) = &coordinates.owning_database
            && primary_database_id.as_deref() == Some(database_id.as_str())
        {
            inherited_sources.push(LibraryInheritedProjectAccessSource::PrimaryDatabase {
                database_id: database_id.clone(),
                database_name: database_name.clone(),
                access: LibraryAccess::ReadWrite,
            });
        }
        for (kind, id, access, _) in &grants {
            let access = parse_access(access)?;
            if kind == coordinates.target_kind && id == &coordinates.target_id {
                continue;
            }
            if kind == "page" {
                if let Some(page_title) = coordinates.ancestor_pages.get(id) {
                    inherited_sources.push(LibraryInheritedProjectAccessSource::AncestorPage {
                        page_id: id.clone(),
                        page_title: page_title.clone(),
                        access,
                    });
                }
                continue;
            }
            if kind == "database"
                && let Some((database_id, database_name)) = &coordinates.owning_database
                && id == database_id
            {
                inherited_sources.push(LibraryInheritedProjectAccessSource::DatabaseGrant {
                    database_id: database_id.clone(),
                    database_name: database_name.clone(),
                    access,
                });
            }
        }
        inherited_sources.sort_by_key(|source| match source_access(source) {
            LibraryAccess::ReadWrite => 0,
            LibraryAccess::Read => 1,
        });
        let effective_access = direct_grant
            .as_ref()
            .map(|grant| grant.access)
            .into_iter()
            .chain(inherited_sources.iter().map(source_access))
            .max_by_key(|access| access_strength(*access));
        let effective_access = if lifecycle == ProjectLifecycle::Active {
            effective_access
        } else {
            effective_access.map(|_| LibraryAccess::Read)
        };

        projects.push(LibraryProjectAccessRow {
            project_id,
            project_name,
            appearance,
            lifecycle,
            direct_grant,
            inherited_sources,
            effective_access,
        });
    }

    Ok(LibraryResourceProjectAccess { target, projects })
}

fn target_coordinates(
    connection: &Connection,
    library_id: &str,
    target: &LibraryResourceTarget,
) -> Result<TargetCoordinates, StoreError> {
    match target {
        LibraryResourceTarget::File { file_id } => {
            super::files::metadata(connection, library_id, file_id)?;
            Ok(TargetCoordinates {
                target_kind: "file",
                target_id: file_id.clone(),
                ancestor_pages: HashMap::new(),
                owning_database: None,
            })
        }
        LibraryResourceTarget::Database { database_id } => {
            let (name, containing_document_id) = connection
                .query_row(
                    "SELECT container.name, block_index.document_id \
                     FROM database_containers container \
                     JOIN blocks block ON block.id = container.block_id \
                     LEFT JOIN document_block_index block_index ON block_index.block_id = block.id \
                     WHERE container.block_id = ?1 AND container.library_id = ?2 \
                       AND block.library_id = container.library_id \
                       AND block.lifecycle <> 'deleted' \
                       AND container.lifecycle <> 'deleted'",
                    params![database_id, library_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()?
                .ok_or_else(not_found)?;
            let ancestor_pages = if let Some(document_id) = containing_document_id {
                let owner_page_id = connection
                    .query_row(
                        "SELECT page.block_id FROM block_documents ownership \
                         JOIN pages page ON page.block_id = ownership.block_id \
                         WHERE ownership.document_id = ?1 AND page.library_id = ?2",
                        params![document_id, library_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| corrupt("Embedded Database has no owning Page"))?;
                page_hierarchy(connection, library_id, &owner_page_id)?.pages
            } else {
                HashMap::new()
            };
            Ok(TargetCoordinates {
                target_kind: "database",
                target_id: database_id.clone(),
                ancestor_pages,
                owning_database: Some((database_id.clone(), name)),
            })
        }
        LibraryResourceTarget::Page { page_id } => {
            page_coordinates(connection, library_id, page_id)
        }
        LibraryResourceTarget::Canvas { canvas_id } => {
            let containing_document_id = connection
                .query_row(
                    "SELECT block_index.document_id \
                     FROM canvas_owners canvas \
                     JOIN blocks block ON block.id = canvas.block_id \
                       AND block.library_id = canvas.library_id \
                     LEFT JOIN document_block_index block_index ON block_index.block_id = block.id \
                     WHERE canvas.block_id = ?1 AND canvas.library_id = ?2 \
                       AND block.type = 'canvas' AND block.lifecycle <> 'deleted'",
                    params![canvas_id, library_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .ok_or_else(not_found)?;
            let hierarchy = containing_document_id
                .map(|document_id| {
                    let owner_page_id = connection
                        .query_row(
                            "SELECT page.block_id FROM block_documents ownership \
                             JOIN pages page ON page.block_id = ownership.block_id \
                               AND page.library_id = ownership.library_id \
                             WHERE ownership.document_id = ?1 AND ownership.library_id = ?2",
                            params![document_id, library_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| corrupt("Embedded Canvas has no owning Page"))?;
                    page_hierarchy(connection, library_id, &owner_page_id)
                })
                .transpose()?;
            Ok(TargetCoordinates {
                target_kind: "canvas",
                target_id: canvas_id.clone(),
                ancestor_pages: hierarchy
                    .as_ref()
                    .map(|hierarchy| hierarchy.pages.clone())
                    .unwrap_or_default(),
                owning_database: hierarchy.and_then(|hierarchy| hierarchy.owning_database),
            })
        }
    }
}

fn page_coordinates(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<TargetCoordinates, StoreError> {
    let mut hierarchy = page_hierarchy(connection, library_id, page_id)?;
    hierarchy.pages.remove(page_id);
    Ok(TargetCoordinates {
        target_kind: "page",
        target_id: page_id.to_owned(),
        ancestor_pages: hierarchy.pages,
        owning_database: hierarchy.owning_database,
    })
}

fn page_hierarchy(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<PageHierarchy, StoreError> {
    let rows = connection
        .prepare(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, depth, path) AS ( \
               SELECT page.block_id, page.parent_kind, page.parent_id, 0, \
                 '|' || page.block_id || '|' \
               FROM pages page \
               JOIN blocks block ON block.id = page.block_id \
               WHERE page.block_id = ?1 AND page.library_id = ?2 \
                 AND block.library_id = page.library_id AND block.lifecycle <> 'deleted' \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, \
                 ancestors.depth + 1, ancestors.path || parent.block_id || '|' \
               FROM ancestors JOIN pages parent \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               JOIN blocks parent_block ON parent_block.id = parent.block_id \
               WHERE parent.library_id = ?2 \
                 AND parent_block.library_id = parent.library_id \
                 AND parent_block.lifecycle <> 'deleted' \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0 \
             ) \
             SELECT ancestors.page_id, projection.title, ancestors.depth, \
               ancestors.parent_kind, source.home_database_block_id, container.name \
             FROM ancestors \
             JOIN page_read_model projection ON projection.page_block_id = ancestors.page_id \
             LEFT JOIN data_sources source \
               ON ancestors.parent_kind = 'data_source' AND source.id = ancestors.parent_id \
                 AND source.library_id = ?2 \
             LEFT JOIN database_containers container \
               ON container.block_id = source.home_database_block_id \
             ORDER BY ancestors.depth",
        )?
        .query_map(params![page_id, library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Err(not_found());
    }

    let mut pages = HashMap::new();
    let mut owning_database = None;
    for (ancestor_id, title, _, parent_kind, database_id, database_name) in rows {
        pages.insert(ancestor_id, title);
        if parent_kind == "data_source" {
            owning_database = Some((
                database_id.ok_or_else(|| corrupt("Page data source has no owning Database"))?,
                database_name.ok_or_else(|| corrupt("Owning Database has no name"))?,
            ));
        }
    }
    Ok(PageHierarchy {
        pages,
        owning_database,
    })
}

fn parse_access(value: &str) -> Result<LibraryAccess, StoreError> {
    match value {
        "read" => Ok(LibraryAccess::Read),
        "read_write" => Ok(LibraryAccess::ReadWrite),
        _ => Err(corrupt("Project access is invalid")),
    }
}

fn source_access(source: &LibraryInheritedProjectAccessSource) -> LibraryAccess {
    match source {
        LibraryInheritedProjectAccessSource::PrimaryDatabase { access, .. }
        | LibraryInheritedProjectAccessSource::AncestorPage { access, .. }
        | LibraryInheritedProjectAccessSource::DatabaseGrant { access, .. } => *access,
    }
}

fn access_strength(access: LibraryAccess) -> u8 {
    match access {
        LibraryAccess::Read => 1,
        LibraryAccess::ReadWrite => 2,
    }
}

fn project_lifecycle(value: &str) -> Result<ProjectLifecycle, StoreError> {
    match value {
        "active" => Ok(ProjectLifecycle::Active),
        "inactive" => Ok(ProjectLifecycle::Inactive),
        "archived" => Ok(ProjectLifecycle::Archived),
        _ => Err(corrupt("Project lifecycle is invalid")),
    }
}

fn not_found() -> StoreError {
    StoreError::new(
        StoreErrorCode::NotFound,
        "Library resource is unavailable",
        false,
    )
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
