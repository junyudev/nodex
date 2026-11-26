use std::collections::HashMap;

use nodex_core_contracts::library::{
    LibraryLifecycle, LibraryLocationSegment, LibraryResourceLocation, LibraryRouteTarget,
};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ownership::{self, Graph, Kind, NodeId, Trail, TrailEnd};

pub(super) struct ResolvedLocation {
    /// Views address a Database presentation. The Database is the content itself.
    pub content: LibraryRouteTarget,
    pub segments: Vec<LibraryLocationSegment>,
}

pub(super) fn read(
    connection: &Connection,
    library_id: &str,
    target: LibraryRouteTarget,
) -> Result<LibraryResourceLocation, StoreError> {
    Ok(match resolve(connection, library_id, &target)? {
        Some(location) => LibraryResourceLocation::Available {
            target,
            segments: location.segments,
        },
        None => LibraryResourceLocation::Missing { target },
    })
}

pub(super) fn resolve(
    connection: &Connection,
    library_id: &str,
    target: &LibraryRouteTarget,
) -> Result<Option<ResolvedLocation>, StoreError> {
    let (id, node_id) = match target {
        LibraryRouteTarget::Page { page_id } => (page_id, NodeId::page(page_id)),
        LibraryRouteTarget::Database { database_id } => {
            (database_id, NodeId::new(Kind::Database, database_id))
        }
        LibraryRouteTarget::Canvas { canvas_id } => {
            (canvas_id, NodeId::new(Kind::Canvas, canvas_id))
        }
        LibraryRouteTarget::View { view_id } => {
            validate_identity(view_id)?;
            let database_id = connection
                .query_row(
                    "SELECT view.database_block_id FROM database_views view \
                     JOIN database_containers container ON container.block_id = view.database_block_id \
                     WHERE view.id = ?1 AND container.library_id = ?2 AND view.lifecycle = 'active'",
                    params![view_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(database_id) = database_id else {
                return Ok(None);
            };
            return resolve_content(
                connection,
                library_id,
                &LibraryRouteTarget::Database {
                    database_id: database_id.clone(),
                },
                NodeId::new(Kind::Database, &database_id),
            );
        }
    };
    validate_identity(id)?;
    resolve_content(connection, library_id, target, node_id)
}

fn resolve_content(
    connection: &Connection,
    library_id: &str,
    target: &LibraryRouteTarget,
    node_id: NodeId,
) -> Result<Option<ResolvedLocation>, StoreError> {
    let trail = Graph::new(connection, library_id).trail(node_id)?;
    let segments = location_segments(trail, |node| match node.kind {
        Kind::Page => connection
            .prepare_cached(
                // Location titles can use a projection that trails the Document head.
                "SELECT block.lifecycle, COALESCE((SELECT materialization.title
                   FROM document_materializations materialization
                   WHERE materialization.document_id = page.document_id
                   ORDER BY materialization.generation DESC, materialization.projected_seq DESC
                   LIMIT 1), '')
                 FROM pages page JOIN blocks block ON block.id = page.block_id
                 WHERE page.block_id = ?1",
            )?
            .query_row([&node.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(StoreError::from)
            .and_then(|(lifecycle, title)| page_segment(&node.id, title, &lifecycle))
            .map(Some),
        Kind::Database => Ok(connection
            .prepare_cached(&format!("{DATABASE_SEGMENTS} AND container.block_id = ?2"))?
            .query_row(params![library_id, node.id], database_segment)?
            .1),
        Kind::Canvas | Kind::DataSource => Ok(None),
    })?;
    Ok(segments.map(|segments| ResolvedLocation {
        content: target.clone(),
        segments,
    }))
}

fn location_segments(
    trail: Trail,
    mut lookup: impl FnMut(&NodeId) -> Result<Option<LibraryLocationSegment>, StoreError>,
) -> Result<Option<Vec<LibraryLocationSegment>>, StoreError> {
    if matches!(trail.end, TrailEnd::Missing(_)) {
        return Ok(None);
    }
    trail.require_root()?;
    let mut segments = Vec::new();
    for node in trail.nodes.iter().skip(1).rev() {
        let segment = lookup(node)?;
        if node.kind == Kind::Database && segment.is_none() {
            return Err(corrupt("Library location Database has no default View"));
        }
        segments.extend(segment);
    }
    Ok(Some(segments))
}

fn page_segment(
    id: &str,
    title: String,
    lifecycle: &str,
) -> Result<LibraryLocationSegment, StoreError> {
    let lifecycle = match lifecycle {
        "active" => LibraryLifecycle::Active,
        "archived" => LibraryLifecycle::Archived,
        _ => return Err(corrupt("Page location has an invalid lifecycle")),
    };
    Ok(LibraryLocationSegment::Page {
        page_id: id.to_owned(),
        title,
        lifecycle,
    })
}

const DATABASE_SEGMENTS: &str =
    "SELECT container.block_id, container.name, container.default_view_id,
       (SELECT binding.project_id FROM project_database_bindings binding
        WHERE binding.database_block_id = container.block_id AND binding.library_id = container.library_id
          AND binding.lifecycle = 'active')
     FROM database_containers container
     WHERE container.library_id = ?1 AND container.lifecycle <> 'deleted'";

fn database_segment(row: &Row<'_>) -> rusqlite::Result<(String, Option<LibraryLocationSegment>)> {
    let database_id: String = row.get(0)?;
    let segment = match row.get::<_, Option<String>>(2)? {
        Some(default_view_id) => Some(LibraryLocationSegment::Database {
            database_id: database_id.clone(),
            title: row.get(1)?,
            default_view_id,
            primary_project_id: row.get(3)?,
        }),
        None => None,
    };
    Ok((database_id, segment))
}

/// Page search already has Page snapshots. Read the remaining edges and labels
/// in bulk and use the same trail and presentation as point locations.
pub(super) struct IndexedLocations {
    owners: ownership::IndexedOwners,
    databases: HashMap<String, Option<LibraryLocationSegment>>,
}

impl IndexedLocations {
    pub(super) fn load(connection: &Connection, library_id: &str) -> Result<Self, StoreError> {
        let owners = ownership::IndexedOwners::load(connection, library_id)?;
        let databases = connection
            .prepare(DATABASE_SEGMENTS)?
            .query_map([library_id], database_segment)?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(Self { owners, databases })
    }

    pub(super) fn page_trail<'a>(
        &self,
        library_id: &str,
        page_id: &str,
        lookup_page: impl Fn(&str) -> Option<IndexedPagePlacement<'a>>,
    ) -> Result<Option<Vec<LibraryLocationSegment>>, StoreError> {
        let trail = ownership::owner_trail(NodeId::page(page_id), |node| {
            if node.kind != Kind::Page {
                return Ok(self.owners.get(node));
            }
            lookup_page(&node.id)
                .filter(|page| page.lifecycle != "deleted")
                .map(|page| {
                    ownership::IndexedOwners::page_owner(
                        library_id,
                        page.parent_kind,
                        page.parent_id,
                    )
                })
                .transpose()
        })?;
        location_segments(trail, |node| match node.kind {
            Kind::Page => lookup_page(&node.id)
                .map(|page| page_segment(&node.id, page.title.to_owned(), page.lifecycle))
                .transpose(),
            Kind::Database => Ok(self.databases.get(&node.id).cloned().flatten()),
            Kind::Canvas | Kind::DataSource => Ok(None),
        })
    }
}

pub(super) struct IndexedPagePlacement<'a> {
    pub title: &'a str,
    pub lifecycle: &'a str,
    pub parent_kind: &'a str,
    pub parent_id: &'a str,
}

pub(super) fn title(segment: &LibraryLocationSegment) -> &str {
    match segment {
        LibraryLocationSegment::Page { title, .. }
        | LibraryLocationSegment::Database { title, .. } => title,
    }
}

/// A one-line location for lists. An empty label means the top level of Space, so an owner
/// without a title still names itself.
pub(super) fn label(segments: &[LibraryLocationSegment]) -> String {
    segments
        .iter()
        .map(|segment| match title(segment).trim() {
            "" => "Untitled",
            title => title,
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

fn validate_identity(id: &str) -> Result<(), StoreError> {
    if !id.is_empty() && id.len() <= 512 && id.trim() == id {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::InvalidInput,
        "Resource location requires a canonical bounded identity",
        false,
    ))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_names_untitled_owners_so_only_the_top_level_is_empty() {
        let page = |title: &str| LibraryLocationSegment::Page {
            page_id: format!("page:{title}"),
            title: title.to_owned(),
            lifecycle: LibraryLifecycle::Active,
        };
        assert_eq!(label(&[]), "");
        assert_eq!(label(&[page("")]), "Untitled");
        assert_eq!(label(&[page("Roadmap"), page("  ")]), "Roadmap / Untitled");
    }
}
