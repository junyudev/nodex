use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use nodex_core_contracts::database::DatabaseViewFilter;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::database::property_semantics::{
    PRIORITY_OPTIONS, is_priority_option_id, option_config_from_storage,
};
use crate::document::CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION;

use super::schema::{CURRENT_STORE_REVISION, validate_schema_identity};
use super::sqlite::{StoreError, StoreErrorCode, validate_store};

const CORE_SCHEMA_OWNER: &str = "rust_core";

#[derive(Clone, Copy)]
pub(crate) enum DatabaseViewStorageContract {
    V4,
    V5,
    V6,
}

/// Validates the complete current Store contract through one deep interface.
pub(crate) fn validate_current_store(connection: &Connection) -> Result<(), StoreError> {
    let started_at = Instant::now();
    validate_store(connection)?;
    validate_schema_identity(connection, CURRENT_STORE_REVISION)?;
    validate_core_metadata(connection)?;
    validate_store_semantics(connection)?;
    validate_current_document_projections(connection)?;
    tracing::info!(
        durationMs = duration_millis(started_at.elapsed()),
        "Deep current Store validation completed"
    );
    Ok(())
}

/// Validates source coordinates and payload fields that exist only in the
/// current schema. Migration sources intentionally skip this check so a
/// corrective migration can repair a previously published incomplete state.
fn validate_current_document_projections(connection: &Connection) -> Result<(), StoreError> {
    let invalid_files: i64 = connection.query_row(
        "SELECT count(*) FROM library_files file WHERE
         EXISTS(SELECT 1 FROM retired_file_ids retired WHERE retired.file_id = file.file_id)
         OR (file.lifecycle = 'trashed' AND (
           EXISTS(SELECT 1 FROM page_file_entries entry WHERE entry.file_id = file.file_id)
           OR EXISTS(SELECT 1 FROM block_asset_refs reference WHERE reference.file_id = file.file_id)
           OR EXISTS(SELECT 1 FROM canvas_scene_file_refs reference WHERE reference.target_file_id = file.file_id)
         ))", [], |row| row.get(0),
    )?;
    expect_zero(
        invalid_files,
        "retired or trashed Files with live relationships",
    )?;

    let invalid_materializations: i64 = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM documents document \
            LEFT JOIN document_materializations materialization \
              ON materialization.document_id = document.id \
            WHERE document.readiness = 'ready' AND document.authority = 'ydoc_primary' \
              AND document.sync_engine = 'yjs' AND ( \
                materialization.document_id IS NULL \
                OR materialization.generation <> document.generation \
                OR materialization.projected_seq <> document.head_seq \
                OR materialization.schema_version <> document.schema_version \
              )) + \
           (SELECT count(*) FROM document_materializations materialization \
            LEFT JOIN documents document ON document.id = materialization.document_id \
            WHERE document.id IS NULL OR document.readiness <> 'ready' \
              OR document.authority <> 'ydoc_primary' OR document.sync_engine <> 'yjs' \
              OR materialization.generation <> document.generation \
              OR materialization.projected_seq <> document.head_seq \
              OR materialization.schema_version <> document.schema_version) + \
           (SELECT count(*) FROM document_block_index block_index \
            LEFT JOIN documents document ON document.id = block_index.document_id \
            WHERE document.id IS NULL OR document.readiness <> 'ready' \
              OR document.authority <> 'ydoc_primary' OR document.sync_engine <> 'yjs' \
              OR block_index.projected_seq <> document.head_seq)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(
        invalid_materializations,
        "stale Document materialization or Block-index projections",
    )?;

    let invalid_page_coordinates: i64 = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM pages page \
            JOIN blocks block ON block.id = page.block_id \
            LEFT JOIN block_documents ownership \
              ON ownership.block_id = page.block_id \
             AND ownership.document_id = page.document_id \
             AND ownership.library_id = page.library_id \
            LEFT JOIN page_read_model projection ON projection.page_block_id = page.block_id \
            WHERE block.type <> 'page' OR block.library_id <> page.library_id \
              OR ownership.block_id IS NULL OR projection.page_block_id IS NULL) + \
           (SELECT count(*) FROM page_read_model projection \
            LEFT JOIN blocks block ON block.id = projection.page_block_id \
            LEFT JOIN pages page \
              ON page.block_id = projection.page_block_id \
             AND page.library_id = projection.library_id \
             AND page.document_id = projection.document_id \
            LEFT JOIN block_documents ownership \
              ON ownership.block_id = projection.page_block_id \
             AND ownership.document_id = projection.document_id \
             AND ownership.library_id = projection.library_id \
            LEFT JOIN documents document ON document.id = projection.document_id \
            LEFT JOIN library_block_placements placement \
              ON placement.block_id = projection.page_block_id \
             AND projection.parent_kind = 'library' \
            WHERE block.id IS NULL OR block.library_id <> projection.library_id \
              OR block.type <> 'page' OR page.block_id IS NULL OR ownership.block_id IS NULL \
              OR page.parent_kind <> projection.parent_kind \
              OR page.parent_id <> projection.parent_id \
              OR document.id IS NULL OR document.library_id <> projection.library_id \
              OR document.readiness <> 'ready' OR document.sync_engine <> 'yjs' \
              OR document.authority <> 'ydoc_primary' \
              OR document.generation <> projection.document_generation \
              OR document.head_seq <> projection.document_projected_seq \
              OR document.schema_version <> projection.document_schema_version \
              OR document.authority <> projection.document_authority \
              OR block.lifecycle <> projection.lifecycle \
              OR block.placement_revision <> projection.placement_revision \
              OR block.metadata_revision <> projection.metadata_revision \
              OR (projection.parent_kind = 'library' AND projection.lifecycle <> 'deleted' \
                  AND placement.rank_key IS NOT projection.library_rank_key) \
              OR ((projection.parent_kind <> 'library' OR projection.lifecycle = 'deleted') \
                  AND projection.library_rank_key IS NOT NULL) \
              OR (projection.membership_id IS NOT NULL AND NOT EXISTS ( \
                SELECT 1 FROM data_source_page_memberships membership \
                JOIN data_sources source ON source.id = membership.data_source_id \
                WHERE membership.id = projection.membership_id \
                  AND membership.page_block_id = projection.page_block_id \
                  AND membership.removed_at IS NULL \
                  AND source.home_database_block_id = projection.database_block_id \
              )) \
              OR (projection.view_id IS NOT NULL AND NOT EXISTS ( \
                SELECT 1 FROM database_views view \
                JOIN data_source_page_memberships membership \
                  ON membership.id = projection.membership_id \
                 AND membership.data_source_id = view.data_source_id \
                WHERE view.id = projection.view_id \
                  AND view.database_block_id = projection.database_block_id \
              )))",
        [],
        |row| row.get(0),
    )?;
    expect_zero(
        invalid_page_coordinates,
        "stale Page read-model source coordinates",
    )?;

    let mut statement = connection.prepare(
        "SELECT projection.page_block_id, projection.title, projection.description_preview, \
                projection.description_length, projection.has_description, \
                materialization.title, materialization.preview, materialization.nfm \
         FROM page_read_model projection \
         JOIN document_materializations materialization \
           ON materialization.document_id = projection.document_id \
         ORDER BY projection.page_block_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, bool>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    for row in rows {
        let (
            page_id,
            title,
            preview,
            description_length,
            has_description,
            source_title,
            source_preview,
            nfm,
        ) = row?;
        let source_length = i64::try_from(nfm.len())
            .map_err(|_| corrupt("Page materialization description length overflowed"))?;
        if title == source_title
            && preview == source_preview
            && description_length == source_length
            && has_description == !nfm.trim().is_empty()
        {
            continue;
        }
        return Err(corrupt(format!(
            "Page {page_id} read-model payload is stale"
        )));
    }

    // Yjs materialization rewrites every secondary row at one exact Document
    // head. Canvas instead updates only changed rows and atomically advances a
    // collection-level projection head, so unchanged rows may legitimately
    // retain the sequence at which their value last changed.
    let invalid_secondary_sources: i64 = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM block_asset_refs projection \
            LEFT JOIN documents document ON document.id = projection.document_id \
            LEFT JOIN block_documents ownership \
              ON ownership.document_id = projection.document_id \
             AND ownership.block_id = projection.owner_block_id \
             AND ownership.library_id = projection.library_id \
            LEFT JOIN document_block_index block_index \
              ON block_index.document_id = projection.document_id \
             AND block_index.block_id = projection.block_id \
            WHERE document.id IS NULL OR ownership.block_id IS NULL OR block_index.block_id IS NULL \
              OR document.library_id <> projection.library_id \
              OR document.generation <> projection.document_generation \
              OR document.head_seq <> projection.projected_seq \
              OR block_index.projected_seq <> projection.projected_seq) + \
           (SELECT count(*) FROM block_search_units projection \
            LEFT JOIN documents document ON document.id = projection.document_id \
            LEFT JOIN block_documents ownership \
              ON ownership.document_id = projection.document_id \
             AND ownership.block_id = projection.owner_block_id \
             AND ownership.library_id = projection.library_id \
            LEFT JOIN document_block_index block_index \
              ON block_index.document_id = projection.document_id \
             AND block_index.block_id = projection.block_id \
            LEFT JOIN canvas_scene_projection_heads canvas_head \
              ON canvas_head.document_id = projection.document_id \
            WHERE projection.document_id IS NOT NULL AND ( \
              document.id IS NULL OR ownership.block_id IS NULL \
              OR document.library_id <> projection.library_id \
              OR document.generation <> projection.document_generation \
              OR (document.sync_engine = 'yjs' AND ( \
                document.head_seq <> projection.projected_seq \
                OR (projection.block_id <> projection.owner_block_id \
                    AND block_index.block_id IS NULL) \
              )) \
              OR (document.sync_engine = 'canvas_scene' AND ( \
                document.readiness <> 'ready' OR document.authority <> 'ydoc_primary' \
                OR projection.block_id <> projection.owner_block_id \
                OR projection.source_kind <> 'document_marker' \
                OR projection.field_key <> 'marker' \
                OR canvas_head.document_id IS NULL \
                OR canvas_head.generation <> document.generation \
                OR canvas_head.projected_head_seq <> document.head_seq \
                OR projection.projected_seq > canvas_head.projected_head_seq \
              )) \
              OR document.sync_engine NOT IN ('yjs', 'canvas_scene') \
            )) + \
           (SELECT count(*) FROM canvas_page_references projection \
            LEFT JOIN documents document ON document.id = projection.document_id \
            LEFT JOIN block_documents ownership \
              ON ownership.document_id = projection.document_id \
             AND ownership.block_id = projection.owner_block_id \
             AND ownership.library_id = projection.library_id \
            LEFT JOIN blocks target ON target.id = projection.target_block_id \
            LEFT JOIN canvas_scene_projection_heads canvas_head \
              ON canvas_head.document_id = projection.document_id \
            WHERE document.id IS NULL OR ownership.block_id IS NULL OR target.id IS NULL \
              OR document.library_id <> projection.library_id \
              OR document.readiness <> 'ready' OR document.authority <> 'ydoc_primary' \
              OR document.sync_engine <> 'canvas_scene' \
              OR document.generation <> projection.document_generation \
              OR canvas_head.document_id IS NULL \
              OR canvas_head.generation <> document.generation \
              OR canvas_head.projected_head_seq <> document.head_seq \
              OR projection.projected_seq > canvas_head.projected_head_seq \
              OR target.library_id <> projection.library_id) + \
           (SELECT count(*) FROM scheduled_page_index projection \
            LEFT JOIN blocks block \
              ON block.id = projection.page_block_id \
             AND block.library_id = projection.library_id \
            LEFT JOIN pages page \
              ON page.block_id = projection.page_block_id \
             AND page.library_id = projection.library_id \
            LEFT JOIN block_documents ownership \
              ON ownership.block_id = page.block_id \
             AND ownership.document_id = page.document_id \
             AND ownership.library_id = page.library_id \
            WHERE block.id IS NULL OR block.type <> 'page' OR page.block_id IS NULL \
              OR ownership.block_id IS NULL OR block.lifecycle <> projection.lifecycle \
              OR block.metadata_revision <> projection.source_metadata_revision)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(
        invalid_secondary_sources,
        "stale Document secondary or scheduled Page projections",
    )
}

