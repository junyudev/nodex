use std::collections::{HashMap, HashSet};

use nodex_core_contracts::library::LibraryPlacedResourceTarget;
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) mod staged;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum Kind {
    Page,
    Database,
    Canvas,
    DataSource,
}

impl Kind {
    const ALL: [Self; 4] = [Self::Page, Self::DataSource, Self::Database, Self::Canvas];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::DataSource => "data_source",
            Self::Database => "database",
            Self::Canvas => "canvas",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "page" => Ok(Self::Page),
            "data_source" => Ok(Self::DataSource),
            "database" => Ok(Self::Database),
            "canvas" => Ok(Self::Canvas),
            _ => Err(corrupt(format!("Invalid Library ownership kind {value}"))),
        }
    }

    pub(super) fn cycle_error(self) -> StoreError {
        let message = match self {
            Self::Page => "A Page can't move into itself or anything it contains.",
            Self::Database => "A Database can't move into one of its own Pages.",
            Self::Canvas => "A Canvas can't move into itself.",
            Self::DataSource => "A Data Source can't belong to anything it contains.",
        };
        StoreError::new(StoreErrorCode::InvalidInput, message, false)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct NodeId {
    pub(crate) kind: Kind,
    pub(crate) id: String,
}

impl NodeId {
    pub(crate) fn new(kind: Kind, id: &str) -> Self {
        Self {
            kind,
            id: id.to_owned(),
        }
    }

    pub(crate) fn page(id: &str) -> Self {
        Self::new(Kind::Page, id)
    }

    pub(crate) fn data_source(id: &str) -> Self {
        Self::new(Kind::DataSource, id)
    }
}

impl From<&LibraryPlacedResourceTarget> for NodeId {
    fn from(target: &LibraryPlacedResourceTarget) -> Self {
        match target {
            LibraryPlacedResourceTarget::Page { page_id } => Self::page(page_id),
            LibraryPlacedResourceTarget::Database { database_id } => {
                Self::new(Kind::Database, database_id)
            }
            LibraryPlacedResourceTarget::Canvas { canvas_id } => Self::new(Kind::Canvas, canvas_id),
        }
    }
}

pub(crate) type Owner = Option<NodeId>;

fn decode_owner(
    library_id: &str,
    kind: Option<String>,
    id: Option<String>,
) -> Result<Owner, StoreError> {
    match (kind.as_deref(), id) {
        (Some("library"), Some(id)) if id == library_id => Ok(None),
        (Some(kind @ ("page" | "data_source" | "database")), Some(id)) => Ok(Some(NodeId {
            kind: Kind::parse(kind)?,
            id,
        })),
        (Some("page"), None) => Ok(None), // An unhosted Database or Canvas.
        _ => Err(corrupt("Invalid Library ownership edge")),
    }
}

fn edge_sql(kind: Kind, direction: EdgeDirection) -> String {
    let (table, id, owner_kind, owner_id, scope, hosted) = match kind {
        Kind::Page => (
            "pages node JOIN blocks block ON block.id = node.block_id AND block.library_id = node.library_id",
            "node.block_id",
            "node.parent_kind",
            "node.parent_id",
            "node.library_id = ?1 AND block.lifecycle <> 'deleted'",
            false,
        ),
        Kind::DataSource => (
            "data_sources node",
            "node.id",
            "'database'",
            "node.home_database_block_id",
            "node.library_id = ?1 AND node.lifecycle <> 'deleted'",
            false,
        ),
        Kind::Database => (
            "database_containers node JOIN blocks block ON block.id = node.block_id AND block.library_id = node.library_id",
            "node.block_id",
            "'page'",
            "host.block_id",
            "node.library_id = ?1 AND block.lifecycle <> 'deleted' AND node.lifecycle <> 'deleted'",
            true,
        ),
        Kind::Canvas => (
            "canvas_owners node JOIN blocks block ON block.id = node.block_id AND block.library_id = node.library_id",
            "node.block_id",
            "'page'",
            "host.block_id",
            "node.library_id = ?1 AND block.lifecycle <> 'deleted'",
            true,
        ),
    };
    let owner_id = if hosted && !matches!(direction, EdgeDirection::Children) {
        // An index entry with no Page Document owner is a broken edge, not a root.
        "COALESCE(host.block_id, ownership.block_id, entry.document_id)"
    } else {
        owner_id
    };
    let host = if hosted {
        let join = if matches!(direction, EdgeDirection::Children) {
            "JOIN"
        } else {
            "LEFT JOIN"
        };
        format!(
            " {join} document_block_index entry ON entry.block_id = node.block_id
              {join} block_documents ownership ON ownership.document_id = entry.document_id
                AND ownership.library_id = node.library_id
              {join} pages host ON host.block_id = ownership.block_id
                AND host.library_id = ownership.library_id"
        )
    } else {
        String::new()
    };
    let node_kind = kind.as_str();
    let from = format!("{table}{host}");
    match direction {
        EdgeDirection::Identity => {
            format!(
                "SELECT {owner_kind} AS owner_kind, {owner_id} AS owner_id FROM {from} WHERE {scope} AND {id} = ?2"
            )
        }
        EdgeDirection::All => {
            format!(
                "SELECT '{node_kind}', {id}, {owner_kind}, {owner_id} FROM {from} WHERE {scope}"
            )
        }
        EdgeDirection::Children => {
            format!(
                "SELECT '{node_kind}', {id} FROM excluded parent CROSS JOIN {from}
                 WHERE parent.kind = {owner_kind} AND parent.id = {owner_id} AND {scope}"
            )
        }
    }
}

#[derive(Clone, Copy)]
enum EdgeDirection {
    Identity,
    All,
    Children,
}

/// The same edge queries drive point lookups, indexed locations, whole-Store
/// validation, and the inverse traversal used by destination windows.
pub(crate) struct Graph<'a> {
    connection: &'a Connection,
    library_id: &'a str,
}

