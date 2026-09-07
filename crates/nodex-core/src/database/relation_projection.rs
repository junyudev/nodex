use std::collections::BTreeMap;

use nodex_core_contracts::database::{
    DatabaseRelationTargetItem, DatabaseRelationValuePreview, DatabaseRowSummary,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::relation::RELATION_PREVIEW_TARGETS;

const BOUNDED_RELATION_PROJECTION_SQL: &str = r#"
WITH RECURSIVE
selected_memberships(membership_id) AS MATERIALIZED (
  SELECT value
  FROM json_each(?2)
  WHERE type = 'text'
),
relation_values AS MATERIALIZED (
  SELECT
    value.membership_id,
    value.property_id,
    relation.target_data_source_id,
    value.revision
  FROM data_source_property_values value
  JOIN selected_memberships selected
    ON selected.membership_id = value.membership_id
  JOIN data_source_relation_properties relation
    ON relation.data_source_id = value.data_source_id
   AND relation.property_id = value.property_id
  WHERE value.data_source_id = ?1
    AND value.value_type = 'relation'
    AND json_type(value.value_json) = 'null'
),
target_candidates(target_data_source_id, page_id) AS MATERIALIZED (
  SELECT DISTINCT
    relation_value.target_data_source_id,
    edge.target_page_block_id
  FROM relation_values relation_value
  CROSS JOIN data_source_relation_edges edge
  WHERE edge.source_data_source_id = ?1
    AND edge.source_membership_id = relation_value.membership_id
    AND edge.property_id = relation_value.property_id
),
ancestors(target_data_source_id, root_page_id, page_id, parent_kind, parent_id, path) AS (
  SELECT
    candidate.target_data_source_id,
    candidate.page_id,
    page.block_id,
    page.parent_kind,
    page.parent_id,
    '|' || page.block_id || '|'
  FROM target_candidates candidate
  JOIN pages page
    ON page.block_id = candidate.page_id
   AND page.library_id = ?4
  UNION ALL
  SELECT
    ancestor.target_data_source_id,
    ancestor.root_page_id,
    parent.block_id,
    parent.parent_kind,
    parent.parent_id,
    ancestor.path || parent.block_id || '|'
  FROM ancestors ancestor
  JOIN pages parent
    ON ancestor.parent_kind = 'page'
   AND parent.block_id = ancestor.parent_id
   AND parent.library_id = ?4
  WHERE instr(ancestor.path, '|' || parent.block_id || '|') = 0
),
target_facts AS MATERIALIZED (
  SELECT
    candidate.target_data_source_id,
    candidate.page_id,
    block.lifecycle,
    materialization.title,
    EXISTS(
      SELECT 1
      FROM data_source_page_memberships membership
      WHERE membership.data_source_id = candidate.target_data_source_id
        AND membership.page_block_id = candidate.page_id
        AND membership.removed_at IS NULL
    ) AS active_membership,
    CASE
      WHEN ?6 IS NOT NULL THEN EXISTS(SELECT 1 FROM json_each(?6) allowed WHERE allowed.value = candidate.page_id)
      WHEN ?3 IS NULL THEN 1
      ELSE EXISTS(
        SELECT 1
        FROM projects project
        WHERE project.id = ?3
          AND project.library_id = ?4
          AND project.lifecycle = 'active'
      ) AND (
        EXISTS(
          SELECT 1
          FROM ancestors terminal
          JOIN data_sources source
            ON terminal.parent_kind = 'data_source'
           AND source.id = terminal.parent_id
           AND source.library_id = ?4
          JOIN projects project
            ON project.id = ?3
           AND project.library_id = ?4
           AND project.lifecycle = 'active'
          WHERE terminal.target_data_source_id = candidate.target_data_source_id
            AND terminal.root_page_id = candidate.page_id
            AND (
              source.home_database_block_id = project.database_block_id
              OR EXISTS(
                SELECT 1
                FROM project_resource_grants grant_row
                WHERE grant_row.project_id = ?3
                  AND grant_row.root_kind = 'database'
                  AND grant_row.root_id = source.home_database_block_id
                  AND grant_row.lifecycle = 'active'
              )
            )
        )
        OR EXISTS(
          SELECT 1
          FROM ancestors ancestor
          JOIN project_resource_grants grant_row
            ON grant_row.project_id = ?3
           AND grant_row.root_kind = 'page'
           AND grant_row.root_id = ancestor.page_id
           AND grant_row.lifecycle = 'active'
          WHERE ancestor.target_data_source_id = candidate.target_data_source_id
            AND ancestor.root_page_id = candidate.page_id
        )
      )
    END AS authorized
  FROM target_candidates candidate
  LEFT JOIN pages page
    ON page.block_id = candidate.page_id
   AND page.library_id = ?4
  LEFT JOIN blocks block
    ON block.id = page.block_id
   AND block.type = 'page'
  LEFT JOIN documents document
    ON document.id = page.document_id
  LEFT JOIN document_materializations materialization
    ON materialization.document_id = document.id
   AND materialization.generation = document.generation
   AND materialization.projected_seq = document.head_seq
   AND materialization.schema_version = document.schema_version
),
totals AS (
  SELECT
    relation_value.membership_id,
    relation_value.property_id,
    relation_value.revision,
    count(edge.target_page_block_id) AS total_count
  FROM relation_values relation_value
  LEFT JOIN data_source_relation_edges edge
    ON edge.source_data_source_id = ?1
   AND edge.source_membership_id = relation_value.membership_id
   AND edge.property_id = relation_value.property_id
  GROUP BY relation_value.membership_id, relation_value.property_id, relation_value.revision
),
relation_properties AS MATERIALIZED (
  SELECT DISTINCT property_id, target_data_source_id
  FROM relation_values
),
visible_counts AS (
  SELECT
    relation_value.membership_id,
    relation_value.property_id,
    count(*) AS visible_count
  FROM relation_properties relation_property
  JOIN target_facts fact
    ON fact.target_data_source_id = relation_property.target_data_source_id
  CROSS JOIN data_source_relation_edges edge
    INDEXED BY idx_data_source_relation_edges_property_target
  JOIN relation_values relation_value
    ON relation_value.membership_id = edge.source_membership_id
   AND relation_value.property_id = edge.property_id
   AND relation_value.target_data_source_id = fact.target_data_source_id
  WHERE fact.authorized = 1
    AND fact.lifecycle IS NOT NULL
    AND fact.title IS NOT NULL
    AND edge.source_data_source_id = ?1
    AND edge.property_id = relation_property.property_id
    AND edge.target_page_block_id = fact.page_id
  GROUP BY relation_value.membership_id, relation_value.property_id
)
SELECT
  relation_value.membership_id,
  relation_value.property_id,
  relation_value.revision,
  total.total_count,
  total.total_count - COALESCE(visible.visible_count, 0) AS restricted_count,
  COALESCE((
    SELECT json_group_array(json_object(
      'edge_id', selected.edge_id,
      'page_id', selected.page_id,
      'title', selected.title,
      'lifecycle', selected.lifecycle,
      'active_membership', selected.active_membership
    ))
    FROM (
      SELECT
        edge.edge_id,
        edge.target_page_block_id AS page_id,
        fact.title,
        fact.lifecycle,
        fact.active_membership
      FROM data_source_relation_edges edge
      CROSS JOIN target_facts fact
      WHERE edge.source_data_source_id = ?1
        AND edge.source_membership_id = relation_value.membership_id
        AND edge.property_id = relation_value.property_id
        AND fact.target_data_source_id = relation_value.target_data_source_id
        AND fact.page_id = edge.target_page_block_id
        AND fact.authorized = 1
        AND fact.lifecycle IS NOT NULL
        AND fact.title IS NOT NULL
      ORDER BY edge.target_page_block_id
      LIMIT ?5
    ) selected
  ), '[]') AS targets_json
FROM relation_values relation_value
JOIN totals total
  ON total.membership_id = relation_value.membership_id
 AND total.property_id = relation_value.property_id
LEFT JOIN visible_counts visible
  ON visible.membership_id = relation_value.membership_id
 AND visible.property_id = relation_value.property_id
ORDER BY relation_value.membership_id, relation_value.property_id
"#;

#[derive(Debug)]
struct ProjectionRow {
    membership_id: String,
    property_id: String,
    revision: i64,
    total_count: i64,
    restricted_count: i64,
    targets: Vec<DatabaseRelationTargetItem>,
}

#[derive(Deserialize)]
struct EncodedVisibleTarget {
    edge_id: String,
    page_id: String,
    title: String,
    lifecycle: String,
    active_membership: i64,
}

struct ProjectionBatch {
    previews: BTreeMap<(String, String), DatabaseRelationValuePreview>,
    #[cfg(test)]
    sqlite_row_count: usize,
    #[cfg(test)]
    hydrated_target_count: usize,
}

fn previews_for_memberships(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    membership_ids: &[&str],
) -> Result<ProjectionBatch, StoreError> {
    previews_with_visibility(
        connection,
        library_id,
        project_id,
        data_source_id,
        membership_ids,
        None,
    )
}

fn previews_with_visibility(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    membership_ids: &[&str],
    authorized_page_ids_json: Option<&str>,
) -> Result<ProjectionBatch, StoreError> {
    if membership_ids.is_empty() {
        return Ok(ProjectionBatch {
            previews: BTreeMap::new(),
            #[cfg(test)]
            sqlite_row_count: 0,
            #[cfg(test)]
            hydrated_target_count: 0,
        });
    }
    let membership_ids_json = serde_json::to_string(membership_ids)
        .map_err(|_| internal("Relation preview memberships cannot encode"))?;
    let preview_limit = i64::try_from(RELATION_PREVIEW_TARGETS)
        .map_err(|_| internal("Relation preview bound is invalid"))?;
    let encoded_rows = connection
        .prepare(BOUNDED_RELATION_PROJECTION_SQL)?
        .query_map(
            params![
                data_source_id,
                membership_ids_json,
                project_id,
                library_id,
                preview_limit,
                authorized_page_ids_json,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let rows = encoded_rows
        .into_iter()
        .map(
            |(
                membership_id,
                property_id,
                revision,
                total_count,
                restricted_count,
                targets_json,
            )| {
                let encoded_targets =
                    serde_json::from_str::<Vec<EncodedVisibleTarget>>(&targets_json)
                        .map_err(|_| corrupt("Relation preview targets are invalid"))?;
                let targets = encoded_targets
                    .into_iter()
                    .map(|target| DatabaseRelationTargetItem::Visible {
                        edge_id: target.edge_id,
                        page_id: target.page_id,
                        title: target.title,
                        membership_state: if target.active_membership != 0 {
                            "active_in_target_source".to_owned()
                        } else {
                            match target.lifecycle.as_str() {
                                "deleted" => "deleted".to_owned(),
                                "archived" => "archived".to_owned(),
                                _ => "out_of_source".to_owned(),
                            }
                        },
                        lifecycle: target.lifecycle,
                    })
                    .collect();
                Ok(ProjectionRow {
                    membership_id,
                    property_id,
                    revision,
                    total_count,
                    restricted_count,
                    targets,
                })
            },
        )
        .collect::<Result<Vec<_>, StoreError>>()?;
    #[cfg(test)]
    let sqlite_row_count = rows.len();
    let mut previews = BTreeMap::new();
    for row in rows {
        let target_count = i64::try_from(row.targets.len())
            .map_err(|_| internal("Relation preview size overflowed"))?;
        previews.insert(
            (row.membership_id, row.property_id),
            DatabaseRelationValuePreview {
                value_revision: row.revision,
                total_count: row.total_count,
                has_more: row.total_count > target_count,
                targets: row.targets,
                restricted_count: row.restricted_count,
            },
        );
    }
    #[cfg(test)]
    let hydrated_target_count = previews.values().map(|preview| preview.targets.len()).sum();
    Ok(ProjectionBatch {
        previews,
        #[cfg(test)]
        sqlite_row_count,
        #[cfg(test)]
        hydrated_target_count,
    })
}

pub(crate) fn hydrate_row_previews(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    rows: &mut [DatabaseRowSummary],
) -> Result<(), StoreError> {
    let memberships = rows
        .iter()
        .map(|row| row.membership_id.as_str())
        .collect::<Vec<_>>();
    let previews = previews_for_memberships(
        connection,
        library_id,
        project_id,
        data_source_id,
        &memberships,
    )?
    .previews;
    hydrate_rows(rows, previews)
}

/// Reuses the bounded preview query with exact Turn/task visibility instead of a renderer scope.
pub(crate) fn hydrate_agent_row_previews(
    connection: &Connection,
    context: &nodex_core_contracts::BoundModuleContext,
    library_id: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    data_source_id: &str,
    rows: &mut [DatabaseRowSummary],
) -> Result<usize, StoreError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let memberships = rows
        .iter()
        .map(|row| row.membership_id.as_str())
        .collect::<Vec<_>>();
    let memberships_json = serde_json::to_string(&memberships)
        .map_err(|_| internal("Relation memberships cannot encode"))?;
    let targets = connection
        .prepare(
            "SELECT DISTINCT edge.target_page_block_id FROM data_source_relation_edges edge \
         JOIN json_each(?2) selected ON selected.value = edge.source_membership_id \
         WHERE edge.source_data_source_id = ?1 LIMIT 100001",
        )?
        .query_map(params![data_source_id, memberships_json], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if targets.len() > 100_000 {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Displayed View relation input budget exceeded; no partial result returned",
            false,
        ));
    }
    let authorized = crate::library::agent_authorization::authorized_page_ids(
        connection,
        context,
        library_id,
        authorization,
        &targets,
    )?;
    let authorized_json = serde_json::to_string(&authorized)
        .map_err(|_| internal("Relation visibility cannot encode"))?;
    let previews = previews_with_visibility(
        connection,
        library_id,
        None,
        data_source_id,
        &memberships,
        Some(&authorized_json),
    )?
    .previews;
    hydrate_rows(rows, previews)?;
    Ok(targets.len())
}

fn hydrate_rows(
    rows: &mut [DatabaseRowSummary],
    mut previews: BTreeMap<(String, String), DatabaseRelationValuePreview>,
) -> Result<(), StoreError> {
    for row in rows {
        let membership_id = row.membership_id.clone();
        let property_ids = previews
            .range((membership_id.clone(), String::new())..)
            .take_while(|((candidate_membership_id, _), _)| {
                candidate_membership_id == &membership_id
            })
            .map(|((_, property_id), _)| property_id.clone())
            .collect::<Vec<_>>();
        for property_id in property_ids {
            let preview = previews
                .remove(&(membership_id.clone(), property_id.clone()))
                .ok_or_else(|| internal("Relation preview disappeared during hydration"))?;
            row.database_value_revisions
                .insert(property_id.clone(), preview.value_revision);
            row.database_values
                .insert(property_id, json!({ "kind": "relation", "value": preview }));
        }
    }
    Ok(())
}

pub(crate) fn hydrate_projection_values(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    membership_id: &str,
    values: &mut BTreeMap<String, Value>,
) -> Result<(), StoreError> {
    let previews = previews_for_memberships(
        connection,
        library_id,
        project_id,
        data_source_id,
        &[membership_id],
    )?
    .previews;
    for ((_, property_id), preview) in previews {
        let record = values
            .get_mut(&property_id)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| corrupt("Relation value header projection is missing"))?;
        record.insert(
            "value".to_owned(),
            json!({ "kind": "relation", "value": preview }),
        );
    }
    Ok(())
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use rusqlite::{Connection, params};

    use super::*;

    fn fixture(source_count: i64, target_count: i64, visible_count: i64) -> Connection {
        let connection = Connection::open_in_memory().expect("Relation projection fixture");
        connection
            .execute_batch(
                "CREATE TABLE data_source_property_values(\
                   data_source_id TEXT, membership_id TEXT, property_id TEXT, \
                   value_type TEXT, value_json TEXT, revision INTEGER,\
                   PRIMARY KEY(data_source_id, membership_id, property_id)\
                 ) WITHOUT ROWID;
                 CREATE TABLE data_source_relation_properties(\
                   data_source_id TEXT, property_id TEXT, target_data_source_id TEXT,\
                   PRIMARY KEY(data_source_id, property_id)\
                 ) WITHOUT ROWID;
                 CREATE TABLE data_source_relation_edges(\
                   edge_id TEXT, source_data_source_id TEXT, source_membership_id TEXT, \
                   property_id TEXT, target_page_block_id TEXT,\
                   PRIMARY KEY(source_data_source_id, source_membership_id, property_id,\
                     target_page_block_id), UNIQUE(edge_id)\
                 ) WITHOUT ROWID;
                 CREATE TABLE pages(\
                   block_id TEXT PRIMARY KEY, library_id TEXT, parent_kind TEXT, parent_id TEXT, \
                   document_id TEXT\
                 );
                 CREATE TABLE blocks(\
                   id TEXT PRIMARY KEY, type TEXT, library_id TEXT, lifecycle TEXT\
                 );
                 CREATE TABLE documents(\
                   id TEXT PRIMARY KEY, generation INTEGER, head_seq INTEGER, schema_version INTEGER\
                 );
                 CREATE TABLE document_materializations(\
                   document_id TEXT, generation INTEGER, projected_seq INTEGER, \
                   schema_version INTEGER, title TEXT, PRIMARY KEY(document_id)\
                 ) WITHOUT ROWID;
                 CREATE TABLE data_source_page_memberships(\
                   data_source_id TEXT, page_block_id TEXT, removed_at TEXT,\
                   PRIMARY KEY(data_source_id, page_block_id)\
                 ) WITHOUT ROWID;
                 CREATE TABLE projects(\
                   id TEXT PRIMARY KEY, library_id TEXT, lifecycle TEXT, database_block_id TEXT\
                 );
                 CREATE TABLE data_sources(\
                   id TEXT PRIMARY KEY, library_id TEXT, home_database_block_id TEXT\
                 );
                 CREATE TABLE project_resource_grants(\
                   project_id TEXT, root_kind TEXT, root_id TEXT, lifecycle TEXT,\
                   PRIMARY KEY(project_id, root_kind, root_id)\
                 ) WITHOUT ROWID;
                 CREATE INDEX idx_data_source_relation_edges_property_target
                   ON data_source_relation_edges(\
                     source_data_source_id, property_id, target_page_block_id, \
                     source_membership_id\
                   );
                 CREATE INDEX idx_data_source_relation_edges_target
                   ON data_source_relation_edges(\
                     target_page_block_id, source_data_source_id, property_id, \
                     source_membership_id\
                   );
                 CREATE INDEX idx_relation_target_membership
                   ON data_source_page_memberships(data_source_id, page_block_id, removed_at);
                 CREATE INDEX idx_project_resource_grants_active
                   ON project_resource_grants(project_id, root_kind, root_id, lifecycle);
                 INSERT INTO projects VALUES \
                   ('project:owner', 'library:relation', 'active', 'database:owner'), \
                   ('project:reader', 'library:relation', 'active', NULL);
                 INSERT INTO data_sources VALUES \
                   ('source:data', 'library:relation', 'database:owner'), \
                   ('target:data', 'library:relation', 'database:owner');
                 INSERT INTO data_source_relation_properties VALUES \
                   ('source:data', 'p_blocked0', 'target:data');",
            )
            .expect("create Relation projection fixture schema");
        connection
            .execute(
                "WITH RECURSIVE source(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM source WHERE value < ?1\
                 )
                 INSERT INTO data_source_property_values
                 SELECT 'source:data', printf('source:%03d', value), 'p_blocked0', \
                   'relation', 'null', 1 FROM source",
                [source_count],
            )
            .expect("seed Relation values");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO blocks
                 SELECT printf('target:%05d', value), 'page', 'library:relation', 'active' \
                 FROM target",
                [target_count],
            )
            .expect("seed target Blocks");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO documents
                 SELECT printf('document:%05d', value), 1, 1, 1 FROM target",
                [target_count],
            )
            .expect("seed target Documents");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO document_materializations
                 SELECT printf('document:%05d', value), 1, 1, 1, \
                   printf('Target %05d', value) FROM target",
                [target_count],
            )
            .expect("seed target materializations");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO pages
                 SELECT printf('target:%05d', value), 'library:relation', 'data_source', \
                   'target:data', printf('document:%05d', value) FROM target",
                [target_count],
            )
            .expect("seed target Pages");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO data_source_page_memberships
                 SELECT 'target:data', printf('target:%05d', value), NULL FROM target",
                [target_count],
            )
            .expect("seed target memberships");
        connection
            .execute(
                "WITH RECURSIVE source(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM source WHERE value < ?1\
                 ), target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?2\
                 )
                 INSERT INTO data_source_relation_edges
                 SELECT printf('%064x', (source.value - 1) * ?2 + target.value), \
                   'source:data', printf('source:%03d', source.value), 'p_blocked0', \
                   printf('target:%05d', target.value)
                 FROM source CROSS JOIN target",
                params![source_count, target_count],
            )
            .expect("seed Relation edges");
        connection
            .execute(
                "WITH RECURSIVE target(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM target WHERE value < ?1\
                 )
                 INSERT INTO project_resource_grants
                 SELECT 'project:reader', 'page', printf('target:%05d', value), 'active' \
                 FROM target",
                [visible_count],
            )
            .expect("seed readable target grants");
        connection
    }

    fn assert_bounded_projection(source_count: usize, target_count: usize) {
        let connection = fixture(
            i64::try_from(source_count).expect("source count"),
            i64::try_from(target_count).expect("target count"),
            3,
        );
        let membership_ids = (1..=source_count)
            .map(|value| format!("source:{value:03}"))
            .collect::<Vec<_>>();
        let membership_refs = membership_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let membership_ids_json = serde_json::to_string(&membership_refs).expect("memberships");
        let query_plan_sql = format!("EXPLAIN QUERY PLAN {BOUNDED_RELATION_PROJECTION_SQL}");
        let query_plan = connection
            .prepare(&query_plan_sql)
            .expect("prepare Relation query plan")
            .query_map(
                params![
                    "source:data",
                    membership_ids_json,
                    "project:reader",
                    "library:relation",
                    i64::try_from(RELATION_PREVIEW_TARGETS).unwrap(),
                    Option::<&str>::None,
                ],
                |row| row.get::<_, String>(3),
            )
            .expect("read Relation query plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect Relation query plan");
        assert!(
            query_plan.iter().any(|detail| {
                detail.contains("PRIMARY KEY")
                    || detail.contains("idx_data_source_relation_edges_property_target")
            }),
            "{query_plan:#?}"
        );
        assert!(
            query_plan
                .iter()
                .all(|detail| !detail.contains("MATERIALIZE projected_edges")),
            "{query_plan:#?}"
        );
        let started = Instant::now();
        let batch = previews_for_memberships(
            &connection,
            "library:relation",
            Some("project:reader"),
            "source:data",
            &membership_refs,
        )
        .expect("project bounded Relation previews");
        let elapsed = started.elapsed();
        assert_eq!(batch.previews.len(), source_count);
        assert_eq!(batch.sqlite_row_count, source_count);
        assert_eq!(
            batch.hydrated_target_count,
            source_count * RELATION_PREVIEW_TARGETS
        );
        for preview in batch.previews.values() {
            assert_eq!(preview.total_count, i64::try_from(target_count).unwrap());
            assert_eq!(
                preview.restricted_count,
                i64::try_from(target_count - 3).unwrap()
            );
            assert_eq!(preview.targets.len(), RELATION_PREVIEW_TARGETS);
            assert!(preview.targets.iter().all(|target| matches!(
                target,
                DatabaseRelationTargetItem::Visible { page_id, .. }
                    if matches!(page_id.as_str(), "target:00001" | "target:00002" | "target:00003")
            )));
        }
        eprintln!(
            "relation_projection source_rows={source_count} edges_per_row={target_count} \
             total_edges={} sqlite_rows={} rust_hydrated_targets={} elapsed_ms={:.3}",
            source_count * target_count,
            batch.sqlite_row_count,
            batch.hydrated_target_count,
            elapsed.as_secs_f64() * 1_000.0,
        );
        eprintln!("relation_projection_query_plan={query_plan:#?}");
    }

    #[test]
    fn sqlite_boundary_returns_only_top_k_visible_relation_targets() {
        assert_bounded_projection(8, 128);
    }

    #[test]
    #[ignore = "release-only million-edge Relation projection benchmark"]
    fn million_edge_relation_projection_stays_bounded_at_sqlite_boundary() {
        assert_bounded_projection(100, 10_000);
    }
}
