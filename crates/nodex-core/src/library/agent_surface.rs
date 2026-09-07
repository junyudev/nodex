//! Authorize and describe semantic content inside the Library read transaction.
use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::{
    AgentAuthorizationTarget, AgentExecutionAuthorization, AgentResourceAuthorizationReason,
};
use nodex_core_contracts::database::DatabaseViewLayout;
use nodex_core_contracts::document::OwnedDocumentAccessContext;
use nodex_core_contracts::library::{
    LibraryAgentAuthorizedSurface as Surface, LibraryAgentSurfaceDescription as Description,
    LibraryAgentSurfaceMetadata as Metadata, LibraryAgentSurfaceRestriction as Restriction,
    LibraryAgentSurfaceTarget as Target, LibraryAgentSurfaceViewTarget as ViewTarget,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::agent_authorization;

struct Reader<'a> {
    connection: &'a Connection,
    library_id: &'a str,
    context: &'a BoundModuleContext,
    authorization: &'a AgentExecutionAuthorization,
}

pub(super) fn describe(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    authorization: &AgentExecutionAuthorization,
    displayed_access_context: OwnedDocumentAccessContext,
    target: Target,
) -> Result<Description, StoreError> {
    if let Err(error) = agent_authorization::validate_metadata_read_authority(
        connection,
        context,
        library_id,
        authorization,
    ) {
        if matches!(
            error.code,
            StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
        ) {
            return Ok(restricted(Restriction::AccessDenied));
        }
        return Err(error);
    }
    if let OwnedDocumentAccessContext::Project { project_id } = &displayed_access_context {
        validate_id(project_id)?;
    }
    let reader = Reader {
        connection,
        library_id,
        context,
        authorization,
    };
    match target {
        Target::Page { page_id } => page(&reader, page_id, displayed_access_context),
        Target::DatabaseView { target } => view(&reader, target, displayed_access_context),
        Target::Canvas { canvas_id } => canvas(&reader, canvas_id, displayed_access_context),
    }
}

fn page(
    reader: &Reader<'_>,
    page_id: String,
    displayed_access_context: OwnedDocumentAccessContext,
) -> Result<Description, StoreError> {
    validate_id(&page_id)?;
    if let Some(reason) = target_restriction(
        reader,
        &AgentAuthorizationTarget::Page {
            page_id: page_id.clone(),
        },
    )? {
        return Ok(restricted(reason));
    }
    let title = reader.connection.query_row(
        "SELECT materialization.title FROM pages page \
         JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
         JOIN document_materializations materialization ON materialization.document_id = page.document_id \
         WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle <> 'deleted'",
        params![page_id, reader.library_id], |row| row.get::<_, String>(0),
    ).optional()?;
    let Some(title) = title else {
        return Ok(restricted(Restriction::Unavailable));
    };
    Ok(Description::Authorized {
        surface: Surface::Page {
            page_id,
            metadata: metadata(reader, title, displayed_access_context),
        },
    })
}