/// Validates semantic authority encoded by the current Store contract.
pub(crate) fn validate_store_semantics(connection: &Connection) -> Result<(), StoreError> {
    validate_store_semantics_for_view_contract(connection, DatabaseViewStorageContract::V6, true)
}

/// Validates semantic authority while decoding versioned storage envelopes
/// with the exact contract owned by the migration source revision.
pub(crate) fn validate_migration_source_semantics(
    connection: &Connection,
    view_contract: DatabaseViewStorageContract,
    has_library_files: bool,
) -> Result<(), StoreError> {
    validate_store_semantics_for_view_contract(connection, view_contract, has_library_files)
}

fn validate_store_semantics_for_view_contract(
    connection: &Connection,
    view_contract: DatabaseViewStorageContract,
    has_library_files: bool,
) -> Result<(), StoreError> {
    let started_at = Instant::now();
    validate_codex_thread_timestamp_invariants(connection)?;
    let canonical_timestamp_started_at = Instant::now();
    validate_canonical_text_timestamp_invariants(connection)?;
    tracing::info!(
        durationMs = duration_millis(canonical_timestamp_started_at.elapsed()),
        "Canonical Store timestamp validation completed"
    );
    validate_thread_execution_hosts(connection)?;
    validate_default_draft_sessions(connection)?;
    validate_page_chat_links(connection)?;
    validate_thread_recency(connection)?;
    validate_subagent_projection(connection)?;
    validate_page_key_invariants(connection)?;
    validate_database_relation_invariants(connection)?;
    validate_database_priority_invariants_for_view_contract(connection, view_contract)?;
    validate_library_content_ownership(connection)?;
    validate_project_resource_grants(connection, has_library_files)?;
    validate_document_block_tombstones(connection)?;
    validate_document_page_references(connection)?;
    validate_block_transfer_undo(connection)?;
    validate_structural_edit_evidence(connection, has_library_files)?;
    validate_document_version_retention_index(connection)?;
    validate_block_retention_state(connection)?;
    validate_document_materialization_derivation(connection)?;
    if has_library_files {
        crate::workspace::queued_follow_up::validate_all_stored_ledgers(
            connection,
            crate::workspace::queued_follow_up::QueuedAssetEvidenceMode::DatabaseOnly,
        )?;
    }
    tracing::info!(
        durationMs = duration_millis(started_at.elapsed()),
        "Semantic Store validation completed"
    );
    Ok(())
}

