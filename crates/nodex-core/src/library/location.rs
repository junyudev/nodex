use std::collections::{HashMap, HashSet};

use nodex_core_contracts::library::{
    LibraryLifecycle, LibraryLocationSegment, LibraryResourceLocation, LibraryRouteTarget,
};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Eq, Hash, PartialEq)]
enum NodeId {
    Page(String),
    Database(String),
    Canvas(String),
    DataSource(String),
}

#[derive(Clone)]
struct Node {
    segment: Option<LibraryLocationSegment>,
    owner: Option<NodeId>,
}

impl Node {
    fn page(
        page_id: String,
        title: String,
        lifecycle: &str,
        parent_kind: &str,
        parent_id: String,
        library_id: &str,
    ) -> Result<Self, StoreError> {
        let owner = match parent_kind {
            "library" if parent_id == library_id => None,
            "page" => Some(NodeId::Page(parent_id)),
            "data_source" => Some(NodeId::DataSource(parent_id)),
            _ => return Err(corrupt("Page location has an invalid parent")),
        };
        let lifecycle = match lifecycle {
            "active" => LibraryLifecycle::Active,
            "archived" => LibraryLifecycle::Archived,
            _ => return Err(corrupt("Page location has an invalid lifecycle")),
        };
        Ok(Self {
            segment: Some(LibraryLocationSegment::Page {
                page_id,
                title,
                lifecycle,
            }),
            owner,
        })
    }

    fn data_source(database_id: String) -> Self {
        Self {
            segment: None,
            owner: Some(NodeId::Database(database_id)),
        }
    }
}

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
        LibraryRouteTarget::Page { page_id } => (page_id, NodeId::Page(page_id.clone())),
        LibraryRouteTarget::Database { database_id } => {
            (database_id, NodeId::Database(database_id.clone()))
        }
        LibraryRouteTarget::Canvas { canvas_id } => (canvas_id, NodeId::Canvas(canvas_id.clone())),
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
                NodeId::Database(database_id),
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
    let segments = owner_trail(node_id, |node_id| {
        read_node(connection, library_id, node_id)
    })?;
    Ok(segments.map(|segments| ResolvedLocation {
        content: target.clone(),
        segments,
    }))
}

fn owner_trail(
    target: NodeId,
    mut lookup: impl FnMut(&NodeId) -> Result<Option<Node>, StoreError>,
) -> Result<Option<Vec<LibraryLocationSegment>>, StoreError> {
    let Some(Node { owner, .. }) = lookup(&target)? else {
        return Ok(None);
    };
    let mut next = owner;
    let mut seen = HashSet::from([target]);
    let mut segments = Vec::new();
    while let Some(id) = next {
        if seen.len() >= 512 {
            return Err(corrupt("Library location exceeds 512 ownership levels"));
        }
        let Some(node) = lookup(&id)? else {
            return Ok(None);
        };
        if matches!(id, NodeId::Database(_)) && node.segment.is_none() {
            return Err(corrupt("Library location Database has no default View"));
        }
        if !seen.insert(id) {
            return Err(corrupt("Library location contains an ownership cycle"));
        }
        segments.extend(node.segment);
        next = node.owner;
    }
    segments.reverse();
    Ok(Some(segments))
}

