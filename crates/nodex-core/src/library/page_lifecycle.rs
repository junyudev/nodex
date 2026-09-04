use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryPageLifecycleAuthority, LibraryPageLifecycleDocument, LibraryPageLifecycleMembership,
    LibraryPageLifecycleParent, LibraryPageLifecyclePosition, LibraryPageLifecyclePreflight,
    LibraryPageWorkflowStatus,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::database;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

struct PageAuthorityRow {
    block_type: String,
    block_lifecycle: String,
    block_metadata_revision: i64,
    placement_revision: i64,
    containing_document_id: Option<String>,
    page_library_id: Option<String>,
    document_id: Option<String>,
    parent_kind: Option<String>,
    parent_id: Option<String>,
    document_generation: Option<i64>,
    document_head_seq: Option<i64>,
    document_readiness: Option<String>,
    document_authority: Option<String>,
    document_schema_key: Option<String>,
    document_schema_version: Option<i64>,
    owned_document_id: Option<String>,
}

pub(super) fn read_preflight(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    page_id: &str,
) -> Result<LibraryPageLifecyclePreflight, StoreError> {
    validate_id(page_id, "page_id")?;
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page lifecycle preflight requires a bound Project"))?;
    let default_database_id =
        database::authorization::project_primary_database(connection, library_id, project_id)?
            .ok_or_else(|| corrupt("Project default Database is unavailable"))?;
    let default_view_id = connection
        .query_row(
            "SELECT default_view_id FROM database_containers WHERE block_id = ?1",
            [&default_database_id],
            |row| row.get::<_, Option<String>>(0),
        )?
        .ok_or_else(|| corrupt("Project default Database has no default View"))?;
    let default_view = database::read::view_descriptor_query(
        connection,
        library_id,
        Some(project_id),
        &default_view_id,
    )?;
    let tags_property = read_tags_property(connection, &default_view)?;
    let Some(row) = read_page_authority(connection, page_id)? else {
        return Ok(LibraryPageLifecyclePreflight {
            default_view,
            tags_property,
            reserved_block_type: None,
            page: None,
        });
    };
    if row.block_type != "page" {
        return Ok(LibraryPageLifecyclePreflight {
            default_view,
            tags_property,
            reserved_block_type: Some(row.block_type),
            page: None,
        });
    }
    super::history::require_page_lifecycle_read_access(
        connection, library_id, project_id, page_id,
    )?;
    let page = project_page_authority(connection, library_id, page_id, row)?;
    Ok(LibraryPageLifecyclePreflight {
        default_view,
        tags_property,
        reserved_block_type: None,
        page: Some(page),
    })
}