fn validate_block_retention_state(connection: &Connection) -> Result<(), StoreError> {
    let installed = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' \
             AND name = 'block_retention_state'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !installed {
        return Ok(());
    }
    let invalid: i64 = connection.query_row(
        "SELECT CASE WHEN \
           (SELECT count(*) FROM block_retention_state WHERE id = 1) <> 1 \
           OR (SELECT maintenance_revision FROM block_retention_state WHERE id = 1) \
              < (SELECT count(*) FROM block_retention_deferrals) \
           OR EXISTS ( \
             SELECT 1 FROM block_retention_deferrals deferral \
             LEFT JOIN blocks block ON block.id = deferral.root_block_id \
             WHERE block.id IS NULL \
           ) \
         THEN 1 ELSE 0 END",
        [],
        |row| row.get(0),
    )?;
    if invalid != 0 {
        return Err(corrupt("Block retention deferral state is inconsistent"));
    }
    Ok(())
}

fn validate_document_version_retention_index(connection: &Connection) -> Result<(), StoreError> {
    let installed = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' \
             AND name = 'document_version_retention_index'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !installed {
        return Ok(());
    }
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM document_version_retention_index retention \
         JOIN document_versions version ON version.version_id = retention.version_id \
         WHERE retention.checkpoint_hash <> version.checkpoint_hash \
            OR retention.member_count <> ( \
              SELECT count(*) FROM document_version_retention_members member \
              WHERE member.version_id = retention.version_id \
            )",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid Document version retention indexes")
}

pub(crate) fn validate_core_metadata(connection: &Connection) -> Result<(), StoreError> {
    let metadata = connection
        .query_row(
            "SELECT schema_owner, projection_event_v2_floor, \
                    (SELECT COALESCE(MAX(seq), 0) FROM change_log) \
             FROM core_store_metadata WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((owner, floor, commit_head)) = metadata else {
        return Err(corrupt("Current Store is missing Core metadata"));
    };
    if owner != CORE_SCHEMA_OWNER {
        return Err(corrupt("Current Store has an invalid schema owner"));
    }
    if !(1..=commit_head + 1).contains(&floor) {
        return Err(corrupt("Projection event replay floor is invalid"));
    }
    Ok(())
}