impl<'a> Graph<'a> {
    pub(crate) fn new(connection: &'a Connection, library_id: &'a str) -> Self {
        Self {
            connection,
            library_id,
        }
    }

    fn owner(&self, node: &NodeId) -> Result<Option<Owner>, StoreError> {
        self.connection
            .prepare_cached(&edge_sql(node.kind, EdgeDirection::Identity))?
            .query_row(params![self.library_id, node.id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?
            .map(|(kind, id)| decode_owner(self.library_id, kind, id))
            .transpose()
    }

    pub(super) fn trail(&self, start: NodeId) -> Result<Trail, StoreError> {
        owner_trail(start, |id| self.owner(id))
    }

    pub(crate) fn require_move(
        &self,
        moving: &[NodeId],
        proposed_parent: Owner,
    ) -> Result<(), StoreError> {
        let Some(parent) = proposed_parent else {
            return Ok(());
        };
        require_acyclic_move(moving, self.trail(parent)?)
    }

    fn validate_changes(&self, changes: Vec<(NodeId, Owner)>) -> Result<(), StoreError> {
        let mut changed = HashMap::new();
        for (node, previous) in changes {
            // A deletion or move to Space removes the edge.
            if let Some(Some(owner)) = self.owner(&node)?
                && Some(&owner) != previous.as_ref()
            {
                changed.insert(node, owner);
            }
        }

        let mut rooted = HashSet::new();
        for node in changed.keys() {
            if rooted.contains(node) {
                continue;
            }
            let trail = owner_trail(node.clone(), |id| {
                if rooted.contains(id) {
                    return Ok(Some(None));
                }
                if let Some(owner) = changed.get(id) {
                    return Ok(Some(Some(owner.clone())));
                }
                self.owner(id)
            })?;
            if let TrailEnd::Cycle(first) = &trail.end
                && let Some(moved) = trail
                    .nodes
                    .iter()
                    .skip_while(|id| *id != first)
                    .filter(|id| changed.contains_key(*id))
                    .min_by_key(|id| id.kind)
            {
                return Err(moved.kind.cycle_error());
            }
            trail.require_root()?;
            rooted.extend(trail.nodes);
        }
        Ok(())
    }
}

/// The parameter numbers let callers share this CTE between their count and
/// paginated queries. UNION makes the inverse traversal terminate on bad data.
pub(crate) fn exclusion_cte(kind_param: u8, id_param: u8) -> String {
    let children = Kind::ALL
        .map(|kind| edge_sql(kind, EdgeDirection::Children))
        .join(" UNION ");
    format!(
        "WITH RECURSIVE excluded(kind, id) AS (SELECT ?{kind_param}, ?{id_param} UNION {children})"
    )
}

pub(super) enum TrailEnd {
    Root,
    Missing(NodeId),
    Cycle(NodeId),
}

pub(super) struct Trail {
    pub(super) nodes: Vec<NodeId>,
    pub(super) end: TrailEnd,
}

impl Trail {
    pub(super) fn require_root(&self) -> Result<(), StoreError> {
        match &self.end {
            TrailEnd::Root => Ok(()),
            TrailEnd::Missing(node) => Err(corrupt(format!(
                "Library ownership trail is missing {:?} {}",
                node.kind, node.id
            ))),
            TrailEnd::Cycle(node) => Err(corrupt(format!(
                "Library ownership trail contains a cycle at {:?} {}",
                node.kind, node.id
            ))),
        }
    }
}

fn require_acyclic_move(moving: &[NodeId], trail: Trail) -> Result<(), StoreError> {
    if let Some(node) = moving.iter().find(|node| {
        trail.nodes.contains(node) || matches!(&trail.end, TrailEnd::Missing(id) if *node == id)
    }) {
        return Err(node.kind.cycle_error());
    }
    trail.require_root()
}

pub(super) fn owner_trail(
    start: NodeId,
    mut lookup: impl FnMut(&NodeId) -> Result<Option<Owner>, StoreError>,
) -> Result<Trail, StoreError> {
    let mut seen = HashSet::new();
    let mut nodes = Vec::new();
    let mut current = start;
    let end = loop {
        if !seen.insert(current.clone()) {
            break TrailEnd::Cycle(current);
        }
        let Some(owner) = lookup(&current)? else {
            break TrailEnd::Missing(current);
        };
        nodes.push(current);
        let Some(owner) = owner else {
            break TrailEnd::Root;
        };
        current = owner;
    };
    Ok(Trail { nodes, end })
}

pub(super) struct IndexedOwners(HashMap<NodeId, Owner>);

impl IndexedOwners {
    fn load_kinds(
        connection: &Connection,
        library_id: &str,
        kinds: &[Kind],
    ) -> Result<Self, StoreError> {
        let sql = kinds
            .iter()
            .map(|&kind| edge_sql(kind, EdgeDirection::All))
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query([library_id])?;
        let mut edges = HashMap::new();
        while let Some(row) = rows.next()? {
            let kind = Kind::parse(&row.get::<_, String>(0)?)?;
            let node = NodeId {
                kind,
                id: row.get(1)?,
            };
            let owner = decode_owner(library_id, row.get(2)?, row.get(3)?)?;
            edges.insert(node, owner);
        }
        Ok(Self(edges))
    }

    pub(super) fn load(connection: &Connection, library_id: &str) -> Result<Self, StoreError> {
        Self::load_kinds(connection, library_id, &[Kind::Database, Kind::DataSource])
    }

    pub(super) fn get(&self, node: &NodeId) -> Option<Owner> {
        self.0.get(node).cloned()
    }

    pub(super) fn page_owner(library_id: &str, kind: &str, id: &str) -> Result<Owner, StoreError> {
        decode_owner(library_id, Some(kind.to_owned()), Some(id.to_owned()))
    }
}

/// Report recoverable historical damage while leaving the Profile open for
/// repairs. Each validated suffix is visited only once per scan.
pub(crate) fn report_store_ownership(connection: &Connection) -> Result<(), StoreError> {
    let libraries = connection
        .prepare("SELECT id FROM libraries")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for library_id in libraries {
        let indexed = IndexedOwners::load_kinds(connection, &library_id, &Kind::ALL)?;
        let mut checked = HashSet::new();
        for node in indexed.0.keys() {
            if checked.contains(node) {
                continue;
            }
            let trail = owner_trail(node.clone(), |id| {
                if checked.contains(id) {
                    return Ok(Some(None));
                }
                Ok(indexed.get(id))
            })?;
            if let Err(error) = trail.require_root() {
                tracing::warn!(%library_id, %error, "Library ownership needs repair");
            }
            checked.extend(trail.nodes);
        }
    }
    Ok(())
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}