fn view(
    reader: &Reader<'_>,
    target: ViewTarget,
    displayed_access_context: OwnedDocumentAccessContext,
) -> Result<Description, StoreError> {
    let Some(view_id) = resolve_view(reader, target, &displayed_access_context)? else {
        return Ok(restricted(Restriction::Unavailable));
    };
    if let Some(reason) = target_restriction(
        reader,
        &AgentAuthorizationTarget::View {
            view_id: view_id.clone(),
        },
    )? {
        return Ok(restricted(reason));
    }
    let row = reader.connection.query_row(
        "SELECT view.database_block_id, view.data_source_id, view.name, view.layout \
         FROM database_views view \
         JOIN database_containers container ON container.block_id = view.database_block_id \
         JOIN blocks block ON block.id = container.block_id AND block.library_id = container.library_id \
         JOIN data_sources source ON source.id = view.data_source_id AND source.library_id = container.library_id \
         WHERE view.id = ?1 AND container.library_id = ?2 AND view.lifecycle = 'active' \
           AND container.lifecycle <> 'deleted' AND block.lifecycle <> 'deleted' AND source.lifecycle = 'active'",
        params![view_id, reader.library_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).optional()?;
    let Some((database_id, data_source_id, title, layout)) = row else {
        return Ok(restricted(Restriction::Unavailable));
    };
    let layout = match layout.as_str() {
        "board" => DatabaseViewLayout::Board,
        "list" => DatabaseViewLayout::List,
        _ => return Err(corrupt("Database View layout is invalid")),
    };
    Ok(Description::Authorized {
        surface: Surface::DatabaseView {
            database_id,
            data_source_id,
            view_id,
            layout,
            metadata: metadata(reader, title, displayed_access_context),
        },
    })
}

fn resolve_view(
    reader: &Reader<'_>,
    target: ViewTarget,
    displayed_access_context: &OwnedDocumentAccessContext,
) -> Result<Option<String>, StoreError> {
    match target {
        ViewTarget::View { view_id } => {
            validate_id(&view_id)?;
            Ok(Some(view_id))
        }
        ViewTarget::DatabaseDefault { database_id } => {
            validate_id(&database_id)?;
            Ok(reader
                .connection
                .query_row(
                    "SELECT default_view_id FROM database_containers \
                 WHERE block_id = ?1 AND library_id = ?2 AND lifecycle <> 'deleted'",
                    params![database_id, reader.library_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten())
        }
        ViewTarget::ProjectDefault => {
            let OwnedDocumentAccessContext::Project { project_id } = displayed_access_context
            else {
                return Ok(None);
            };
            // The displayed Project resolves the semantic target; it grants no Agent access.
            Ok(reader.connection.query_row(
                "SELECT container.default_view_id FROM projects project \
                 JOIN database_containers container ON container.block_id = project.database_block_id \
                   AND container.library_id = project.library_id \
                 WHERE project.id = ?1 AND project.library_id = ?2 AND project.lifecycle <> 'archived' \
                   AND container.lifecycle <> 'deleted'",
                params![project_id, reader.library_id], |row| row.get::<_, Option<String>>(0),
            ).optional()?.flatten())
        }
    }
}

fn canvas(
    reader: &Reader<'_>,
    canvas_id: String,
    displayed_access_context: OwnedDocumentAccessContext,
) -> Result<Description, StoreError> {
    validate_id(&canvas_id)?;
    let owner = reader
        .connection
        .query_row(
            "SELECT host_page.block_id, containing.document_id \
         FROM canvas_owners canvas \
         JOIN blocks block ON block.id = canvas.block_id AND block.library_id = canvas.library_id \
         LEFT JOIN document_block_index containing ON containing.block_id = canvas.block_id \
         LEFT JOIN block_documents host ON host.document_id = containing.document_id \
         LEFT JOIN pages host_page ON host_page.block_id = host.block_id \
           AND host_page.library_id = canvas.library_id \
         WHERE canvas.block_id = ?1 AND canvas.library_id = ?2 AND block.type = 'canvas' \
           AND block.lifecycle <> 'deleted'",
            params![canvas_id, reader.library_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((page_id, containing_document_id)) = owner else {
        return Ok(restricted(Restriction::Unavailable));
    };
    if containing_document_id.is_some() && page_id.is_none() {
        return Err(corrupt("Document-placed Canvas has no Page owner"));
    }
    let restriction = match page_id {
        Some(page_id) => target_restriction(reader, &AgentAuthorizationTarget::Page { page_id })?,
        None => (!agent_authorization::standalone_canvas_metadata_read_allowed(
            reader.connection,
            reader.context,
            reader.library_id,
            reader.authorization,
            &canvas_id,
        )?)
        .then_some(Restriction::AccessDenied),
    };
    if let Some(reason) = restriction {
        return Ok(restricted(reason));
    }
    let title = reader.connection.query_row(
        "SELECT json_extract(property.value_json, '$') FROM canvas_owners canvas \
         LEFT JOIN block_properties property ON property.block_id = canvas.block_id \
           AND property.library_id = canvas.library_id AND property.property_key = 'document.display_name' \
         WHERE canvas.block_id = ?1 AND canvas.library_id = ?2",
        params![canvas_id, reader.library_id], |row| row.get::<_, Option<String>>(0),
    )?.unwrap_or_else(|| "Canvas".to_owned());
    Ok(Description::Authorized {
        surface: Surface::Canvas {
            canvas_id,
            metadata: metadata(reader, title, displayed_access_context),
        },
    })
}

fn target_restriction(
    reader: &Reader<'_>,
    target: &AgentAuthorizationTarget,
) -> Result<Option<Restriction>, StoreError> {
    let access = agent_authorization::metadata_read_access(
        reader.connection,
        reader.context,
        reader.library_id,
        reader.authorization,
        target,
    )?;
    Ok(match access {
        AgentResourceAuthorizationReason::Allowed => None,
        AgentResourceAuthorizationReason::GrantMissing
        | AgentResourceAuthorizationReason::GrantReadOnly => Some(Restriction::ConsentRequired),
        AgentResourceAuthorizationReason::ResourceNotFound => Some(Restriction::Unavailable),
        _ => Some(Restriction::AccessDenied),
    })
}

fn metadata(
    reader: &Reader<'_>,
    title: String,
    displayed_access_context: OwnedDocumentAccessContext,
) -> Metadata {
    Metadata {
        title,
        library_id: reader.library_id.to_owned(),
        displayed_access_context,
    }
}

fn restricted(reason: Restriction) -> Description {
    Description::Restricted { reason }
}

fn validate_id(id: &str) -> Result<(), StoreError> {
    if !id.is_empty() && id.len() <= 512 && id.trim() == id {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::InvalidInput,
        "Content surface requires a canonical bounded identity",
        false,
    ))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
