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
    CommandOutput, map_client_error, map_core_error, operation_id, resolve_page_selector,
    selected_project, unwrap_database, unwrap_library,
};

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageCreationResult<'a> {
    operation_id: &'a str,
    duplicate: bool,
    page_id: &'a str,
    page_key: &'a Option<String>,
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
    commit_seq: i64,
    affected: MovedBlocks<'a>,
    etags: PageMoveEtags<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'a nodex_core_contracts::library::LibraryCommitValue>,
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
    let nfm = if arguments.content.empty {
        String::new()
    } else {
        read_content_input(
            arguments.content.file.as_deref(),
            MAX_BODY_INPUT_BYTES,
            "Page body",
        )?
    };
    let project = selected_project(client, explicit_project, cwd)?;
    let destination = resolve_page_destination(
        client,
        &project,
        &arguments.parent,
        None,
        &arguments.data_source,
    )?;
    let operation_id = operation_id(arguments.mutation.idempotency_key.as_deref())?;
    let response = client
        .library_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreatePageFromNfm {
                    title_markdown,
                    nfm,
                    destination,
                },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(committed) => committed,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
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
    transfer_page(
        client,
        explicit_project,
        cwd,
        PageTransferRequest {
            page: arguments.page,
            destination: arguments.destination,
            mutation: arguments.mutation,
            expected_etag: Some(arguments.if_match),
            duplicate: false,
        },
    )
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
    let page_id = resolve_page_selector(client, &project.id, &page)?;
    let anchor = placement_anchor(&destination_arguments)?;
    let destination = resolve_page_destination(
        client,
        &project,
        &destination_arguments.to,
        anchor,
        &destination_arguments.data_source,
    )?;
    let operation_id = operation_id(mutation.idempotency_key.as_deref())?;
    let intent = if duplicate {
        LibraryIntent::DuplicatePage {
            source_page_id: page_id.clone(),
            destination,
        }
    } else {
        LibraryIntent::MovePage {
            page_id: page_id.clone(),
            destination,
            expected_etag: expected_etag
                .ok_or_else(|| internal("Page move command omitted its required move ETag"))?,
        }
    };
    let response = client
        .library_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent,
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(committed) => committed,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
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
        let page_etag = moved.page_etags.get(&page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its Page shell ETag",
            )
        })?;
        let move_etag = moved.move_etags.get(&page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its fresh move ETag",
            )
        })?;
        let page_key = moved.page_keys.get(&page_id).ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core semantic Page movement omitted its current Page key",
            )
        })?;
        serde_json::to_value(PageMoveResult {
            operation_id: &committed.receipt().mutation.operation_id,
            duplicate: committed.receipt().mutation.duplicate,
            page_id: &page_id,
            page_key,
            commit_seq: committed.commit_cursor(),
            affected: MovedBlocks {
                page_ids: &committed.receipt().affected_page_ids,
                database_ids: &committed.receipt().affected_database_ids,
                document_ids: moved
                    .document_commits
                    .iter()
                    .map(|commit| &commit.document_id)
                    .collect(),
                location: moved.final_locations.get(&page_id),
                view_placement: moved.page_view_placements.get(&page_id),
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
    let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
    let operation_id = operation_id(arguments.mutation.idempotency_key.as_deref())?;
    let response = client
        .library_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::DeletePage {
                    page_id: page_id.clone(),
                    expected_etag: arguments.if_match,
                },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(committed) => committed,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
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
        page_id: &page_id,
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

fn resolve_page_destination(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
    at: Option<LibraryAgentSiblingAnchor>,
    placement: &DataSourcePlacementArgs,
) -> Result<LibraryPageWriteDestination, CliError> {
    let unprefixed = selector.strip_prefix('@').unwrap_or(selector);
    if selector == "library" || unprefixed == client.handshake.library_id {
        reject_data_source_placement(placement)?;
        return Ok(LibraryPageWriteDestination::Library { at });
    }
    if selector == "database" || unprefixed == project.database_id {
        return Ok(LibraryPageWriteDestination::DataSource {
            data_source_id: primary_data_source(client, project)?,
            view_id: placement
                .view
                .as_deref()
                .map(|view| stable_id(view, "--view"))
                .transpose()?,
            group: group_scope(placement)?,
            at,
        });
    }
    if let Some(data_source_id) = selector.strip_prefix("data_source:") {
        return Ok(LibraryPageWriteDestination::DataSource {
            data_source_id: stable_id(data_source_id, "Data Source owner")?,
            view_id: placement
                .view
                .as_deref()
                .map(|view| stable_id(view, "--view"))
                .transpose()?,
            group: group_scope(placement)?,
            at,
        });
    }
    if selector.starts_with('@') {
        let page = unwrap_library(client.library_read(
            Some(&project.id),
            LibraryRead::PageLifecyclePreflight {
                page_id: unprefixed.to_owned(),
            },
        ))?;
        let LibraryReadValue::PageLifecyclePreflight { value } = page.value else {
            return Err(internal("Core returned the wrong Page owner preflight"));
        };
        if value.page.is_some_and(|page| page.lifecycle == "active") {
            reject_data_source_placement(placement)?;
            return Ok(LibraryPageWriteDestination::Page {
                page_id: unprefixed.to_owned(),
                at,
            });
        }
        let database = client
            .database_read(
                Some(&project.id),
                DatabaseRead::Database {
                    target: DatabaseIdentityTarget::Database {
                        database_id: unprefixed.to_owned(),
                    },
                },
            )
            .map_err(map_client_error)?;
        match database.0 {
            ResponseEnvelope::Ok(snapshot) => {
                let DatabaseReadValue::Database { .. } = snapshot.value else {
                    return Err(internal("Core returned the wrong Database owner snapshot"));
                };
                return Ok(LibraryPageWriteDestination::DataSource {
                    data_source_id: active_data_source_id(client, &project.id, unprefixed)?,
                    view_id: placement
                        .view
                        .as_deref()
                        .map(|view| stable_id(view, "--view"))
                        .transpose()?,
                    group: group_scope(placement)?,
                    at,
                });
            }
            ResponseEnvelope::Error(error) if error.code == CoreErrorCode::NotFound => {}
            ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
        }
        let source = unwrap_database(client.database_read(
            Some(&project.id),
            DatabaseRead::DataSource {
                data_source_id: unprefixed.to_owned(),
            },
        ))?;
        let DatabaseReadValue::DataSource { value } = source.value else {
            return Err(internal(
                "Core returned the wrong Data Source owner snapshot",
            ));
        };
        return Ok(LibraryPageWriteDestination::DataSource {
            data_source_id: value.data_source.data_source_id,
            view_id: placement
                .view
                .as_deref()
                .map(|view| stable_id(view, "--view"))
                .transpose()?,
            group: group_scope(placement)?,
            at,
        });
    }
    reject_data_source_placement(placement)?;
    Ok(LibraryPageWriteDestination::Page {
        page_id: resolve_page_selector(client, &project.id, selector)?,
        at,
    })
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
    data_sources
        .items
        .iter()
        .find(|source| source.lifecycle == "active")
        .map(|source| source.data_source_id.clone())
        .ok_or_else(|| {
            CliError::new(
                CliErrorCode::ScopeNotFound,
                "the selected Database has no active Data Source",
            )
        })
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
            group_scope(&placement(Some("@view-1"), Some("build"), false)).expect("stable group"),
            Some(DatabaseGroupScope::Path {
                group_key: Some("build".to_owned()),
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
