use std::path::Path;

use nodex_core_contracts::database::{
    DatabaseGroupScope, DatabaseIdentityTarget, DatabaseRead, DatabaseReadValue,
};
use nodex_core_contracts::library::{
    LIBRARY_CONTRACT_VERSION, LibraryAgentSiblingAnchor, LibraryIntent,
    LibraryPageWriteDestination, LibraryRead, LibraryReadValue,
};
use nodex_core_contracts::workspace::ProjectWorkspaceProject;
use nodex_core_contracts::{CoreErrorCode, ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;

use crate::cli::{
    BoundaryPlacement, DataSourcePlacementArgs, MutationArgs, PageCreateArgs, PageDeleteArgs,
    PageDestinationArgs, PageDuplicateArgs, PageMoveArgs,
};
use crate::error::{CliError, CliErrorCode};
use crate::page_mutation::{
    MAX_BODY_INPUT_BYTES, read_content_input, validate_return_fields, validate_title,
};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, resolve_page_selector, selected_project,
    unwrap_database, unwrap_library,
};

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageCreationResult<'a> {
    operation_id: &'a str,
    duplicate: bool,
    page_id: &'a str,
    page_key: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a nodex_core_contracts::library::LibraryPageWorkflowStatusValue>,
    document_id: &'a str,
    generation: i64,
    head_seq: i64,
    commit_seq: i64,
    affected: CreatedBlocks<'a>,
    etags: PageBodyEtags<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'a nodex_core_contracts::library::LibraryCommitValue>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct CreatedBlocks<'a> {
    created_block_ids: &'a [String],
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct PageBodyEtags<'a> {
    title: &'a str,
    body: &'a str,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageCopyResult<'a> {
    operation_id: &'a str,
    duplicate: bool,
    source_page_id: &'a str,
    page_id: &'a str,
    page_key: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a nodex_core_contracts::library::LibraryPageWorkflowStatusValue>,
    document_id: &'a str,
    generation: i64,
    head_seq: i64,
    commit_seq: i64,
    affected: CopiedBlocks<'a>,
    etags: PageBodyEtags<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'a nodex_core_contracts::library::LibraryCommitValue>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct CopiedBlocks<'a> {
    page_ids: &'a [String],
    block_ids: &'a std::collections::BTreeMap<String, String>,
    document_ids: &'a std::collections::BTreeMap<String, String>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageMoveResult<'a> {
    operation_id: &'a str,
    duplicate: bool,
    page_id: &'a str,
    page_key: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a nodex_core_contracts::library::LibraryPageWorkflowStatusValue>,
    commit_seq: i64,
    affected: MovedBlocks<'a>,
    etags: PageMoveEtags<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'a nodex_core_contracts::library::LibraryCommitValue>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageBatchMoveReceipt {
    operation_id: String,
    duplicate: bool,
    commit_seq: i64,
    pages: Vec<nodex_core_contracts::library::LibraryAgentMovedPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<nodex_core_contracts::library::LibraryCommitValue>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
#[serde(untagged)]
#[allow(dead_code)]
pub(crate) enum PageMoveOutput<'a> {
    Single(PageMoveResult<'a>),
    Batch(Box<PageBatchMoveReceipt>),
}

#[derive(serde::Serialize, utoipa::ToSchema)]
struct MovedBlocks<'a> {
    page_ids: &'a [String],
    database_ids: &'a [String],
    document_ids: Vec<&'a String>,
    location: Option<&'a nodex_core_contracts::library::LibraryBlockLocation>,
    view_placement: Option<&'a nodex_core_contracts::library::LibraryPageViewPlacementResult>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct PageMoveEtags<'a> {
    page: &'a str,
    r#move: &'a str,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageDeletionResult<'a> {
    operation_id: &'a str,
    duplicate: bool,
    page_id: &'a str,
    lifecycle: &'a nodex_core_contracts::library::LibraryPageLifecycleState,
    metadata_revision: i64,
    parent_revision: i64,
    commit_seq: i64,
    affected: DeletedPages<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'a nodex_core_contracts::library::LibraryCommitValue>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct DeletedPages<'a> {
    page_ids: &'a [String],
    database_ids: &'a [String],
}

pub(crate) fn create_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageCreateArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let title_markdown = validate_title(arguments.title)?;
    let markdown = if arguments.content.empty {
        String::new()
    } else {
        read_content_input(
            arguments.content.file.as_deref(),
            MAX_BODY_INPUT_BYTES,
            "Page body",
        )?
    };
    let project = selected_project(client, explicit_project, cwd)?;
    let values = arguments.values.values()?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(&project.id),
        "page create",
        arguments.mutation.idempotency_key.as_deref(),
        (
            &title_markdown,
            &markdown,
            &arguments.parent,
            &arguments.data_source.view,
            &arguments.data_source.group,
            arguments.data_source.unassigned,
            &values,
        ),
        Some(nodex_core_contracts::ModuleName::Library),
    )?;
    let committed = match admitted.replay {
        Some(replay) => serde_json::from_value(replay.result).map_err(internal)?,
        None => {
            let destination = resolve_page_destination(
                client,
                &project,
                &arguments.parent,
                None,
                &arguments.data_source,
            )?;
            apply_library_intent(
                client,
                &project.id,
                admitted.operation_id,
                LibraryIntent::CreatePageFromText {
                    title_markdown,
                    markdown,
                    destination,
                    values,
                },
            )?
        }
    };
    let created = committed.outcome().page_create.as_ref().ok_or_else(|| {
        CliError::new(
            CliErrorCode::Internal,
            "Core semantic Page creation omitted its exact result",
        )
    })?;
    let mut result = serde_json::to_value(PageCreationResult {
        operation_id: &committed.receipt().mutation.operation_id,
        duplicate: committed.receipt().mutation.duplicate,
        page_id: &created.page_id,
        page_key: &created.page_key,
        status: created.status.as_ref(),
        document_id: &created.document_id,
        generation: created.document_generation,
        head_seq: created.document_head_seq,
        commit_seq: committed.commit_cursor(),
        affected: CreatedBlocks {
            created_block_ids: &created.block_ids,
        },
        etags: PageBodyEtags {
            title: &created.title_etag,
            body: &created.body_etag,
        },
        commit: None,
    })
    .map_err(internal)?;
    if arguments
        .mutation
        .r#return
        .iter()
        .any(|field| field == "commit")
    {
        result.as_object_mut().expect("result object").insert(
            "commit".to_owned(),
            serde_json::to_value(committed.outcome()).map_err(internal)?,
        );
    }
    Ok(CommandOutput::Json(result))
}

pub(crate) fn move_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageMoveArgs,
) -> Result<CommandOutput, CliError> {
    if let [page] = arguments.pages.as_slice() {
        return transfer_page(
            client,
            explicit_project,
            cwd,
            PageTransferRequest {
                page: page.clone(),
                destination: arguments.destination,
                mutation: arguments.mutation,
                expected_etag: arguments.if_match,
                duplicate: false,
            },
        );
    }
    if arguments.if_match.is_some() {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "--if-match fences one Page move",
        ));
    }
    validate_return_fields(&arguments.mutation.r#return)?;
    let project = selected_project(client, explicit_project, cwd)?;
    let anchor = placement_anchor(&arguments.destination)?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(&project.id),
        "page move",
        arguments.mutation.idempotency_key.as_deref(),
        (
            &arguments.pages,
            &arguments.destination.to,
            &anchor,
            &arguments.destination.data_source.view,
            &arguments.destination.data_source.group,
            arguments.destination.data_source.unassigned,
        ),
        Some(nodex_core_contracts::ModuleName::Library),
    )?;
    let committed = match admitted.replay {
        Some(replay) => serde_json::from_value(replay.result).map_err(internal)?,
        None => {
            let page_ids = arguments
                .pages
                .iter()
                .map(|page| resolve_page_selector(client, &project.id, page))
                .collect::<Result<Vec<_>, _>>()?;
            let destination = resolve_page_destination(
                client,
                &project,
                &arguments.destination.to,
                anchor,
                &arguments.destination.data_source,
            )?;
            apply_library_intent(
                client,
                &project.id,
                admitted.operation_id,
                LibraryIntent::MovePages {
                    page_ids,
                    destination,
                },
            )?
        }
    };
    let result = committed
        .outcome()
        .agent_move_pages
        .as_ref()
        .ok_or_else(|| internal("Core omitted the Page move batch result"))?;
    serde_json::to_value(PageBatchMoveReceipt {
        operation_id: committed.receipt().mutation.operation_id.clone(),
        duplicate: committed.receipt().mutation.duplicate,
        commit_seq: committed.commit_cursor(),
        pages: result.pages.clone(),
        commit: arguments
            .mutation
            .r#return
            .iter()
            .any(|field| field == "commit")
            .then(|| committed.outcome().clone()),
    })
    .map(CommandOutput::Json)
    .map_err(internal)
}