/// Validates the durable Thread clock at startup and Store-copy seams.
pub(crate) fn validate_codex_thread_timestamp_invariants(
    connection: &Connection,
) -> Result<(), StoreError> {
    let invalid = connection
        .query_row(
            "SELECT thread_id FROM codex_threads WHERE updated_at < created_at LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if invalid.is_none() {
        return Ok(());
    }
    Err(corrupt(
        "Codex Thread update time precedes creation in the current Store",
    ))
}

pub(crate) fn validate_database_priority_invariants(
    connection: &Connection,
) -> Result<(), StoreError> {
    validate_database_priority_invariants_for_view_contract(
        connection,
        DatabaseViewStorageContract::V6,
    )
}

fn validate_database_priority_invariants_for_view_contract(
    connection: &Connection,
    view_contract: DatabaseViewStorageContract,
) -> Result<(), StoreError> {
    let properties = connection
        .prepare(
            "SELECT data_source_id, value_type, config_json \
             FROM data_source_properties WHERE id = 'priority' ORDER BY data_source_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut registries = BTreeMap::<String, BTreeSet<String>>::new();
    for (data_source_id, value_type, config_json) in properties {
        if value_type != "select" {
            return Err(corrupt(format!(
                "Priority Property for Data Source {data_source_id} is not a select"
            )));
        }
        let config = option_config_from_storage("priority", &value_type, &config_json)?;
        let option_ids = config
            .options
            .into_iter()
            .map(|option| option.id)
            .collect::<BTreeSet<_>>();
        let known = PRIORITY_OPTIONS
            .iter()
            .map(|(id, _)| (*id).to_owned())
            .collect::<BTreeSet<_>>();
        if !option_ids.is_subset(&known) {
            return Err(corrupt(format!(
                "Priority registry for Data Source {data_source_id} is noncanonical"
            )));
        }
        registries.insert(data_source_id, option_ids);
    }

    let mut values_statement = connection.prepare(
        "SELECT data_source_id, membership_id, value_json \
         FROM data_source_property_values WHERE property_id = 'priority'",
    )?;
    let values = values_statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for value in values {
        let (data_source_id, membership_id, raw) = value?;
        let registry = registries.get(&data_source_id).ok_or_else(|| {
            corrupt(format!(
                "Priority value {data_source_id}/{membership_id} has no registry"
            ))
        })?;
        let value = serde_json::from_str::<Value>(&raw).map_err(|_| {
            corrupt(format!(
                "Priority value {data_source_id}/{membership_id} is invalid"
            ))
        })?;
        if value.is_null() {
            continue;
        }
        if value
            .as_str()
            .is_some_and(|option| is_priority_option_id(option) && registry.contains(option))
        {
            continue;
        }
        return Err(corrupt(format!(
            "Priority value {data_source_id}/{membership_id} is noncanonical"
        )));
    }

    let mut projections_statement =
        connection.prepare("SELECT page_block_id, database_values_json FROM page_read_model")?;
    let projections = projections_statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for projection in projections {
        let (page_id, raw) = projection?;
        let values = serde_json::from_str::<Map<String, Value>>(&raw)
            .map_err(|_| corrupt(format!("Page {page_id} Database values are invalid")))?;
        if let Some(value) = values.get("priority")
            && !value.is_null()
            && !value.as_str().is_some_and(is_priority_option_id)
        {
            return Err(corrupt(format!(
                "Page {page_id} Priority projection is noncanonical"
            )));
        }
    }

    let views = connection
        .prepare("SELECT id, config_json FROM database_views ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (view_id, raw) in views {
        let projection = match view_contract {
            DatabaseViewStorageContract::V4 => {
                crate::database::view_contract::decode_legacy_definition_validation_json(&raw)
            }
            DatabaseViewStorageContract::V5 => {
                crate::database::view_contract::decode_v5_definition_validation_json(&raw)
            }
            DatabaseViewStorageContract::V6 => {
                crate::database::view_contract::decode_definition_validation_json(&raw)
            }
        }
        .map_err(|_| corrupt(format!("Database View {view_id} config is invalid")))?;
        validate_priority_filter(&view_id, &projection.filter)?;
        let groups_by_priority = projection
            .group
            .as_ref()
            .is_some_and(|group| group.property_id == "priority");
        if !groups_by_priority {
            continue;
        }
        let invalid_position = connection
            .query_row(
                "SELECT group_key FROM database_view_page_positions \
                 WHERE view_id = ?1 AND group_key IS NOT NULL \
                   AND group_key NOT IN ('p0-critical', 'p1-high', 'p2-medium', 'p3-low') \
                 ORDER BY page_block_id LIMIT 1",
                [view_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(group_key) = invalid_position {
            return Err(corrupt(format!(
                "Priority-grouped View {view_id} has noncanonical group key {group_key}"
            )));
        }
        let invalid_projection = connection
            .query_row(
                "SELECT view_group_key FROM page_read_model \
                 WHERE view_id = ?1 AND view_group_key IS NOT NULL \
                   AND view_group_key NOT IN \
                     ('p0-critical', 'p1-high', 'p2-medium', 'p3-low') \
                 ORDER BY page_block_id LIMIT 1",
                [view_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(group_key) = invalid_projection {
            return Err(corrupt(format!(
                "Priority-grouped View {view_id} projects noncanonical group key {group_key}"
            )));
        }
    }
    Ok(())
}

fn validate_priority_filter(view_id: &str, filter: &DatabaseViewFilter) -> Result<(), StoreError> {
    match filter {
        DatabaseViewFilter::Group { children, .. } => {
            for child in children {
                validate_priority_filter(view_id, child)?;
            }
        }
        DatabaseViewFilter::Clause {
            property_id,
            operator,
            value,
        } if property_id == "priority"
            && matches!(
                operator,
                nodex_core_contracts::database::DatabaseViewFilterOperator::Equals
                    | nodex_core_contracts::database::DatabaseViewFilterOperator::NotEquals
            )
            && !value
                .as_ref()
                .and_then(Option::as_ref)
                .and_then(Value::as_str)
                .is_some_and(is_priority_option_id) =>
        {
            return Err(corrupt(format!(
                "Database View {view_id} Priority filter is noncanonical"
            )));
        }
        DatabaseViewFilter::Clause { .. } => {}
    }
    Ok(())
}

fn validate_thread_execution_hosts(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM codex_threads \
         WHERE execution_host_id <> trim(execution_host_id) \
            OR length(execution_host_id) NOT BETWEEN 1 AND 512",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid Thread execution host identities")
}

fn validate_default_draft_sessions(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM project_sessions session \
         WHERE session.is_default_draft NOT IN (0, 1) \
            OR (session.is_default_draft = 1 AND session.archived <> 0) \
            OR (session.is_default_draft = 1 AND EXISTS (\
              SELECT 1 FROM project_session_threads link WHERE link.session_id = session.id\
            ))",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid default-draft Project Sessions")
}

fn validate_page_chat_links(connection: &Connection) -> Result<(), StoreError> {
    let relation_table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema \
         WHERE type = 'table' AND name = 'project_session_pages')",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !relation_table_exists {
        return Ok(());
    }
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM project_session_pages relation \
         JOIN pages page ON page.block_id = relation.page_id \
         JOIN project_sessions session ON session.id = relation.session_id \
         LEFT JOIN projects project ON project.id = session.project_id \
         WHERE session.project_id IS NOT NULL \
           AND (project.id IS NULL OR project.library_id <> page.library_id)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "cross-Library Page Linked chat edges")
}

