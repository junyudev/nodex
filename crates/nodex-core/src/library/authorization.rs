use nodex_core_contracts::events::ResourceKey;
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::StoreError;

/// Returns the complete ownership path through the farthest authorizing Page
/// grant. Source rows inherit through their Database's containing Page, so every
/// Page, Source and Database on that path is also an authorization dependency.
pub(crate) fn page_grant_ownership_proof(
    connection: &Connection,
    project_id: &str,
    page_id: &str,
    write_required: bool,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let resources = connection
        .prepare(
            "WITH RECURSIVE project_library(library_id) AS ( \
               SELECT library_id FROM projects WHERE id = ?1 \
             ), ancestors(resource_kind, resource_id, depth, path) AS ( \
               SELECT 'page', page.block_id, 0, '|page:' || page.block_id || '|' \
               FROM pages page JOIN project_library USING(library_id) WHERE page.block_id = ?2 \
               UNION ALL \
               SELECT page.parent_kind, page.parent_id, ancestors.depth + 1, \
                 ancestors.path || page.parent_kind || ':' || page.parent_id || '|' \
               FROM ancestors JOIN pages page ON ancestors.resource_kind = 'page' \
                 AND page.block_id = ancestors.resource_id JOIN project_library USING(library_id) \
               WHERE page.parent_kind IN ('page', 'data_source') \
                 AND instr(ancestors.path, '|' || page.parent_kind || ':' || page.parent_id || '|') = 0 \
               UNION ALL \
               SELECT 'database', source.home_database_block_id, ancestors.depth + 1, \
                 ancestors.path || 'database:' || source.home_database_block_id || '|' \
               FROM ancestors JOIN data_sources source ON ancestors.resource_kind = 'data_source' \
                 AND source.id = ancestors.resource_id JOIN project_library USING(library_id) \
               WHERE instr(ancestors.path, '|database:' || source.home_database_block_id || '|') = 0 \
               UNION ALL \
               SELECT 'page', owner.block_id, ancestors.depth + 1, \
                 ancestors.path || 'page:' || owner.block_id || '|' \
               FROM ancestors JOIN blocks database_block ON ancestors.resource_kind = 'database' \
                 AND database_block.id = ancestors.resource_id AND database_block.type = 'database' \
               JOIN project_library ON project_library.library_id = database_block.library_id \
               JOIN document_block_index containing ON containing.block_id = database_block.id \
               JOIN block_documents ownership ON ownership.document_id = containing.document_id \
                 AND ownership.library_id = database_block.library_id \
               JOIN pages owner ON owner.block_id = ownership.block_id \
                 AND owner.library_id = database_block.library_id \
               WHERE instr(ancestors.path, '|page:' || owner.block_id || '|') = 0 \
             ), authorized_depth(max_depth) AS ( \
               SELECT max(ancestors.depth) FROM ancestors \
               JOIN project_resource_grants grant_row \
                 ON grant_row.root_kind = 'page' \
                AND ancestors.resource_kind = 'page' \
                AND grant_row.root_id = ancestors.resource_id \
                AND grant_row.project_id = ?1 \
                AND grant_row.library_id = (SELECT library_id FROM project_library) \
                AND grant_row.lifecycle = 'active' \
                AND (?3 = 0 OR grant_row.access = 'read_write') \
             ) \
             SELECT ancestors.resource_kind, ancestors.resource_id FROM ancestors, authorized_depth \
             WHERE authorized_depth.max_depth IS NOT NULL \
               AND ancestors.depth <= authorized_depth.max_depth \
             ORDER BY ancestors.depth",
        )?
        .query_map(
            params![project_id, page_id, i64::from(write_required)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if resources.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        resources
            .into_iter()
            .map(|(kind, id)| match kind.as_str() {
                "page" => Ok(ResourceKey::Page { page_id: id }),
                "data_source" => Ok(ResourceKey::DataSource { data_source_id: id }),
                "database" => Ok(ResourceKey::Database { database_id: id }),
                _ => Err(StoreError::new(
                    crate::infrastructure::sqlite::StoreErrorCode::StoreCorrupt,
                    "Page ownership proof contains an invalid resource kind",
                    false,
                )),
            })
            .collect::<Result<Vec<_>, StoreError>>()?,
    ))
}

/// Resolves direct Project access to a top-level Canvas. Embedded Canvases do
/// not use this path: their authority is inherited from the owning Page.
pub(crate) fn canvas_grant_authorization_proof(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
    write_required: bool,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    canvas_grant_authorization_proof_with_lifecycle(
        connection,
        library_id,
        project_id,
        canvas_id,
        write_required,
        false,
    )
}

pub(crate) fn canvas_lifecycle_grant_authorization_proof(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    canvas_grant_authorization_proof_with_lifecycle(
        connection, library_id, project_id, canvas_id, false, true,
    )
}

fn canvas_grant_authorization_proof_with_lifecycle(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    canvas_id: &str,
    write_required: bool,
    include_deleted: bool,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let authorized = connection
        .query_row(
            "SELECT 1 \
             FROM projects project \
             JOIN blocks block ON block.id = ?3 AND block.library_id = project.library_id \
             JOIN canvas_owners canvas ON canvas.block_id = block.id \
               AND canvas.library_id = block.library_id \
             LEFT JOIN library_block_placements placement ON placement.block_id = block.id \
               AND placement.library_id = block.library_id \
             JOIN project_resource_grants grant_row \
               ON grant_row.project_id = project.id \
              AND grant_row.library_id = project.library_id \
              AND grant_row.root_kind = 'canvas' \
              AND grant_row.root_id = block.id \
             LEFT JOIN document_block_index containing ON containing.block_id = block.id \
             WHERE project.id = ?1 AND project.library_id = ?2 \
               AND project.lifecycle = 'active' \
               AND block.type = 'canvas' \
               AND (?5 = 1 OR block.lifecycle <> 'deleted') \
               AND (block.lifecycle = 'deleted' OR placement.block_id IS NOT NULL) \
               AND containing.block_id IS NULL \
               AND grant_row.lifecycle = 'active' \
               AND (?4 = 0 OR grant_row.access = 'read_write')",
            params![
                project_id,
                library_id,
                canvas_id,
                i64::from(write_required),
                i64::from(include_deleted),
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(authorized.then(|| {
        vec![ResourceKey::Canvas {
            canvas_id: canvas_id.to_owned(),
        }]
    }))
}
