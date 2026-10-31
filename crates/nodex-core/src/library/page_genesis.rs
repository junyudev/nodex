use nodex_core_contracts::events::PageDocumentHeadImpact;
use nodex_core_contracts::library::LibraryPageCreateResult;
use rusqlite::Connection;

use crate::database::{
    PageCopyDataSourceDestination, StagedPagePlacementRevisions, current_page_key_for_page,
    place_staged_page_in_data_source,
};
use crate::document::{mint_document_semantic_etags, parse_inline_markdown_title};
use crate::infrastructure::local_commit::CommitContext;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_ID_BYTES: usize = 512;
const MAX_PAGE_TITLE_BYTES: usize = 10_000;

pub(crate) struct PageGenesisInput<'a> {
    pub(crate) context: &'a nodex_core_contracts::BoundModuleContext,
    pub(crate) commit_context: &'a CommitContext,
    pub(crate) library_id: &'a str,
    pub(crate) actor_project_id: Option<&'a str>,
    pub(crate) operation_id: &'a str,
    pub(crate) store_epoch: &'a str,
    pub(crate) page_id: &'a str,
    pub(crate) document_id: &'a str,
    pub(crate) title_markdown: &'a str,
    pub(crate) markdown: &'a str,
    pub(crate) now: &'a str,
}

pub(crate) struct CreatedPageGenesis {
    pub(crate) page_create: LibraryPageCreateResult,
    pub(crate) data_source_id: String,
    pub(crate) affected_view_ids: Vec<String>,
    pub(crate) document_head: PageDocumentHeadImpact,
}

pub(crate) struct CreatedLibraryPageGenesis {
    pub(crate) page_create: LibraryPageCreateResult,
    pub(crate) document_head: PageDocumentHeadImpact,
}

pub(crate) fn create_page_in_data_source(
    connection: &Connection,
    input: PageGenesisInput<'_>,
    destination: &PageCopyDataSourceDestination,
) -> Result<CreatedPageGenesis, StoreError> {
    let created = create_page_in_library(
        connection,
        &input,
        super::mutation::LibraryRootPosition::Last,
    )?;
    let placement = place_staged_page_in_data_source(
        connection,
        input.library_id,
        input.actor_project_id,
        input.page_id,
        destination,
        StagedPagePlacementRevisions {
            location_revision: 1,
            metadata_revision: 1,
            parent_revision: 1,
        },
        input.now,
    )?;
    let mut page_create = created.page_create;
    page_create.page_key = current_page_key_for_page(connection, input.library_id, input.page_id)?;
    Ok(CreatedPageGenesis {
        page_create,
        data_source_id: placement.data_source_id,
        affected_view_ids: placement.affected_view_ids,
        document_head: created.document_head,
    })
}

/// New root content enters ahead of every existing Library root.
pub(crate) fn create_page_at_library_start(
    connection: &Connection,
    input: PageGenesisInput<'_>,
) -> Result<CreatedLibraryPageGenesis, StoreError> {
    create_page_in_library(
        connection,
        &input,
        super::mutation::LibraryRootPosition::First,
    )
}

fn create_page_in_library(
    connection: &Connection,
    input: &PageGenesisInput<'_>,
    position: super::mutation::LibraryRootPosition<'_>,
) -> Result<CreatedLibraryPageGenesis, StoreError> {
    validate_id(input.page_id, "page_id")?;
    validate_id(input.document_id, "document_id")?;
    if input.title_markdown.len() > MAX_PAGE_TITLE_BYTES {
        return Err(invalid("Page title exceeds its bound"));
    }
    let rich_title = parse_inline_markdown_title(input.title_markdown)
        .map_err(|error| invalid(error.to_string()))?;
    let staged = super::block_transfer::stage_fresh_page_in_library(
        connection,
        input.context,
        input.commit_context,
        input.library_id,
        input.actor_project_id,
        input.operation_id,
        input.store_epoch,
        input.page_id,
        input.document_id,
        "page_body_block",
        &rich_title,
        input.markdown,
        position,
        input.now,
    )?;
    let (title_etag, body_etag) = mint_document_semantic_etags(
        connection,
        input.actor_project_id,
        input.store_epoch,
        input.document_id,
        &staged.materialization,
    )
    .map_err(|error| internal(error.to_string()))?;
    let page_create = LibraryPageCreateResult {
        page_id: input.page_id.to_owned(),
        page_key: current_page_key_for_page(connection, input.library_id, input.page_id)?,
        document_id: staged.document_id.clone(),
        document_generation: 1,
        document_head_seq: staged.document_head_seq,
        block_ids: staged.body_block_ids,
        title_etag,
        body_etag,
    };
    Ok(CreatedLibraryPageGenesis {
        page_create,
        document_head: PageDocumentHeadImpact {
            page_id: input.page_id.to_owned(),
            document_id: staged.document_id,
            generation: 1,
            head_seq: staged.document_head_seq,
        },
    })
}

fn validate_id(value: &str, field: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.trim() != value {
        return Err(invalid(format!(
            "{field} must be one bounded stable identity"
        )));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