fn read_node(
    connection: &Connection,
    library_id: &str,
    node_id: &NodeId,
) -> Result<Option<Node>, StoreError> {
    match node_id {
        NodeId::Page(page_id) => {
            let row = connection
                .prepare_cached(
                    // A location names its owners by their latest projected title: a projection that
                    // trails its Document head, or has never been written, must not fail the read.
                    "SELECT page.parent_kind, page.parent_id, block.lifecycle, \
                       (SELECT materialization.title FROM document_materializations materialization \
                        WHERE materialization.document_id = page.document_id \
                        ORDER BY materialization.generation DESC, materialization.projected_seq DESC \
                        LIMIT 1) \
                     FROM pages page \
                     JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
                     WHERE page.block_id = ?2 AND page.library_id = ?1 AND block.lifecycle <> 'deleted'",
                )?
                .query_row(params![library_id, page_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))
                })
                .optional()?;
            row.map(|(parent_kind, parent_id, lifecycle, title)| {
                Node::page(
                    page_id.clone(),
                    title.unwrap_or_default(),
                    &lifecycle,
                    &parent_kind,
                    parent_id,
                    library_id,
                )
            })
            .transpose()
        }
        NodeId::Database(database_id) => Ok(connection
            .prepare_cached(&database_nodes_sql(" AND container.block_id = ?2"))?
            .query_row(params![library_id, database_id], database_node)
            .optional()?
            .map(|(_, node)| node)),
        NodeId::Canvas(canvas_id) => Ok(connection
            .prepare_cached(&format!(
                "SELECT {HOST_PAGE} FROM canvas_owners canvas \
                 JOIN blocks block ON block.id = canvas.block_id AND block.library_id = canvas.library_id \
                 WHERE canvas.library_id = ?1 AND block.id = ?2 AND block.lifecycle <> 'deleted'",
            ))?
            .query_row(params![library_id, canvas_id], |row| {
                Ok(Node { segment: None, owner: hosted_owner(row.get(0)?) })
            })
            .optional()?),
        NodeId::DataSource(source_id) => Ok(connection
            .prepare_cached(&format!("{DATA_SOURCE_HOMES} AND id = ?2"))?
            .query_row(params![library_id, source_id], |row| row.get(1))
            .optional()?
            .map(Node::data_source)),
    }
}

const HOST_PAGE: &str = "(SELECT page.block_id FROM document_block_index entry \
    JOIN block_documents ownership ON ownership.document_id = entry.document_id \
    JOIN pages page ON page.block_id = ownership.block_id AND page.library_id = ownership.library_id \
    WHERE entry.block_id = block.id AND ownership.library_id = block.library_id)";

fn database_nodes_sql(filter: &str) -> String {
    format!(
        "SELECT container.block_id, container.name, container.default_view_id, \
           (SELECT binding.project_id FROM project_database_bindings binding \
            WHERE binding.database_block_id = container.block_id AND binding.library_id = container.library_id \
              AND binding.lifecycle = 'active'), {HOST_PAGE} \
         FROM database_containers container \
         JOIN blocks block ON block.id = container.block_id AND block.library_id = container.library_id \
         WHERE container.library_id = ?1 AND container.lifecycle <> 'deleted' AND block.lifecycle <> 'deleted'{filter}"
    )
}

const DATA_SOURCE_HOMES: &str = "SELECT id, home_database_block_id FROM data_sources \
    WHERE library_id = ?1 AND lifecycle <> 'deleted'";

fn database_node(row: &Row<'_>) -> rusqlite::Result<(String, Node)> {
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
    Ok((
        database_id,
        Node {
            segment,
            owner: hosted_owner(row.get(4)?),
        },
    ))
}

fn hosted_owner(host_page_id: Option<String>) -> Option<NodeId> {
    host_page_id.map(NodeId::Page)
}

/// Page search already loads Page snapshots in bulk. Load the other ownership
/// edges once and run the same trail over those indexed snapshots.
pub(super) struct IndexedOwners {
    databases: HashMap<String, Node>,
    data_sources: HashMap<String, String>,
}

impl IndexedOwners {
    pub(super) fn load(connection: &Connection, library_id: &str) -> Result<Self, StoreError> {
        let databases = connection
            .prepare(&database_nodes_sql(""))?
            .query_map([library_id], database_node)?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        let data_sources = connection
            .prepare(DATA_SOURCE_HOMES)?
            .query_map([library_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(Self {
            databases,
            data_sources,
        })
    }

    pub(super) fn page_trail<'a>(
        &self,
        library_id: &str,
        page_id: &str,
        mut lookup_page: impl FnMut(&str) -> Option<IndexedPagePlacement<'a>>,
    ) -> Result<Option<Vec<LibraryLocationSegment>>, StoreError> {
        owner_trail(NodeId::Page(page_id.to_owned()), |id| match id {
            NodeId::Page(id) => lookup_page(id)
                .map(|page| {
                    Node::page(
                        id.clone(),
                        page.title.to_owned(),
                        page.lifecycle,
                        page.parent_kind,
                        page.parent_id.to_owned(),
                        library_id,
                    )
                })
                .transpose(),
            NodeId::Database(id) => Ok(self.databases.get(id).cloned()),
            NodeId::DataSource(id) => Ok(self.data_sources.get(id).cloned().map(Node::data_source)),
            NodeId::Canvas(_) => unreachable!("a Canvas cannot own a Page"),
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