fn validate_thread_recency(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM codex_threads WHERE recency_at < created_at OR recency_at < 0",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid Thread recency timestamps")
}

fn validate_subagent_projection(connection: &Connection) -> Result<(), StoreError> {
    let installed = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'workspace_subagent_universes')",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !installed {
        return Ok(());
    }
    let invalid: i64 = connection.query_row(
        "WITH RECURSIVE reachable(
           host_id, source_epoch, generation, root_thread_id, thread_id
         ) AS (
           SELECT descendant.host_id, descendant.source_epoch, descendant.generation,
             descendant.root_thread_id, descendant.thread_id
           FROM workspace_subagent_descendants descendant
           WHERE descendant.parent_thread_id = descendant.root_thread_id
           UNION
           SELECT child.host_id, child.source_epoch, child.generation,
             child.root_thread_id, child.thread_id
           FROM workspace_subagent_descendants child
           JOIN reachable parent
             ON child.host_id = parent.host_id
            AND child.source_epoch = parent.source_epoch
            AND child.generation = parent.generation
            AND child.root_thread_id = parent.root_thread_id
            AND child.parent_thread_id = parent.thread_id
         )
         SELECT
           (SELECT count(*)
            FROM workspace_subagent_universes universe
            JOIN workspace_subagent_descendants descendant
              ON descendant.host_id = universe.host_id
             AND descendant.source_epoch = universe.source_epoch
             AND descendant.generation = universe.generation
             AND descendant.root_thread_id = universe.root_thread_id
            LEFT JOIN reachable
              ON reachable.host_id = descendant.host_id
             AND reachable.source_epoch = descendant.source_epoch
             AND reachable.generation = descendant.generation
             AND reachable.root_thread_id = descendant.root_thread_id
             AND reachable.thread_id = descendant.thread_id
            WHERE universe.discovery_complete = 1 AND reachable.thread_id IS NULL)
           +
           (SELECT count(*)
            FROM workspace_subagent_lifecycle_operations operation
            WHERE NOT EXISTS (
              SELECT 1 FROM workspace_subagent_lifecycle_members member
              WHERE member.lifecycle_operation_id = operation.lifecycle_operation_id
            ))
           +
           (SELECT count(*) FROM workspace_subagent_pending_status_evidence pending
            WHERE pending.evidence_kind = 'completion' AND pending.status <> 'done')
           +
           (SELECT COALESCE(sum(excess), 0) FROM (
              SELECT max(count(*) - 4096, 0) AS excess
              FROM workspace_subagent_pending_status_evidence
              GROUP BY library_id
            ))",
        [],
        |row| row.get(0),
    )?;
    expect_zero(
        invalid,
        "invalid completed Subagent closure, pending evidence, or empty lifecycle operation",
    )
}

fn validate_page_key_invariants(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM project_database_bindings binding \
            LEFT JOIN page_key_namespaces namespace \
              ON namespace.database_block_id = binding.database_block_id \
             AND namespace.library_id = binding.library_id \
            WHERE namespace.database_block_id IS NULL) + \
           (SELECT count(*) FROM (\
             SELECT namespace.database_block_id \
             FROM page_key_namespaces namespace \
             LEFT JOIN page_key_prefixes prefix \
               ON prefix.database_block_id = namespace.database_block_id \
              AND prefix.library_id = namespace.library_id \
              AND prefix.retired_at IS NULL \
             GROUP BY namespace.database_block_id \
             HAVING count(prefix.normalized_prefix) <> 1\
           )) + \
           (SELECT count(*) FROM (\
             SELECT namespace.database_block_id \
             FROM page_key_namespaces namespace \
             LEFT JOIN page_key_assignments assignment \
               ON assignment.database_block_id = namespace.database_block_id \
             GROUP BY namespace.database_block_id, namespace.next_number \
             HAVING namespace.next_number <= COALESCE(MAX(assignment.number), 0)\
           ))",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid Page-key authority records")
}