fn read_tags_property(connection: &Connection, default_view: &Value) -> Result<Value, StoreError> {
    let data_source_id = default_view
        .pointer("/dataSource/dataSourceId")
        .and_then(Value::as_str)
        .ok_or_else(|| corrupt("Project default Database query has no Data Source identity"))?;
    let properties = default_view
        .get("properties")
        .and_then(Value::as_array)
        .ok_or_else(|| corrupt("Project default Database query has no Property schema"))?;
    let property = properties
        .iter()
        .find(|property| {
            property.get("property_id").and_then(Value::as_str) == Some("tags")
                && property.get("data_source_id").and_then(Value::as_str) == Some(data_source_id)
                && property.pointer("/schema/kind").and_then(Value::as_str) == Some("multi_select")
                && property.get("lifecycle").and_then(Value::as_str) == Some("active")
        })
        .ok_or_else(|| corrupt("Project default Data Source has no active tags Property"))?;
    let revision = property
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| corrupt("Project default tags Property has no revision"))?;
    let config_json = connection
        .query_row(
            "SELECT config_json FROM data_source_properties \
             WHERE data_source_id = ?1 AND id = 'tags' AND value_type = 'multi_select' \
               AND lifecycle = 'active'",
            [data_source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Project default Data Source has no active tags Property"))?;
    let config = database::property_semantics::option_config_from_storage(
        "tags",
        "multi_select",
        &config_json,
    )?;
    let config = serde_json::to_value(config)
        .map_err(|_| corrupt("Project default tags Property config cannot encode"))?;
    Ok(json!({
        "propertyId": "tags",
        "dataSourceId": data_source_id,
        "valueType": "multi_select",
        "lifecycle": "active",
        "revision": revision,
        "config": config,
    }))
}

fn read_page_authority(
    connection: &Connection,
    page_id: &str,
) -> Result<Option<PageAuthorityRow>, StoreError> {
    connection
        .query_row(
            "SELECT block.type, block.lifecycle, block.metadata_revision, \
               block.placement_revision, containing.document_id, page.library_id, \
               page.document_id, page.parent_kind, page.parent_id, document.generation, \
               document.head_seq, document.readiness, document.authority, document.schema_key, \
               document.schema_version, ownership.document_id \
             FROM blocks block LEFT JOIN pages page ON page.block_id = block.id \
             LEFT JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             LEFT JOIN block_documents ownership ON ownership.block_id = block.id \
               AND ownership.library_id = block.library_id \
             LEFT JOIN document_block_index containing ON containing.block_id = block.id \
             WHERE block.id = ?1 LIMIT 1",
            [page_id],
            |row| {
                Ok(PageAuthorityRow {
                    block_type: row.get(0)?,
                    block_lifecycle: row.get(1)?,
                    block_metadata_revision: row.get(2)?,
                    placement_revision: row.get(3)?,
                    containing_document_id: row.get(4)?,
                    page_library_id: row.get(5)?,
                    document_id: row.get(6)?,
                    parent_kind: row.get(7)?,
                    parent_id: row.get(8)?,
                    document_generation: row.get(9)?,
                    document_head_seq: row.get(10)?,
                    document_readiness: row.get(11)?,
                    document_authority: row.get(12)?,
                    document_schema_key: row.get(13)?,
                    document_schema_version: row.get(14)?,
                    owned_document_id: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn project_page_authority(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    row: PageAuthorityRow,
) -> Result<LibraryPageLifecycleAuthority, StoreError> {
    let page_library_id = required(row.page_library_id.clone(), "Page has no Library authority")?;
    let document_id = required(row.document_id.clone(), "Page has no Document identity")?;
    let parent_kind = required(row.parent_kind.clone(), "Page has no parent kind")?;
    let parent_id = required(row.parent_id.clone(), "Page has no parent identity")?;
    let page_lifecycle = row.block_lifecycle.clone();
    let page_metadata_revision = row.block_metadata_revision;
    let parent_revision = row.placement_revision;
    if page_library_id != library_id {
        return Err(corrupt("Page escaped its Library authority"));
    }
    if !matches!(page_lifecycle.as_str(), "active" | "archived" | "deleted") {
        return Err(corrupt("Page lifecycle is invalid"));
    }
    if row.owned_document_id.as_deref() != Some(document_id.as_str()) {
        return Err(corrupt("Page has no exact owned Document"));
    }
    let parent = match parent_kind.as_str() {
        "library" if parent_id == library_id => LibraryPageLifecycleParent::Library {
            library_id: library_id.to_owned(),
        },
        "page" => LibraryPageLifecycleParent::Page {
            page_id: parent_id.clone(),
        },
        "data_source" => LibraryPageLifecycleParent::DataSource {
            data_source_id: parent_id.clone(),
        },
        _ => return Err(corrupt("Page parent authority is invalid")),
    };
    validate_parent_placement(&row, &parent, connection, library_id)?;
    let library_rank_key = connection
        .query_row(
            "SELECT rank_key FROM library_block_placements \
             WHERE library_id = ?1 AND block_id = ?2",
            params![library_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if matches!(parent, LibraryPageLifecycleParent::Library { .. })
        && page_lifecycle != "deleted"
        && library_rank_key.is_none()
    {
        return Err(corrupt("Library Page has no canonical placement"));
    }
    let membership = read_membership(connection, page_id)?;
    match (&parent, &membership, page_lifecycle.as_str()) {
        (LibraryPageLifecycleParent::DataSource { .. }, None, "active" | "archived") => {
            return Err(corrupt("Data Source Page has no active membership"));
        }
        (
            LibraryPageLifecycleParent::Library { .. } | LibraryPageLifecycleParent::Page { .. },
            Some(_),
            _,
        ) => return Err(corrupt("Standalone Page retains a Data Source membership")),
        _ => {}
    }
    let document = LibraryPageLifecycleDocument {
        document_id,
        generation: positive(
            required(row.document_generation, "Page Document has no generation")?,
            "Page Document generation",
        )?,
        head_seq: non_negative(
            required(row.document_head_seq, "Page Document has no head")?,
            "Page Document head",
        )?,
        readiness: required(row.document_readiness, "Page Document has no readiness")?,
        authority: required(row.document_authority, "Page Document has no authority")?,
        schema_key: required(row.document_schema_key, "Page Document has no schema")?,
        schema_version: positive(
            required(
                row.document_schema_version,
                "Page Document has no schema version",
            )?,
            "Page Document schema version",
        )?,
    };
    if document.readiness != "ready" || document.authority != "ydoc_primary" {
        return Err(corrupt("Page Document is not current Yjs authority"));
    }
    let restore_coordinates = super::page_lifecycle_mutation::PageTombstoneCoordinates {
        page_id,
        metadata_revision: page_metadata_revision,
        parent_revision,
        document_id: &document.document_id,
        document_generation: document.generation,
        document_head_seq: document.head_seq,
    };
    let restore_evidence = super::page_lifecycle_mutation::read_restore_evidence(
        connection,
        &page_lifecycle,
        &restore_coordinates,
    )?;
    Ok(LibraryPageLifecycleAuthority {
        page_id: page_id.to_owned(),
        lifecycle: page_lifecycle,
        parent,
        library_rank_key,
        metadata_revision: positive(page_metadata_revision, "Page metadata revision")?,
        parent_revision: positive(parent_revision, "Page parent revision")?,
        document,
        membership,
        restore_evidence,
    })
}

fn validate_parent_placement(
    row: &PageAuthorityRow,
    parent: &LibraryPageLifecycleParent,
    connection: &Connection,
    library_id: &str,
) -> Result<(), StoreError> {
    match parent {
        LibraryPageLifecycleParent::Library { .. } if row.containing_document_id.is_none() => {
            Ok(())
        }
        LibraryPageLifecycleParent::Page { page_id } => {
            let parent_document = connection
                .query_row(
                    "SELECT document_id FROM pages WHERE block_id = ?1 AND library_id = ?2",
                    params![page_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if parent_document == row.containing_document_id {
                return Ok(());
            }
            Err(corrupt("Nested Page location and parent Document diverge"))
        }
        LibraryPageLifecycleParent::DataSource { .. } if row.containing_document_id.is_none() => {
            Ok(())
        }
        _ => Err(corrupt("Page parent and Block location diverge")),
    }
}

fn read_membership(
    connection: &Connection,
    page_id: &str,
) -> Result<Option<LibraryPageLifecycleMembership>, StoreError> {
    let rows = connection
        .prepare(&format!(
            "SELECT membership.id, membership.data_source_id, membership.revision, \
               source.home_database_block_id, view.id, view.revision, property.id, \
               value.revision, value.value_json, {rank}, {revision} \
             FROM data_source_page_memberships membership \
             JOIN data_sources source ON source.id = membership.data_source_id \
             JOIN database_containers container \
               ON container.block_id = source.home_database_block_id \
             JOIN database_views view ON view.database_block_id = container.block_id \
               AND view.data_source_id = source.id AND view.lifecycle = 'active' \
             JOIN data_source_properties property ON property.data_source_id = source.id \
               AND property.id = 'status' AND property.lifecycle = 'active' \
               AND property.value_type = 'select' \
             JOIN data_source_property_values value ON value.membership_id = membership.id \
               AND value.data_source_id = source.id AND value.property_id = property.id \
             {joins} \
             WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL \
             ORDER BY CASE WHEN view.id = container.default_view_id THEN 0 ELSE 1 END, \
               view.rank_key, view.id",
            rank = crate::database::POSITION_RANK,
            revision = crate::database::POSITION_REVISION,
            joins = crate::database::view_position_joins("view.id", "membership.page_block_id")
        ))?
        .query_map([page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let Some(row) = rows.first() else {
        let active = connection.query_row(
            "SELECT count(*) FROM data_source_page_memberships \
             WHERE page_block_id = ?1 AND removed_at IS NULL",
            [page_id],
            |row| row.get::<_, i64>(0),
        )?;
        if active == 0 {
            return Ok(None);
        }
        return Err(corrupt(
            "Page membership has no active View/status coordinate",
        ));
    };
    let membership_id = &row.0;
    if rows.iter().any(|candidate| candidate.0 != *membership_id) {
        return Err(corrupt("Page has multiple active Data Source memberships"));
    }
    let status_value: Value = serde_json::from_str(&row.8)
        .map_err(|_| corrupt("Page membership status JSON is invalid"))?;
    let status = workflow_status(&status_value)?;
    let position = match (&row.9, row.10) {
        (Some(rank_key), Some(revision)) => Some(LibraryPageLifecyclePosition {
            rank_key: rank_key.clone(),
            revision: positive(revision, "View position revision")?,
        }),
        (None, None) => None,
        _ => return Err(corrupt("Page has an incomplete View position")),
    };
    Ok(Some(LibraryPageLifecycleMembership {
        membership_id: row.0.clone(),
        database_id: row.3.clone(),
        data_source_id: row.1.clone(),
        membership_revision: positive(row.2, "Page membership revision")?,
        view_id: row.4.clone(),
        view_revision: positive(row.5, "Database View revision")?,
        status_property_id: row.6.clone(),
        status_value_revision: positive(row.7, "Page status value revision")?,
        status,
        position,
    }))
}

fn workflow_status(value: &Value) -> Result<LibraryPageWorkflowStatus, StoreError> {
    match value.as_str() {
        Some("triage") => Ok(LibraryPageWorkflowStatus::Triage),
        Some("plan") => Ok(LibraryPageWorkflowStatus::Plan),
        Some("build") => Ok(LibraryPageWorkflowStatus::Build),
        Some("review") => Ok(LibraryPageWorkflowStatus::Review),
        Some("ship") => Ok(LibraryPageWorkflowStatus::Ship),
        _ => Err(corrupt("Page membership status is invalid")),
    }
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value == value.trim() && value.len() <= 512 {
        return Ok(());
    }
    Err(invalid(&format!("{label} must be a canonical identity")))
}

fn required<T>(value: Option<T>, message: &str) -> Result<T, StoreError> {
    value.ok_or_else(|| corrupt(message))
}

fn positive(value: i64, label: &str) -> Result<i64, StoreError> {
    if value >= 1 {
        return Ok(value);
    }
    Err(corrupt(&format!("{label} is invalid")))
}

fn non_negative(value: i64, label: &str) -> Result<i64, StoreError> {
    if value >= 0 {
        return Ok(value);
    }
    Err(corrupt(&format!("{label} is invalid")))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