pub(crate) fn duplicate_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageDuplicateArgs,
) -> Result<CommandOutput, CliError> {
    transfer_page(
        client,
        explicit_project,
        cwd,
        PageTransferRequest {
            page: arguments.page,
            destination: arguments.destination,
            mutation: arguments.mutation,
            expected_etag: None,
            duplicate: true,
        },
    )
}

struct PageTransferRequest {
    page: String,
    destination: PageDestinationArgs,
    mutation: MutationArgs,
    expected_etag: Option<String>,
    duplicate: bool,
}

fn transfer_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    request: PageTransferRequest,
) -> Result<CommandOutput, CliError> {
    let PageTransferRequest {
        page,
        destination: destination_arguments,
        mutation,
        expected_etag,
        duplicate,
    } = request;
    validate_return_fields(&mutation.r#return)?;
    let project = selected_project(client, explicit_project, cwd)?;
    let anchor = placement_anchor(&destination_arguments)?;
    let command = if duplicate {
        "page duplicate"
    } else {
        "page move"
    };
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(&project.id),
        command,
        mutation.idempotency_key.as_deref(),
        (
            &page,
            &destination_arguments.to,
            &anchor,
            &destination_arguments.data_source.view,
            &destination_arguments.data_source.group,
            destination_arguments.data_source.unassigned,
            &expected_etag,
        ),
        Some(nodex_core_contracts::ModuleName::Library),
    )?;
    let committed = match admitted.replay {
        Some(replay) => serde_json::from_value(replay.result).map_err(internal)?,
        None => {
            let page_id = resolve_page_selector(client, &project.id, &page)?;
            let destination = resolve_page_destination(
                client,
                &project,
                &destination_arguments.to,
                anchor,
                &destination_arguments.data_source,
            )?;
            let intent = if duplicate {
                LibraryIntent::DuplicatePage {
                    source_page_id: page_id,
                    destination,
                }
            } else {
                LibraryIntent::MovePage {
                    page_id,
                    destination,
                    expected_etag,
                }
            };
            apply_library_intent(client, &project.id, admitted.operation_id, intent)?
        }
    };
    let mut result = if duplicate {
        let copied = committed.outcome().page_copy.as_ref().ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page duplication omitted its exact result",
            )
        })?;
        serde_json::to_value(PageCopyResult {
            operation_id: &committed.receipt().mutation.operation_id,
            duplicate: committed.receipt().mutation.duplicate,
            source_page_id: &copied.source_page_id,
            page_id: &copied.page_id,
            page_key: &copied.page_key,
            status: copied.status.as_ref(),
            document_id: &copied.document_id,
            generation: copied.document_generation,
            head_seq: copied.document_head_seq,
            commit_seq: committed.commit_cursor(),
            affected: CopiedBlocks {
                page_ids: &committed.receipt().affected_page_ids,
                block_ids: &copied.block_ids,
                document_ids: &copied.document_ids,
            },
            etags: PageBodyEtags {
                title: &copied.title_etag,
                body: &copied.body_etag,
            },
            commit: None,
        })
        .map_err(internal)?
    } else {
        let moved = committed.outcome().block_transfer.as_ref().ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its exact result",
            )
        })?;
        let page_id = moved
            .result_root_block_ids
            .first()
            .ok_or_else(|| internal("Core semantic Page movement omitted its Page identity"))?;
        let page_etag = moved.page_etags.get(page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its Page shell ETag",
            )
        })?;
        let move_etag = moved.move_etags.get(page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its fresh move ETag",
            )
        })?;
        let page_key = moved.page_keys.get(page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its current Page key",
            )
        })?;
        serde_json::to_value(PageMoveResult {
            operation_id: &committed.receipt().mutation.operation_id,
            duplicate: committed.receipt().mutation.duplicate,
            page_id,
            page_key,
            status: moved.page_statuses.get(page_id),
            commit_seq: committed.commit_cursor(),
            affected: MovedBlocks {
                page_ids: &committed.receipt().affected_page_ids,
                database_ids: &committed.receipt().affected_database_ids,
                document_ids: moved
                    .document_commits
                    .iter()
                    .map(|commit| &commit.document_id)
                    .collect(),
                location: moved.final_locations.get(page_id),
                view_placement: moved.page_view_placements.get(page_id),
            },
            etags: PageMoveEtags {
                page: page_etag,
                r#move: move_etag,
            },
            commit: None,
        })
        .map_err(internal)?
    };
    maybe_include_commit(&mut result, &mutation.r#return, committed.outcome())?;
    Ok(CommandOutput::Json(result))
}