fn validate_database_relation_invariants(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT \
          (SELECT count(*) FROM data_source_relation_properties relation \
           LEFT JOIN data_source_properties property \
             ON property.data_source_id = relation.data_source_id \
            AND property.id = relation.property_id \
           LEFT JOIN data_sources source ON source.id = relation.data_source_id \
           LEFT JOIN data_sources target ON target.id = relation.target_data_source_id \
           WHERE property.value_type IS NOT 'relation' \
              OR property.config_json <> '{}' \
              OR relation.cardinality NOT IN ('one', 'many') \
              OR source.library_id IS NULL OR target.library_id IS NULL \
              OR source.library_id <> target.library_id) + \
          (SELECT count(*) FROM data_source_properties property \
           WHERE property.value_type = 'relation' AND NOT EXISTS (\
             SELECT 1 FROM data_source_relation_properties relation \
             WHERE relation.data_source_id = property.data_source_id \
               AND relation.property_id = property.id\
           )) + \
          (SELECT count(*) FROM data_source_property_values value \
           WHERE value.value_type = 'relation' \
             AND json_type(value.value_json) IS NOT 'null') + \
          (SELECT count(*) FROM (\
             SELECT edge.source_data_source_id, edge.source_membership_id, edge.property_id \
             FROM data_source_relation_edges edge \
             JOIN data_source_relation_properties relation \
               ON relation.data_source_id = edge.source_data_source_id \
              AND relation.property_id = edge.property_id \
             WHERE relation.cardinality = 'one' \
             GROUP BY edge.source_data_source_id, edge.source_membership_id, edge.property_id \
             HAVING count(*) > 1\
           )) + \
          (SELECT count(*) FROM data_source_relation_edges \
           WHERE property_id <> 'task_parent' AND sibling_rank IS NOT NULL)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "inconsistent Relation Property authority records")?;

    let parents = connection
        .prepare(
            "SELECT child.page_block_id, edge.target_page_block_id \
             FROM data_source_relation_edges edge \
             JOIN data_source_page_memberships child \
               ON child.data_source_id = edge.source_data_source_id \
              AND child.id = edge.source_membership_id \
             WHERE edge.property_id = 'task_parent' ORDER BY child.page_block_id",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    for page_id in parents.keys() {
        let mut cursor = Some(page_id.as_str());
        let mut visited = BTreeSet::new();
        let mut depth = 0usize;
        while let Some(current) = cursor {
            if !visited.insert(current) {
                return Err(corrupt("Task Parent Relation contains a cycle"));
            }
            cursor = parents.get(current).map(String::as_str);
            if cursor.is_none() {
                continue;
            }
            depth += 1;
            if depth > 10 {
                return Err(corrupt("Task Parent Relation exceeds depth 10"));
            }
        }
    }
    Ok(())
}

fn validate_library_content_ownership(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT \
          (SELECT count(*) FROM block_documents ownership \
           JOIN blocks block ON block.id = ownership.block_id \
           JOIN documents document ON document.id = ownership.document_id \
           WHERE ownership.library_id <> block.library_id \
              OR ownership.library_id <> document.library_id) + \
          (SELECT count(*) FROM pages page \
           JOIN blocks block ON block.id = page.block_id \
           JOIN block_documents ownership ON ownership.block_id = page.block_id \
           WHERE page.library_id <> block.library_id OR block.type <> 'page' \
              OR ownership.library_id <> page.library_id \
              OR ownership.document_id <> page.document_id) + \
          (SELECT count(*) FROM library_block_placements placement \
           LEFT JOIN blocks block ON block.id = placement.block_id \
           WHERE block.id IS NULL OR block.library_id <> placement.library_id \
              OR block.lifecycle = 'deleted')",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "Library content ownership mismatches")
}

fn validate_project_resource_grants(
    connection: &Connection,
    has_library_files: bool,
) -> Result<(), StoreError> {
    if !has_library_files {
        let invalid: i64 = connection.query_row(
            "SELECT count(*) FROM project_resource_grants grant_row \
             LEFT JOIN projects project ON project.id = grant_row.project_id \
             LEFT JOIN blocks block ON block.id = grant_row.root_id \
             WHERE grant_row.lifecycle = 'active' AND ( \
               project.id IS NULL OR project.library_id <> grant_row.library_id \
               OR block.id IS NULL OR block.library_id <> grant_row.library_id \
               OR block.type <> grant_row.root_kind \
             )",
            [],
            |row| row.get(0),
        )?;
        return expect_zero(invalid, "invalid active Project resource grants");
    }
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM project_resource_grants grant_row \
         LEFT JOIN projects project ON project.id = grant_row.project_id \
         LEFT JOIN blocks block \
           ON grant_row.root_kind <> 'file' AND block.id = grant_row.root_id \
         LEFT JOIN library_files file \
           ON grant_row.root_kind = 'file' AND file.file_id = grant_row.root_id \
         WHERE grant_row.lifecycle = 'active' AND ( \
           project.id IS NULL OR project.library_id <> grant_row.library_id \
           OR (grant_row.root_kind = 'file' AND ( \
                file.file_id IS NULL OR file.library_id <> grant_row.library_id)) \
           OR (grant_row.root_kind <> 'file' AND ( \
                block.id IS NULL OR block.library_id <> grant_row.library_id \
                OR block.type <> grant_row.root_kind)) \
         )",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid active Project resource grants")
}

