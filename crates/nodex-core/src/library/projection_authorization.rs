use std::collections::BTreeSet;

#[cfg(test)]
use nodex_core_contracts::PageDocumentHeadImpact;
use nodex_core_contracts::{BoundModuleContext, ProjectionImpact};
use rusqlite::{Connection, OptionalExtension, params};

use crate::database::authorization::{authorize_database, project_primary_database};
use crate::infrastructure::projection_impact::canonicalize;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) fn filter_for_project(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    project_id: &str,
    impact: ProjectionImpact,
) -> Result<ProjectionImpact, StoreError> {
    if context.project_id.as_ref().map(|id| id.0.as_str()) != Some(project_id) {
        return Err(unauthorized(
            "Projection impact Project is not the bound Project",
        ));
    }
    let impact = canonicalize(impact)?;
    let primary_database_id = project_primary_database(connection, library_id, project_id)?;

    let ProjectionImpact::Resources {
        page_ids,
        database_ids,
        data_source_ids,
        view_ids,
        document_heads,
    } = impact
    else {
        return Ok(impact);
    };

    let mut allowed_pages = BTreeSet::new();
    for page_id in page_ids {
        if page_is_authorized(
            connection,
            library_id,
            project_id,
            primary_database_id.as_deref(),
            &page_id,
        )? {
            allowed_pages.insert(page_id);
        }
    }

    let mut allowed_databases = BTreeSet::new();
    for database_id in database_ids {
        if database_is_authorized(
            connection,
            library_id,
            project_id,
            primary_database_id.as_deref(),
            &database_id,
        )? {
            allowed_databases.insert(database_id);
        }
    }

    let mut allowed_data_sources = BTreeSet::new();
    for data_source_id in data_source_ids {
        let database_id = connection
            .query_row(
                "SELECT home_database_block_id FROM data_sources \
                 WHERE id = ?1 AND library_id = ?2",
                params![data_source_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(database_id) = database_id else {
            continue;
        };
        if database_is_authorized(
            connection,
            library_id,
            project_id,
            primary_database_id.as_deref(),
            &database_id,
        )? {
            allowed_data_sources.insert(data_source_id);
        }
    }

    let mut allowed_views = BTreeSet::new();
    for view_id in view_ids {
        let database_id = connection
            .query_row(
                "SELECT view.database_block_id FROM database_views view \
                 JOIN database_containers database ON database.block_id = view.database_block_id \
                 WHERE view.id = ?1 AND database.library_id = ?2",
                params![view_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(database_id) = database_id else {
            continue;
        };
        if database_is_authorized(
            connection,
            library_id,
            project_id,
            primary_database_id.as_deref(),
            &database_id,
        )? {
            allowed_views.insert(view_id);
        }
    }

    let mut allowed_heads = Vec::new();
    for head in document_heads {
        if !allowed_pages.contains(&head.page_id) {
            continue;
        }
        let belongs_to_page = connection
            .query_row(
                "SELECT 1 FROM pages WHERE block_id = ?1 AND document_id = ?2 \
                 AND library_id = ?3",
                params![head.page_id, head.document_id, library_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if belongs_to_page {
            allowed_heads.push(head);
        }
    }

    canonicalize(ProjectionImpact::Resources {
        page_ids: allowed_pages.into_iter().collect(),
        database_ids: allowed_databases.into_iter().collect(),
        data_source_ids: allowed_data_sources.into_iter().collect(),
        view_ids: allowed_views.into_iter().collect(),
        document_heads: allowed_heads,
    })
}

fn page_is_authorized(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    primary_database_id: Option<&str>,
    page_id: &str,
) -> Result<bool, StoreError> {
    let page_exists = connection
        .query_row(
            "SELECT 1 FROM pages page JOIN blocks block ON block.id = page.block_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.library_id = page.library_id AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if page_exists.is_none() {
        return Ok(false);
    }

    if let Some(database_id) = page_database_id(connection, library_id, page_id)?
        && (primary_database_id == Some(database_id.as_str())
            || has_direct_database_grant(connection, project_id, &database_id)?)
    {
        return Ok(true);
    }

    connection
        .query_row(
            "WITH RECURSIVE ancestors(page_id, path) AS ( \
               SELECT ?2, '|' || ?2 || '|' UNION ALL \
               SELECT page.parent_id, ancestors.path || page.parent_id || '|' \
               FROM pages page JOIN ancestors ON page.block_id = ancestors.page_id \
               WHERE page.library_id = ?3 AND page.parent_kind = 'page' \
                 AND instr(ancestors.path, '|' || page.parent_id || '|') = 0) \
             SELECT 1 FROM project_resource_grants grant_row JOIN ancestors \
               ON grant_row.root_id = ancestors.page_id \
             WHERE grant_row.project_id = ?1 AND grant_row.root_kind = 'page' \
               AND grant_row.lifecycle = 'active' LIMIT 1",
            params![project_id, page_id, library_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(StoreError::from)
}

fn database_is_authorized(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    primary_database_id: Option<&str>,
    database_id: &str,
) -> Result<bool, StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM database_containers \
             WHERE block_id = ?1 AND library_id = ?2",
            params![database_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(false);
    }
    authorize_database(connection, project_id, primary_database_id, database_id)
}

fn has_direct_database_grant(
    connection: &Connection,
    project_id: &str,
    database_id: &str,
) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT 1 FROM project_resource_grants WHERE project_id = ?1 \
             AND root_kind = 'database' AND root_id = ?2 AND lifecycle = 'active'",
            params![project_id, database_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(StoreError::from)
}

fn page_database_id(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, path) AS ( \
               SELECT block_id, parent_kind, parent_id, '|' || block_id || '|' FROM pages \
                 WHERE block_id = ?1 AND library_id = ?2 \
               UNION ALL \
               SELECT page.block_id, page.parent_kind, page.parent_id, \
                 ancestors.path || page.block_id || '|' \
               FROM pages page JOIN ancestors ON ancestors.parent_kind = 'page' \
                 AND page.block_id = ancestors.parent_id \
               WHERE page.library_id = ?2 \
                 AND instr(ancestors.path, '|' || page.block_id || '|') = 0) \
             SELECT source.home_database_block_id FROM ancestors \
             JOIN data_sources source ON ancestors.parent_kind = 'data_source' \
               AND source.id = ancestors.parent_id \
             WHERE source.library_id = ?2 LIMIT 1",
            params![page_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::{AdapterKind, LibraryId, ProfileId, ProjectId};

    use super::*;

    fn context(project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId(project_id.to_owned())),
            connection_id: "connection-1".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn authority_fixture() -> Connection {
        let connection = Connection::open_in_memory().expect("authority fixture");
        connection
            .execute_batch(
                "CREATE TABLE projects( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, database_block_id TEXT, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE project_database_bindings( \
                   project_id TEXT NOT NULL, library_id TEXT NOT NULL, database_block_id TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE blocks( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, type TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 CREATE TABLE document_block_index( \
                   library_id TEXT NOT NULL, document_id TEXT NOT NULL, block_id TEXT NOT NULL); \
                 CREATE TABLE block_documents(block_id TEXT NOT NULL, document_id TEXT NOT NULL); \
                 CREATE TABLE pages( \
                   block_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, document_id TEXT NOT NULL, \
                   parent_kind TEXT NOT NULL, parent_id TEXT NOT NULL); \
                 CREATE TABLE database_containers(block_id TEXT PRIMARY KEY, library_id TEXT NOT NULL); \
                 CREATE TABLE data_sources( \
                   id TEXT PRIMARY KEY, library_id TEXT NOT NULL, home_database_block_id TEXT NOT NULL); \
                 CREATE TABLE database_views( \
                   id TEXT PRIMARY KEY, database_block_id TEXT NOT NULL, data_source_id TEXT NOT NULL); \
                 CREATE TABLE project_resource_grants( \
                   project_id TEXT NOT NULL, root_kind TEXT NOT NULL, root_id TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL); \
                 INSERT INTO projects VALUES ('project-1', 'library-1', 'database-1', 'active'); \
                 INSERT INTO projects VALUES ('project-2', 'library-1', 'database-2', 'active'); \
                 INSERT INTO blocks VALUES ('database-1', 'library-1', 'database', 'active'); \
                 INSERT INTO blocks VALUES ('database-2', 'library-1', 'database', 'active'); \
                 INSERT INTO blocks VALUES ( \
                   'database-same-storage-secret', 'library-1', 'database', 'active'); \
                 INSERT INTO blocks VALUES ('page-own', 'library-1', 'page', 'active'); \
                 INSERT INTO blocks VALUES ('page-grant-root', 'library-1', 'page', 'active'); \
                 INSERT INTO blocks VALUES ('page-granted-child', 'library-1', 'page', 'active'); \
                 INSERT INTO blocks VALUES ('page-secret', 'library-1', 'page', 'active'); \
                 INSERT INTO pages VALUES ('page-own', 'library-1', 'document-own', 'data_source', 'source-1'); \
                 INSERT INTO pages VALUES ('page-grant-root', 'library-1', 'document-root', 'library', 'library-1'); \
                 INSERT INTO pages VALUES ('page-granted-child', 'library-1', 'document-child', 'page', 'page-grant-root'); \
                 INSERT INTO pages VALUES ('page-secret', 'library-1', 'document-secret', 'data_source', 'source-2'); \
                 INSERT INTO database_containers VALUES ('database-1', 'library-1'); \
                 INSERT INTO database_containers VALUES ('database-2', 'library-1'); \
                 INSERT INTO database_containers VALUES ( \
                   'database-same-storage-secret', 'library-1'); \
                 INSERT INTO data_sources VALUES ('source-1', 'library-1', 'database-1'); \
                 INSERT INTO data_sources VALUES ('source-2', 'library-1', 'database-2'); \
                 INSERT INTO data_sources VALUES ( \
                   'source-same-storage-secret', 'library-1', 'database-same-storage-secret'); \
                 INSERT INTO database_views VALUES ('view-1', 'database-1', 'source-1'); \
                 INSERT INTO database_views VALUES ('view-2', 'database-2', 'source-2'); \
                 INSERT INTO database_views VALUES ( \
                   'view-same-storage-secret', 'database-same-storage-secret', \
                   'source-same-storage-secret'); \
                 INSERT INTO project_resource_grants VALUES ( \
                   'project-1', 'page', 'page-grant-root', 'active');",
            )
            .expect("authority rows");
        connection
    }

    #[test]
    fn filters_every_coordinate_and_document_head_without_leaking_ids() {
        let connection = authority_fixture();
        let filtered = filter_for_project(
            &connection,
            "library-1",
            &context("project-1"),
            "project-1",
            ProjectionImpact::Resources {
                page_ids: vec![
                    "page-secret".to_owned(),
                    "page-own".to_owned(),
                    "page-granted-child".to_owned(),
                ],
                database_ids: vec![
                    "database-2".to_owned(),
                    "database-1".to_owned(),
                    "database-same-storage-secret".to_owned(),
                ],
                data_source_ids: vec![
                    "source-2".to_owned(),
                    "source-1".to_owned(),
                    "source-same-storage-secret".to_owned(),
                ],
                view_ids: vec![
                    "view-2".to_owned(),
                    "view-1".to_owned(),
                    "view-same-storage-secret".to_owned(),
                ],
                document_heads: vec![
                    PageDocumentHeadImpact {
                        page_id: "page-own".to_owned(),
                        document_id: "document-own".to_owned(),
                        generation: 1,
                        head_seq: 2,
                    },
                    PageDocumentHeadImpact {
                        page_id: "page-secret".to_owned(),
                        document_id: "document-secret".to_owned(),
                        generation: 1,
                        head_seq: 2,
                    },
                    PageDocumentHeadImpact {
                        page_id: "page-own".to_owned(),
                        document_id: "document-secret".to_owned(),
                        generation: 1,
                        head_seq: 3,
                    },
                ],
            },
        )
        .expect("filtered impact");

        let ProjectionImpact::Resources {
            page_ids,
            database_ids,
            data_source_ids,
            view_ids,
            document_heads,
        } = filtered
        else {
            panic!("expected resource impact");
        };
        assert_eq!(page_ids, ["page-granted-child", "page-own"]);
        assert_eq!(database_ids, ["database-1"]);
        assert_eq!(data_source_ids, ["source-1"]);
        assert_eq!(view_ids, ["view-1"]);
        assert_eq!(document_heads.len(), 1);
        assert_eq!(document_heads[0].page_id, "page-own");
    }

    #[test]
    fn preserves_all_only_after_validating_the_bound_project() {
        let connection = authority_fixture();
        assert_eq!(
            filter_for_project(
                &connection,
                "library-1",
                &context("project-1"),
                "project-1",
                ProjectionImpact::All,
            )
            .expect("Project-wide impact"),
            ProjectionImpact::All
        );
        assert!(
            filter_for_project(
                &connection,
                "library-1",
                &context("project-2"),
                "project-1",
                ProjectionImpact::All,
            )
            .is_err()
        );
    }
}