pub(crate) fn delete_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageDeleteArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let project = selected_project(client, explicit_project, cwd)?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(&project.id),
        "page delete",
        arguments.mutation.idempotency_key.as_deref(),
        (&arguments.page, &arguments.if_match),
        Some(nodex_core_contracts::ModuleName::Library),
    )?;
    let committed = match admitted.replay {
        Some(replay) => serde_json::from_value(replay.result).map_err(internal)?,
        None => {
            let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
            apply_library_intent(
                client,
                &project.id,
                admitted.operation_id,
                LibraryIntent::DeletePage {
                    page_id,
                    expected_etag: arguments.if_match,
                },
            )?
        }
    };
    let lifecycle = committed.outcome().page_lifecycle.as_ref().ok_or_else(|| {
        CliError::new(
            CliErrorCode::Internal,
            "Core semantic Page deletion omitted its lifecycle receipt",
        )
    })?;
    let mut result = serde_json::to_value(PageDeletionResult {
        operation_id: &committed.receipt().mutation.operation_id,
        duplicate: committed.receipt().mutation.duplicate,
        page_id: &lifecycle.page_id,
        lifecycle: &lifecycle.lifecycle,
        metadata_revision: lifecycle.metadata_revision,
        parent_revision: lifecycle.parent_revision,
        commit_seq: committed.commit_cursor(),
        affected: DeletedPages {
            page_ids: &committed.receipt().affected_page_ids,
            database_ids: &committed.receipt().affected_database_ids,
        },
        commit: None,
    })
    .map_err(internal)?;
    maybe_include_commit(
        &mut result,
        &arguments.mutation.r#return,
        committed.outcome(),
    )?;
    Ok(CommandOutput::Json(result))
}