fn validate_document_block_tombstones(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM document_block_tombstones tombstone \
         LEFT JOIN blocks block ON block.id = tombstone.block_id \
         LEFT JOIN documents document ON document.id = tombstone.document_id \
         WHERE block.id IS NULL OR document.id IS NULL \
            OR block.library_id <> tombstone.library_id \
            OR document.library_id <> tombstone.library_id \
            OR block.lifecycle <> 'deleted' \
            OR block.placement_revision <> tombstone.placement_revision \
            OR document.generation <> tombstone.document_generation \
            OR tombstone.deletion_head_seq > document.head_seq \
            OR EXISTS (SELECT 1 FROM document_block_index entry \
                       WHERE entry.block_id = tombstone.block_id) \
            OR EXISTS (SELECT 1 FROM library_block_placements placement \
                       WHERE placement.block_id = tombstone.block_id)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "Document Block tombstone mismatches")?;
    let unresolved: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_relocation_obligations",
        [],
        |row| row.get(0),
    )?;
    expect_zero(unresolved, "unresolved LocalCommit relocation obligations")
}

fn validate_document_page_references(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM document_page_references reference \
         LEFT JOIN block_documents ownership \
           ON ownership.document_id = reference.document_id \
          AND ownership.block_id = reference.source_owner_block_id \
         WHERE ownership.block_id IS NULL",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid normalized Page references")
}

fn validate_block_transfer_undo(connection: &Connection) -> Result<(), StoreError> {
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM block_transfer_undo_recipes recipe \
         WHERE (recipe.consumed_at IS NOT NULL AND length(recipe.consumed_at) = 0) \
            OR NOT EXISTS (\
              SELECT 1 FROM block_mutations mutation \
              WHERE mutation.mutation_id = recipe.transfer_operation_id \
                AND mutation.mutation_kind = 'block_transfer' \
                AND mutation.project_id = recipe.project_id \
                AND mutation.store_epoch = recipe.store_epoch\
            )",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid, "invalid Block transfer Undo recipes")
}

fn validate_structural_edit_evidence(
    connection: &Connection,
    has_library_files: bool,
) -> Result<(), StoreError> {
    let installed = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' \
             AND name = 'structural_clipboard_bundles'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !installed {
        return Ok(());
    }

    let invalid_authority: i64 = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM structural_clipboard_bundles bundle \
            LEFT JOIN block_mutations mutation \
              ON mutation.mutation_id = bundle.capture_operation_id \
            LEFT JOIN projects project ON project.id = mutation.project_id \
            WHERE mutation.mutation_id IS NULL \
               OR mutation.mutation_kind <> 'structural_edit' \
               OR mutation.store_epoch <> bundle.store_epoch \
               OR project.library_id <> bundle.library_id) + \
           (SELECT count(*) FROM structural_history_recipes recipe \
            LEFT JOIN block_mutations mutation \
              ON mutation.mutation_id = recipe.recipe_operation_id \
            LEFT JOIN projects project ON project.id = mutation.project_id \
            WHERE mutation.mutation_id IS NULL \
               OR mutation.mutation_kind <> 'structural_edit' \
               OR mutation.store_epoch <> recipe.store_epoch \
               OR project.library_id <> recipe.library_id) + \
           (SELECT count(*) FROM structural_cut_claims claim \
            JOIN structural_clipboard_bundles bundle USING(bundle_id) \
            LEFT JOIN documents document ON document.id = claim.source_document_id \
            WHERE document.id IS NULL OR document.library_id <> bundle.library_id)",
        [],
        |row| row.get(0),
    )?;
    expect_zero(
        invalid_authority,
        "invalid structural edit authority records",
    )?;

    let invalid_roots: i64 = connection.query_row(
        "SELECT count(*) FROM structural_cut_claims claim \
         JOIN structural_clipboard_bundles bundle USING(bundle_id) \
         JOIN json_each(claim.source_root_ids_json) root \
         LEFT JOIN blocks block ON block.id = root.value \
         WHERE root.type <> 'text' OR length(root.value) NOT BETWEEN 1 AND 512 \
            OR block.id IS NULL OR block.library_id <> bundle.library_id",
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid_roots, "invalid structural cut roots")?;

    let file_clause = if has_library_files {
        "OR (member.member_kind = 'file' AND NOT EXISTS ( \
           SELECT 1 FROM library_files file WHERE file.file_id = member.member_id \
             AND file.library_id = member.library_id))"
    } else {
        ""
    };
    let invalid_members: i64 = connection.query_row(
        &format!(
            "SELECT count(*) FROM structural_retention_members member \
         WHERE (member.authority_kind = 'clipboard_bundle' AND NOT EXISTS ( \
                  SELECT 1 FROM structural_clipboard_bundles bundle \
                  WHERE bundle.bundle_id = member.authority_id \
                    AND bundle.library_id = member.library_id)) \
            OR (member.authority_kind = 'history_recipe' AND NOT EXISTS ( \
                  SELECT 1 FROM structural_history_recipes recipe \
                  WHERE recipe.recipe_operation_id = member.authority_id \
                    AND recipe.library_id = member.library_id)) \
            OR (member.member_kind = 'block' AND NOT EXISTS ( \
                  SELECT 1 FROM blocks block WHERE block.id = member.member_id \
                    AND block.library_id = member.library_id)) \
            OR (member.member_kind = 'document' AND NOT EXISTS ( \
                  SELECT 1 FROM documents document WHERE document.id = member.member_id \
                    AND document.library_id = member.library_id)) \
            {file_clause} \
            OR (member.member_kind = 'database' AND NOT EXISTS ( \
                  SELECT 1 FROM blocks block WHERE block.id = member.member_id \
                    AND block.library_id = member.library_id AND block.type = 'database'))"
        ),
        [],
        |row| row.get(0),
    )?;
    expect_zero(invalid_members, "invalid structural retention members")
}

