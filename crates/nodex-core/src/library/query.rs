//! Authorized Library relations evaluated inside the caller's SQLite observation.
use std::collections::BTreeMap;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryFileLifecycle, LibraryFileUsageFilter, LibraryNavigationNode, LibraryNavigationParent,
    LibraryPageProjectionFileKind, LibraryRead, LibraryReadValue,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

pub(crate) use super::page_search::PageSearchIndexRegistry;
use super::{
    file_queries, file_usages, history, navigation, page_file_inventory, page_projection,
    page_search,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_ROWS: usize = 100_000;

pub(crate) struct QueryContext<'a> {
    pub connection: &'a Connection,
    pub library_id: &'a str,
    pub store_epoch: &'a str,
    pub commit_head: i64,
    pub context: &'a BoundModuleContext,
    pub page_search: &'a PageSearchIndexRegistry,
}

impl QueryContext<'_> {
    pub(crate) fn page_ids(&self, id: Option<&str>) -> Result<Vec<String>, StoreError> {
        self.readable_page_ids(id, false)
    }

    fn readable_page_ids(
        &self,
        id: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<String>, StoreError> {
        let candidates = if let Some(id) = id {
            self.connection
                .query_row(
                    "SELECT page.block_id FROM pages page JOIN blocks block \
                 ON block.id = page.block_id AND block.library_id = page.library_id \
                 WHERE page.block_id = ?1 AND page.library_id = ?2 \
                   AND (block.lifecycle = 'active' OR (?3 AND block.lifecycle = 'archived'))",
                    params![id, self.library_id, include_archived],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .into_iter()
                .collect()
        } else {
            self.connection.prepare(
                "SELECT page.block_id FROM pages page JOIN blocks block \
                 ON block.id = page.block_id AND block.library_id = page.library_id \
                 WHERE page.library_id = ?1 AND (block.lifecycle = 'active' OR (?3 AND block.lifecycle = 'archived')) ORDER BY page.block_id LIMIT ?2",
            )?.query_map(params![self.library_id, (MAX_ROWS + 1) as i64, include_archived], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        ensure_budget(candidates.len())?;
        let mut visible = Vec::new();
        for id in candidates {
            if self.page_visible(&id)? {
                visible.push(id);
            }
        }
        Ok(visible)
    }

    pub(crate) fn page_metadata(&self, id: &str) -> Result<Value, StoreError> {
        self.require_page(id)?;
        let (title, rich_title, document_id, source, created_at, updated_at, file_manifest_revision) = self.connection.query_row(
            "SELECT materialization.title, materialization.title_rich_json, document.id, \
               CASE WHEN page.parent_kind = 'data_source' THEN page.parent_id ELSE NULL END, \
               page.created_at, page.updated_at, manifest.revision \
             FROM pages page JOIN blocks block \
               ON block.id = page.block_id AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id AND document.library_id = page.library_id \
             JOIN document_materializations materialization ON materialization.document_id = document.id \
             JOIN page_file_manifests manifest ON manifest.page_id = page.block_id AND manifest.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle = 'active' \
               AND document.readiness = 'ready' AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version",
            params![id, self.library_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, i64>(6)?)),
        ).optional()?.ok_or_else(|| error(StoreErrorCode::MaterializationStale, "Page has no exact current title materialization"))?;
        let rich_title = super::content::parse_rich_title(Some(rich_title))?;
        let actor = self.etag_project()?;
        let title_etag = crate::document::mint_document_title_etag(
            self.connection,
            &actor,
            self.store_epoch,
            &document_id,
            rich_title,
        )
        .map_err(|cause| {
            error(
                StoreErrorCode::StoreCorrupt,
                format!("Page validator authority is unavailable: {cause}"),
            )
        })?;
        let page_key =
            crate::database::current_page_key_for_page(self.connection, self.library_id, id)?;
        Ok(
            json!({"page_id":id,"page_key":page_key,"title":title,"data_source_id":source,
            "created_at":created_at,"updated_at":updated_at,"title_etag":title_etag,"file_manifest_revision":file_manifest_revision}),
        )
    }

    /// Intrinsic metadata is independent of Document content and Source membership.
    pub(crate) fn page_intrinsic_properties(&self, id: &str) -> Result<Value, StoreError> {
        self.require_page(id)?;
        let properties = navigation::read_page_intrinsic_properties(self.connection, id)?;
        Ok(Value::Object(
            properties
                .into_iter()
                .map(|property| (property.key, property.value))
                .collect(),
        ))
    }

    pub(crate) fn page_document(&self, id: &str) -> Result<Value, StoreError> {
        self.require_page(id)?;
        let page = page_projection::page_projection_file(
            self.connection,
            self.library_id,
            self.store_epoch,
            page_projection::PageProjectionFileRequest {
                commit_head: self.commit_head,
                requesting_project_id: self.project_id(),
                page_id: id,
                kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
                prepare: None,
            },
        )?;
        Ok(
            json!({"page_id":id,"nested_markdown":page.content,"body_etag":page.validators.body_etag}),
        )
    }

    pub(crate) fn search(&self, query: &str, k: u32) -> Result<Vec<Value>, StoreError> {
        if !(1..=100).contains(&k) {
            return Err(error(
                StoreErrorCode::InvalidInput,
                "search_hits K must be between 1 and 100",
            ));
        }
        let project = self.project_id().ok_or_else(|| {
            error(
                StoreErrorCode::Unauthorized,
                "Search requires a bound Project",
            )
        })?;
        let index = self.page_search.snapshot(
            self.connection,
            self.library_id,
            self.store_epoch,
            self.commit_head,
        )?;
        let hits = page_search::search_projects(
            self.connection,
            &index,
            self.library_id,
            page_search::ProjectSearchRequest {
                project_ids: &[project.to_owned()],
                query,
                filters: None,
                preferred_project_id: Some(project),
                recent_page_ids: &[],
                limit: Some(k),
            },
        )?;
        Ok(hits
            .into_iter()
            .enumerate()
            .map(|(ordinal, hit)| {
                json!({
                    "page_id":hit.page_id,"title":hit.title,"snippet":hit.excerpt.unwrap_or_default(),"ordinal":ordinal,
                })
            })
            .collect())
    }

    pub(crate) fn rows(
        &self,
        relation: &str,
        equalities: &BTreeMap<String, Value>,
    ) -> Result<Vec<Value>, StoreError> {
        match relation {
            "page_files" => self.page_files(equalities),
            "files" => self.files(equalities),
            "file_versions" | "file_usages" => self.file_details(relation, equalities),
            "page_history" => self.page_history(equalities),
            "library_children" => self.library_children(equalities),
            _ => Err(error(
                StoreErrorCode::InvalidInput,
                "Unknown Library query relation",
            )),
        }
    }

    fn project_id(&self) -> Option<&str> {
        self.context.project_id.as_ref().map(|id| id.0.as_str())
    }
    fn etag_project(&self) -> Result<String, StoreError> {
        if let Some(project) = self.project_id() {
            return Ok(project.to_owned());
        }
        super::mutation::resolve_library_actor_project_id(self.connection, self.library_id)
    }
    fn require_page(&self, id: &str) -> Result<(), StoreError> {
        if let Some(project) = self.project_id() {
            return history::require_page_read_access(
                self.connection,
                self.library_id,
                project,
                id,
            );
        }
        super::require_trusted_library_authority(self.context)
    }
    fn page_visible(&self, id: &str) -> Result<bool, StoreError> {
        visible(self.require_page(id))
    }

    fn page_files(&self, equalities: &BTreeMap<String, Value>) -> Result<Vec<Value>, StoreError> {
        let mut rows = QueryRows::default();
        for page_id in self.page_ids(text_filter(equalities, "page_id"))? {
            self.append_page_files(&page_id, &mut rows)?;
        }
        Ok(rows.items)
    }
    fn append_page_files(&self, page_id: &str, rows: &mut QueryRows) -> Result<(), StoreError> {
        let mut cursor = None;
        loop {
            let inventory = page_file_inventory::list(
                self.connection,
                self.context,
                page_id,
                None,
                cursor.as_deref(),
                Some(100),
            )?;
            for item in inventory.files {
                let mut row = value(item.file)?;
                row["page_id"] = json!(page_id);
                row["version"] = row["head_version"].clone();
                row["path"] = json!(item.logical_path);
                row["manifest_revision"] = json!(inventory.revision);
                row["body_usage_revision"] = json!(inventory.body_usage_revision);
                row["body_count"] = json!(item.body_count);
                rows.push(row)?;
            }
            ensure_budget(rows.len())?;
            cursor = inventory.next_cursor;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
    fn files(&self, equalities: &BTreeMap<String, Value>) -> Result<Vec<Value>, StoreError> {
        if let Some(id) = text_filter(equalities, "file_id") {
            return match file_queries::metadata(self.connection, self.context, id) {
                Ok(file) => Ok(vec![value(file)?]),
                Err(error) if hidden(&error) => Ok(vec![]),
                Err(error) => Err(error),
            };
        }
        let mut rows = QueryRows::default();
        for lifecycle in [LibraryFileLifecycle::Live, LibraryFileLifecycle::Trashed] {
            self.append_files(lifecycle, &mut rows)?;
        }
        Ok(rows.items)
    }
    fn append_files(
        &self,
        lifecycle: LibraryFileLifecycle,
        rows: &mut QueryRows,
    ) -> Result<(), StoreError> {
        let mut cursor = None;
        loop {
            let page = file_queries::catalog(
                self.connection,
                self.context,
                None,
                lifecycle,
                LibraryFileUsageFilter::All,
                cursor.as_deref(),
                Some(100),
            )?;
            rows.extend(
                page.items
                    .into_iter()
                    .map(value)
                    .collect::<Result<Vec<_>, _>>()?,
            )?;
            ensure_budget(rows.len())?;
            cursor = page.next_cursor;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
    fn file_details(
        &self,
        relation: &str,
        equalities: &BTreeMap<String, Value>,
    ) -> Result<Vec<Value>, StoreError> {
        let mut rows = QueryRows::default();
        for file in self.files(equalities)? {
            let id = file["file_id"]
                .as_str()
                .ok_or_else(|| error(StoreErrorCode::StoreCorrupt, "File identity is missing"))?;
            self.append_file_details(relation, id, &mut rows)?;
        }
        Ok(rows.items)
    }
    fn append_file_details(
        &self,
        relation: &str,
        id: &str,
        rows: &mut QueryRows,
    ) -> Result<(), StoreError> {
        let mut cursor = None;
        loop {
            cursor = if relation == "file_versions" {
                let page = file_queries::versions(
                    self.connection,
                    self.context,
                    id,
                    cursor.as_deref(),
                    Some(100),
                )?;
                rows.extend(
                    page.items
                        .into_iter()
                        .map(value)
                        .collect::<Result<Vec<_>, _>>()?,
                )?;
                page.next_cursor
            } else {
                let page = file_usages::read(
                    self.connection,
                    self.context,
                    id,
                    cursor.as_deref(),
                    Some(100),
                )?;
                rows.extend(page.items.into_iter().map(|usage| {
                    let target = value(&usage.target)?;
                    let kind = target["kind"].as_str().unwrap_or_default();
                    let target_id = target[format!("{kind}_id")].clone();
                    Ok(json!({"file_id":id,"target_kind":kind,"target_id":target_id,
                        "page_id":if kind == "page" {target_id} else {Value::Null},
                        "title":usage.title,"path":usage.logical_path,"occurrence_count":usage.occurrence_count,"lifecycle":usage.lifecycle}))
                }).collect::<Result<Vec<_>, StoreError>>()?)?;
                page.next_cursor
            };
            ensure_budget(rows.len())?;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
    fn page_history(&self, equalities: &BTreeMap<String, Value>) -> Result<Vec<Value>, StoreError> {
        let mut rows = QueryRows::default();
        for page_id in self.readable_page_ids(text_filter(equalities, "page_id"), true)? {
            self.append_history(&page_id, &mut rows)?;
        }
        Ok(rows.items)
    }
    fn append_history(&self, id: &str, rows: &mut QueryRows) -> Result<(), StoreError> {
        let mut before = None;
        loop {
            let page = history::page_history(
                self.connection,
                self.library_id,
                self.project_id(),
                id,
                before,
                Some(100),
            )?;
            for entry in page.entries {
                let mut row = value(entry)?;
                row["event_id"] = row["id"].clone();
                row["event_json"] = row.clone();
                rows.push(row)?;
            }
            ensure_budget(rows.len())?;
            before = page.next_cursor;
            if before.is_none() {
                return Ok(());
            }
        }
    }
    fn library_children(
        &self,
        equalities: &BTreeMap<String, Value>,
    ) -> Result<Vec<Value>, StoreError> {
        let kind = text_filter(equalities, "parent_kind");
        let id = text_filter(equalities, "parent_id");
        let mut parents = Vec::new();
        if kind.is_none_or(|kind| kind == "library") && id.is_none_or(|id| id == self.library_id) {
            parents.push(LibraryNavigationParent::Library);
        }
        if kind.is_none_or(|kind| kind == "page") {
            parents.extend(
                self.page_ids(id)?
                    .into_iter()
                    .map(|page_id| LibraryNavigationParent::Page { page_id }),
            );
        }
        if kind.is_none_or(|kind| kind == "database") {
            parents.extend(
                self.database_ids(id)?
                    .into_iter()
                    .map(|database_id| LibraryNavigationParent::Database { database_id }),
            );
        }
        let mut rows = QueryRows::default();
        for parent in parents {
            self.append_children(parent, &mut rows)?;
        }
        Ok(rows.items)
    }
    fn database_ids(&self, id: Option<&str>) -> Result<Vec<String>, StoreError> {
        let candidates = self.connection.prepare(
            "SELECT id FROM blocks WHERE library_id = ?1 AND type = 'database' AND lifecycle = 'active' \
             AND (?2 IS NULL OR id = ?2) ORDER BY id LIMIT ?3",
        )?.query_map(params![self.library_id, id, (MAX_ROWS + 1) as i64], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_budget(candidates.len())?;
        let mut ids = Vec::new();
        for id in candidates {
            if self.database_visible(&id)? {
                ids.push(id);
            }
        }
        Ok(ids)
    }
    fn database_visible(&self, id: &str) -> Result<bool, StoreError> {
        let Some(project) = self.project_id() else {
            super::require_trusted_library_authority(self.context)?;
            return Ok(true);
        };
        let primary = crate::database::authorization::project_primary_database(
            self.connection,
            self.library_id,
            project,
        )?;
        crate::database::authorization::authorize_database(
            self.connection,
            project,
            primary.as_deref(),
            id,
        )
    }
    fn node_visible(&self, node: &LibraryNavigationNode) -> Result<bool, StoreError> {
        match node {
            LibraryNavigationNode::Page { page_id, .. } => self.page_visible(page_id),
            LibraryNavigationNode::Database { database_id, .. }
            | LibraryNavigationNode::View { database_id, .. } => self.database_visible(database_id),
            LibraryNavigationNode::Canvas { canvas_id, .. } => {
                visible(navigation::require_bound_canvas_read_access(
                    self.connection,
                    self.library_id,
                    self.project_id(),
                    &self.context.adapter,
                    canvas_id,
                ))
            }
        }
    }
    fn append_children(
        &self,
        parent: LibraryNavigationParent,
        rows: &mut QueryRows,
    ) -> Result<(), StoreError> {
        let (parent_kind, parent_id) = match &parent {
            LibraryNavigationParent::Library => ("library", self.library_id),
            LibraryNavigationParent::Page { page_id } => ("page", page_id.as_str()),
            LibraryNavigationParent::Database { database_id } => ("database", database_id.as_str()),
        };
        let mut cursor = None;
        let mut ordinal = 0;
        loop {
            let result = navigation::read(
                self.connection,
                self.library_id,
                self.store_epoch,
                self.commit_head,
                self.context,
                self.page_search,
                LibraryRead::Children {
                    parent: parent.clone(),
                    cursor,
                    limit: Some(100),
                    force_include_target: None,
                },
            )?;
            let LibraryReadValue::Children {
                items, next_cursor, ..
            } = result
            else {
                return Err(error(
                    StoreErrorCode::Internal,
                    "Unexpected Library children result",
                ));
            };
            for node in items {
                if !self.node_visible(&node)? {
                    continue;
                }
                let row = value(node)?;
                let kind = row["kind"].as_str().unwrap_or_default();
                rows.push(json!({"parent_kind":parent_kind,"parent_id":parent_id,
                    "child_kind":kind,"child_id":row[format!("{kind}_id")],"title":row["title"],"ordinal":ordinal}))?;
                ordinal += 1;
            }
            ensure_budget(rows.len())?;
            cursor = next_cursor;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
}

/// Bounds domain collection assembly before rows reach the Query provider cache.
#[derive(Default)]
struct QueryRows {
    items: Vec<Value>,
    bytes: usize,
}
impl QueryRows {
    fn push(&mut self, row: Value) -> Result<(), StoreError> {
        ensure_budget(self.items.len() + 1)?;
        self.bytes = self.bytes.saturating_add(
            serde_json::to_vec(&row)
                .map_err(|cause| error(StoreErrorCode::Internal, cause.to_string()))?
                .len(),
        );
        if self.bytes > 16 * 1024 * 1024 {
            return Err(error(
                StoreErrorCode::ResourceExhausted,
                "Library relation exceeds 16 MiB; constrain Page or File identities; no partial result returned",
            ));
        }
        self.items.push(row);
        Ok(())
    }
    fn extend(&mut self, rows: impl IntoIterator<Item = Value>) -> Result<(), StoreError> {
        for row in rows {
            self.push(row)?;
        }
        Ok(())
    }
    fn len(&self) -> usize {
        self.items.len()
    }
}

fn text_filter<'a>(equalities: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    equalities.get(key).and_then(Value::as_str)
}
fn value(input: impl Serialize) -> Result<Value, StoreError> {
    serde_json::to_value(input).map_err(|cause| {
        error(
            StoreErrorCode::Internal,
            format!("Public query row serialization failed: {cause}"),
        )
    })
}
fn hidden(error: &StoreError) -> bool {
    matches!(
        error.code,
        StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
    )
}
fn visible(result: Result<(), StoreError>) -> Result<bool, StoreError> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if hidden(&error) => Ok(false),
        Err(error) => Err(error),
    }
}
fn ensure_budget(rows: usize) -> Result<(), StoreError> {
    crate::infrastructure::request_execution::check_request_interruption()?;
    if rows <= MAX_ROWS {
        return Ok(());
    }
    Err(error(
        StoreErrorCode::ResourceExhausted,
        "Library query exceeds 100000 input rows; constrain Page or File identities",
    ))
}
fn error(code: StoreErrorCode, message: impl Into<String>) -> StoreError {
    StoreError::new(code, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relation_collection_rejects_bytes_before_retaining_unbounded_rows() {
        let mut rows = QueryRows::default();
        let row = json!({"event_json": "x".repeat(1024 * 1024)});
        for _ in 0..15 {
            rows.push(row.clone()).unwrap();
        }
        let error = rows.push(row).unwrap_err();
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
        assert_eq!(rows.len(), 15);
    }
}