fn placement_anchor(
    arguments: &PageDestinationArgs,
) -> Result<Option<LibraryAgentSiblingAnchor>, CliError> {
    if let Some(at) = arguments.at {
        return Ok(Some(match at {
            BoundaryPlacement::Start => LibraryAgentSiblingAnchor::Start,
            BoundaryPlacement::End => LibraryAgentSiblingAnchor::End,
        }));
    }
    if let Some(block_id) = arguments.before.as_deref() {
        return Ok(Some(LibraryAgentSiblingAnchor::Before {
            block_id: stable_id(block_id, "--before")?,
        }));
    }
    arguments
        .after
        .as_deref()
        .map(|block_id| {
            stable_id(block_id, "--after")
                .map(|block_id| LibraryAgentSiblingAnchor::After { block_id })
        })
        .transpose()
}

fn apply_library_intent(
    client: &CoreClient,
    project_id: &str,
    operation_id: String,
    intent: LibraryIntent,
) -> Result<
    nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::library::LibraryCommitValue,
        nodex_core_contracts::library::LibraryReceipt,
    >,
    CliError,
> {
    let response = client
        .library_apply(
            Some(project_id),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent,
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => Ok(committed),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

pub(crate) fn resolve_page_destination(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
    at: Option<LibraryAgentSiblingAnchor>,
    placement: &DataSourcePlacementArgs,
) -> Result<LibraryPageWriteDestination, CliError> {
    if let Some(id) = selector.strip_prefix("data_source:@") {
        let id = stable_id(id, "Data Source owner")?;
        let source = exact_data_source(client, &project.id, &id)?
            .ok_or_else(|| invalid_destination(format!("No active Data Source has ID {id:?}")))?;
        return data_source_destination(source, placement, at);
    }
    if let Some(id) = selector.strip_prefix("page:@") {
        let id = stable_id(id, "Page owner")?;
        if !require_destination_page(client, &project.id, &id)? {
            return Err(invalid_destination(format!("No active Page has ID {id:?}")));
        }
        return DestinationId::Page(id).into_destination(placement, at);
    }
    let explicit_id = selector.strip_prefix('@');
    let id = explicit_id.unwrap_or(selector);
    if (explicit_id.is_none() && selector == "library") || id == client.handshake.library_id {
        reject_data_source_placement(placement)?;
        return Ok(LibraryPageWriteDestination::Library { at });
    }
    if (explicit_id.is_none() && selector == "database") || id == project.database_id {
        return data_source_destination(primary_data_source(client, project)?, placement, at);
    }
    let exact = exact_destination(client, project, id)?;
    if explicit_id.is_some() {
        return exact
            .ok_or_else(|| invalid_destination(format!("No destination has ID {id:?}")))?
            .into_destination(placement, at);
    }
    let prefixed = if let Some(page) = selector.strip_prefix("page:") {
        Some(
            resolve_page_selector(client, &project.id, page).and_then(|id| {
                require_destination_page(client, &project.id, &id)?
                    .then_some(DestinationId::Page(id))
                    .ok_or_else(|| invalid_destination(format!("No active Page matches {page:?}")))
            }),
        )
    } else {
        selector.strip_prefix("data_source:").map(|source| {
            let id = stable_id(source, "Data Source owner")?;
            exact_data_source(client, &project.id, &id)?
                .map(DestinationId::DataSource)
                .ok_or_else(|| invalid_destination(format!("No active Data Source has ID {id:?}")))
        })
    };
    match (exact, prefixed) {
        (Some(exact), Some(Ok(prefixed))) if exact != prefixed => {
            Err(invalid_destination(format!(
                "Destination {selector:?} is ambiguous. Use {} or {} to select the exact ID.",
                exact.explicit_selector(),
                prefixed.explicit_selector()
            )))
        }
        (Some(exact), _) => exact.into_destination(placement, at),
        (None, Some(prefixed)) => prefixed?.into_destination(placement, at),
        (None, None) => DestinationId::Page(resolve_page_selector(client, &project.id, selector)?)
            .into_destination(placement, at),
    }
}

#[derive(PartialEq)]
enum DestinationId {
    Page(String),
    DataSource(String),
}

impl DestinationId {
    fn explicit_selector(&self) -> String {
        match self {
            Self::Page(id) => format!("page:@{id}"),
            Self::DataSource(id) => format!("data_source:@{id}"),
        }
    }

    fn into_destination(
        self,
        placement: &DataSourcePlacementArgs,
        at: Option<LibraryAgentSiblingAnchor>,
    ) -> Result<LibraryPageWriteDestination, CliError> {
        match self {
            Self::Page(page_id) => {
                reject_data_source_placement(placement)?;
                Ok(LibraryPageWriteDestination::Page { page_id, at })
            }
            Self::DataSource(data_source_id) => {
                data_source_destination(data_source_id, placement, at)
            }
        }
    }
}

fn data_source_destination(
    data_source_id: String,
    placement: &DataSourcePlacementArgs,
    at: Option<LibraryAgentSiblingAnchor>,
) -> Result<LibraryPageWriteDestination, CliError> {
    Ok(LibraryPageWriteDestination::DataSource {
        data_source_id,
        view_id: placement
            .view
            .as_deref()
            .map(|view| stable_id(view, "--view"))
            .transpose()?,
        group: group_scope(placement)?,
        at,
    })
}

fn require_destination_page(
    client: &CoreClient,
    project_id: &str,
    id: &str,
) -> Result<bool, CliError> {
    let page = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageLifecyclePreflight {
            page_id: id.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageLifecyclePreflight { value } = page.value else {
        return Err(internal("Core returned the wrong Page owner preflight"));
    };
    Ok(value.page.is_some_and(|page| page.lifecycle == "active"))
}

fn exact_data_source(
    client: &CoreClient,
    project_id: &str,
    id: &str,
) -> Result<Option<String>, CliError> {
    let source = client
        .database_read(
            Some(project_id),
            DatabaseRead::DataSource {
                data_source_id: id.to_owned(),
            },
        )
        .map_err(map_client_error)?;
    match source.0 {
        ResponseEnvelope::Ok(snapshot) => {
            let DatabaseReadValue::DataSource { value } = snapshot.value else {
                return Err(internal(
                    "Core returned the wrong Data Source owner snapshot",
                ));
            };
            Ok(Some(value.data_source.data_source_id))
        }
        ResponseEnvelope::Error(error) if error.code == CoreErrorCode::NotFound => Ok(None),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn exact_destination(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    id: &str,
) -> Result<Option<DestinationId>, CliError> {
    if id.contains('/') {
        return Ok(None);
    }
    if require_destination_page(client, &project.id, id)? {
        return Ok(Some(DestinationId::Page(id.to_owned())));
    }
    let database = client
        .database_read(
            Some(&project.id),
            DatabaseRead::Database {
                target: DatabaseIdentityTarget::Database {
                    database_id: id.to_owned(),
                },
            },
        )
        .map_err(map_client_error)?;
    match database.0 {
        ResponseEnvelope::Ok(snapshot) => {
            let DatabaseReadValue::Database { .. } = snapshot.value else {
                return Err(internal("Core returned the wrong Database owner snapshot"));
            };
            Ok(Some(DestinationId::DataSource(active_data_source_id(
                client,
                &project.id,
                id,
            )?)))
        }
        ResponseEnvelope::Error(error) if error.code == CoreErrorCode::NotFound => {
            Ok(exact_data_source(client, &project.id, id)?.map(DestinationId::DataSource))
        }
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn invalid_destination(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}

fn group_scope(
    placement: &DataSourcePlacementArgs,
) -> Result<Option<DatabaseGroupScope>, CliError> {
    if placement.unassigned {
        return Ok(Some(DatabaseGroupScope::Path {
            group_key: None,
            subgroup_key: None,
        }));
    }
    placement
        .group
        .as_deref()
        .map(|key| {
            stable_id(key, "--group").map(|key| DatabaseGroupScope::Path {
                group_key: Some(key),
                subgroup_key: None,
            })
        })
        .transpose()
}

fn reject_data_source_placement(placement: &DataSourcePlacementArgs) -> Result<(), CliError> {
    if placement.view.is_none() && placement.group.is_none() && !placement.unassigned {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "--view, --group, and --unassigned require a Data Source destination",
    ))
}

fn primary_data_source(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
) -> Result<String, CliError> {
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::Database {
            target: DatabaseIdentityTarget::Database {
                database_id: project.database_id.clone(),
            },
        },
    ))?;
    let DatabaseReadValue::Database { .. } = snapshot.value else {
        return Err(internal(
            "Core returned the wrong primary Database snapshot",
        ));
    };
    active_data_source_id(client, &project.id, &project.database_id)
}

fn active_data_source_id(
    client: &CoreClient,
    project_id: &str,
    database_id: &str,
) -> Result<String, CliError> {
    let snapshot = unwrap_database(client.database_read(
        Some(project_id),
        DatabaseRead::DataSourceWindow {
            database_id: database_id.to_owned(),
            window: Default::default(),
        },
    ))?;
    let DatabaseReadValue::DataSourceWindow { data_sources } = snapshot.value else {
        return Err(internal(
            "Core returned the wrong Data Source selector window",
        ));
    };
    crate::data_source::select_default_source(
        database_id,
        data_sources
            .items
            .into_iter()
            .filter(|source| source.lifecycle == "active")
            .map(|source| (source.data_source_id, source.name))
            .collect(),
        data_sources.next_cursor.is_some(),
    )
}

fn stable_id(value: &str, label: &str) -> Result<String, CliError> {
    let value = value.strip_prefix('@').unwrap_or(value);
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} must contain one bounded stable identity"),
        ));
    }
    Ok(value.to_owned())
}