fn validate_document_materialization_derivation(connection: &Connection) -> Result<(), StoreError> {
    let stale: i64 = connection.query_row(
        "SELECT count(*) FROM document_materializations \
         WHERE materialization_derivation_version <> ?1",
        [CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION],
        |row| row.get(0),
    )?;
    expect_zero(stale, "Document materializations from an older derivation")
}

fn validate_canonical_text_timestamp_invariants(connection: &Connection) -> Result<(), StoreError> {
    let columns = connection
        .prepare(
            "SELECT schema.name, column.name \
             FROM sqlite_schema AS schema \
             JOIN pragma_table_info(schema.name) AS column \
             WHERE schema.type = 'table' \
               AND schema.name NOT LIKE 'sqlite_%' \
               AND lower(column.type) = 'text' \
               AND column.name GLOB '*_at' \
             ORDER BY schema.name, column.cid",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (table, column) in columns {
        let query = format!(
            "SELECT {} FROM {} WHERE {} IS NOT NULL",
            quote_identifier(&column),
            quote_identifier(&table),
            quote_identifier(&column),
        );
        let mut statement = connection.prepare(&query)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let value = row.get::<_, String>(0)?;
            if canonical_utc_timestamp(&value).is_some_and(|canonical| canonical == value) {
                continue;
            }
            return Err(corrupt(format!(
                "Store protocol timestamp invariant failed for {table}.{column}"
            )));
        }
    }
    Ok(())
}

fn canonical_utc_timestamp(value: &str) -> Option<String> {
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
        return Some(
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        );
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(value, format) {
            return Some(
                timestamp
                    .and_utc()
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            );
        }
    }
    Some(
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()?
            .and_hms_opt(0, 0, 0)?
            .and_utc()
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn expect_zero(count: i64, label: &str) -> Result<(), StoreError> {
    if count == 0 {
        return Ok(());
    }
    Err(corrupt(format!("Current Store contains {count} {label}")))
}

fn duration_millis(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    #[test]
    fn fresh_store_satisfies_current_invariants() {
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("fresh Store");
        kernel
            .readers()
            .read_default(validate_current_store)
            .expect("current Store invariants");
    }

    #[test]
    fn current_validation_rejects_an_existing_stale_page_projection() {
        const NOW: &str = "2026-08-26T00:00:00.000Z";
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile:p', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                     VALUES ('library:p', 'profile:p', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO blocks(id, library_id, type, created_at, updated_at) \
                     VALUES ('page:p', 'library:p', 'page', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO documents( \
                       id, library_id, generation, head_seq, schema_key, schema_version, \
                       state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine \
                     ) VALUES ('document:p', 'library:p', 1, 0, 'nodex.page', 3, X'', '', \
                       'ready', 'ydoc_primary', ?1, ?1, 'yjs')",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                     VALUES ('page:p', 'document:p', 'library:p', ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO pages( \
                       block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
                     ) VALUES ('page:p', 'library:p', 'document:p', 'library', 'library:p', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO library_block_placements(library_id, block_id, rank_key, created_at, updated_at) \
                     VALUES ('library:p', 'page:p', 'a0', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO document_materializations( \
                       document_id, generation, projected_seq, schema_version, nfm, plain_text, \
                       preview, block_tree_json, updated_at \
                     ) VALUES ('document:p', 1, 0, 3, '', '', '', '[]', ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO page_read_model( \
                       page_block_id, library_id, lifecycle, parent_kind, parent_id, library_rank_key, \
                       placement_revision, metadata_revision, document_id, document_generation, \
                       document_projected_seq, document_schema_version, document_authority, title, \
                       description_preview, description_length, has_description, created_at, updated_at \
                     ) VALUES ('page:p', 'library:p', 'active', 'library', 'library:p', 'a0', \
                       1, 1, 'document:p', 1, 0, 3, 'ydoc_primary', '', '', 0, 0, ?1, ?1)",
                    [NOW],
                )?;
                validate_current_store(connection)?;

                let trigger_sql = connection.query_row(
                    "SELECT sql FROM sqlite_schema \
                     WHERE type = 'trigger' AND name = 'page_read_model_validate_update'",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                connection.execute_batch("DROP TRIGGER page_read_model_validate_update;")?;
                connection.execute(
                    "UPDATE page_read_model SET document_schema_version = ?1 \
                     WHERE page_block_id = 'page:p'",
                    params![2],
                )?;
                connection.execute_batch(&trigger_sql)?;

                let error = validate_current_store(connection)
                    .expect_err("stale existing projection must fail readiness");
                assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
                assert!(error.message.contains("Page read-model source coordinates"));

                connection.execute(
                    "UPDATE page_read_model SET document_schema_version = 3 \
                     WHERE page_block_id = 'page:p'",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO scheduled_page_index( \
                       page_block_id, library_id, lifecycle, recurrence_json, reminders_json, \
                       source_metadata_revision, updated_at \
                     ) VALUES ('page:p', 'library:p', 'active', 'null', '[]', 1, ?1)",
                    [NOW],
                )?;
                validate_current_store(connection)?;

                let schedule_trigger_sql = connection.query_row(
                    "SELECT sql FROM sqlite_schema \
                     WHERE type = 'trigger' AND name = 'scheduled_page_index_require_page_update'",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                connection.execute_batch(
                    "DROP TRIGGER scheduled_page_index_require_page_update;",
                )?;
                connection.execute(
                    "UPDATE scheduled_page_index SET source_metadata_revision = 2 \
                     WHERE page_block_id = 'page:p'",
                    [],
                )?;
                connection.execute_batch(&schedule_trigger_sql)?;
                let error = validate_current_store(connection)
                    .expect_err("stale scheduled Page projection must fail readiness");
                assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
                assert!(error.message.contains("scheduled Page projections"));
                Ok(())
            })
            .expect("projection validation fixture");
    }
}