fn maybe_include_commit(
    result: &mut serde_json::Value,
    fields: &[String],
    commit: &nodex_core_contracts::library::LibraryCommitValue,
) -> Result<(), CliError> {
    if !fields.iter().any(|field| field == "commit") {
        return Ok(());
    }
    result.as_object_mut().expect("result object").insert(
        "commit".to_owned(),
        serde_json::to_value(commit).map_err(internal)?,
    );
    Ok(())
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(
        view: Option<&str>,
        group: Option<&str>,
        unassigned: bool,
    ) -> DataSourcePlacementArgs {
        DataSourcePlacementArgs {
            view: view.map(str::to_owned),
            group: group.map(str::to_owned),
            unassigned,
        }
    }

    #[test]
    fn data_source_placement_uses_stable_keys_and_rejects_other_parents() {
        assert_eq!(
            group_scope(&placement(Some("@view-1"), Some("doing"), false)).expect("stable group"),
            Some(DatabaseGroupScope::Path {
                group_key: Some("doing".to_owned()),
                subgroup_key: None,
            })
        );
        assert_eq!(
            group_scope(&placement(Some("@view-1"), None, true)).expect("unassigned"),
            Some(DatabaseGroupScope::Path {
                group_key: None,
                subgroup_key: None,
            })
        );
        assert!(reject_data_source_placement(&placement(None, None, false)).is_ok());
        let error = reject_data_source_placement(&placement(Some("@view-1"), None, false))
            .expect_err("View placement cannot target a Page or Library");
        assert_eq!(error.code, CliErrorCode::InvalidInput);
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageAcceptanceResult {
    page_id: String,
    operation_id: String,
    duplicate: bool,
}

/// Acceptance acts for a Member, a person or their Agent; Core guards the review predecessor.
pub(crate) fn accept_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: crate::cli::PageAcceptArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
    let response = client
        .workspace_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version:
                    nodex_core_contracts::workspace::PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: crate::retry_key::admit(
                    client,
                    Some(&project.id),
                    "page accept",
                    arguments.idempotency_key.as_deref(),
                    &page_id,
                )?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: nodex_core_contracts::workspace::ProjectWorkspaceIntent::AcceptPageWork {
                    expected_turn_episode: None,
                    page_id: page_id.clone(),
                },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(value) => value,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    };
    serde_json::to_value(PageAcceptanceResult {
        page_id,
        operation_id: committed.receipt().mutation.operation_id.clone(),
        duplicate: committed.receipt().mutation.duplicate,
    })
    .map(CommandOutput::Json)
    .map_err(|e| CliError::new(CliErrorCode::Internal, e.to_string()))
}
