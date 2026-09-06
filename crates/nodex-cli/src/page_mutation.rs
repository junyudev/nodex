use std::fs::File;
use std::io::{self, IsTerminal, Read};
use std::path::Path;

use nodex_core_contracts::document::{
    DocumentBlockUpdatePatch, DocumentCommitOutcome, DocumentSemanticAnchor,
    DocumentSemanticBlockDraft, DocumentSemanticCommand, OwnedDocumentContract,
    OwnedDocumentIntent,
};
use nodex_core_contracts::library::{
    LibraryPageProjectionFile, LibraryPageProjectionFileKind, LibraryRead, LibraryReadValue,
};
use nodex_core_contracts::{
    CoreErrorCode, ModuleApplyRequest, StoreEpoch, VersionedModuleContract,
};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::cli::{
    BlockDeleteArgs, BlockInsertArgs, BlockMoveArgs, BlockUpdateArgs, PageInsertArgs,
    PageRenameArgs, PageReplaceArgs, PatchArgs,
};
use crate::error::{CliError, CliErrorCode};
use crate::patch::PatchDocument;
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, resolve_page_selector,
    selected_project, unwrap_library,
};

pub(crate) const MAX_BODY_INPUT_BYTES: usize = nodex_core_protocol::MAX_DOCUMENT_JSON_STRING_BYTES;
pub(crate) const MAX_BLOCK_JSON_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_TITLE_INPUT_BYTES: usize = 64 * 1024;
const MAX_HEAD_REBASE_ATTEMPTS: usize = 3;

pub(crate) fn patch_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PatchArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.r#return)?;
    let input = read_content_input(
        arguments.file.as_deref(),
        crate::patch::MAX_PATCH_BYTES,
        "patch",
    )?;
    let patch = crate::patch::parse(input.as_bytes())?;
    let page_selector = patch.page_id.clone();
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &page_selector,
        arguments.idempotency_key.as_deref(),
        SemanticWrite::Patch(patch),
        &arguments.r#return,
    )
}

pub(crate) fn replace_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageReplaceArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let body = read_content_input(arguments.file.as_deref(), MAX_BODY_INPUT_BYTES, "Page body")?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::Replace {
            body,
            expected_etag: arguments.if_match,
        },
        &arguments.mutation.r#return,
    )
}

pub(crate) fn insert_page_content(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageInsertArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let fragment = validate_nfm_fragment(read_content_input(
        arguments.file.as_deref(),
        MAX_BODY_INPUT_BYTES,
        "Page insertion",
    )?)?;
    let anchor = parse_anchor(&arguments.at)?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::Insert { fragment, anchor },
        &arguments.mutation.r#return,
    )
}

fn validate_nfm_fragment(fragment: String) -> Result<String, CliError> {
    if fragment.trim().is_empty() {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Page insertion must contain at least one Nested Markdown Block; use <empty-block/> to insert an intentional empty Block",
        ));
    }
    Ok(fragment)
}

pub(crate) fn set_page_title(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: PageRenameArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let title = match (arguments.title, arguments.file.as_deref()) {
        (Some(value), None) => validate_title(value)?,
        (None, Some(path)) => validate_title(read_content_input(
            Some(path),
            MAX_TITLE_INPUT_BYTES,
            "Page title",
        )?)?,
        _ => {
            return Err(CliError::new(
                CliErrorCode::InvalidInput,
                "Page title requires exactly one title or --file input",
            ));
        }
    };
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::Title {
            title,
            expected_etag: arguments.if_match,
        },
        &arguments.mutation.r#return,
    )
}

/// Decode semantic payloads once, before starting or connecting to Core.
pub(crate) fn prepare_block_input(command: &mut crate::cli::Command) -> Result<(), CliError> {
    use crate::cli::{BlockArgs, BlockCommand, Command};
    match command {
        Command::Block(BlockArgs {
            command: BlockCommand::Insert(args),
        }) => {
            validate_return_fields(&args.mutation.r#return)?;
            parse_anchor(&args.at)?;
            args.prepared = Some(read_json_file(&args.block_json, "Block draft")?);
        }
        Command::Block(BlockArgs {
            command: BlockCommand::Update(args),
        }) => {
            validate_return_fields(&args.mutation.r#return)?;
            args.prepared = Some(read_json_file(&args.patch_json, "Block update patch")?);
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn insert_block(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: BlockInsertArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let anchor = parse_anchor(&arguments.at)?;
    let block = arguments
        .prepared
        .ok_or_else(|| internal("Block input was not prepared"))?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::BlockInsert { anchor, block },
        &arguments.mutation.r#return,
    )
}

pub(crate) fn update_block(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: BlockUpdateArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let block_id = validate_block_id(arguments.block)?;
    let patch = arguments
        .prepared
        .ok_or_else(|| internal("Block input was not prepared"))?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::BlockUpdate {
            block_id,
            expected_etag: arguments.if_match,
            patch,
        },
        &arguments.mutation.r#return,
    )
}

pub(crate) fn move_block(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: BlockMoveArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let block_id = validate_block_id(arguments.block)?;
    let anchor = parse_anchor(&arguments.at)?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::BlockMove { block_id, anchor },
        &arguments.mutation.r#return,
    )
}

pub(crate) fn delete_block(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: BlockDeleteArgs,
) -> Result<CommandOutput, CliError> {
    validate_return_fields(&arguments.mutation.r#return)?;
    let block_id = validate_block_id(arguments.block)?;
    apply_selected_semantic_write(
        client,
        explicit_project,
        cwd,
        &arguments.page,
        arguments.mutation.idempotency_key.as_deref(),
        SemanticWrite::BlockDelete {
            block_id,
            expected_etag: arguments.if_match,
        },
        &arguments.mutation.r#return,
    )
}

enum SemanticWrite {
    Patch(PatchDocument),
    Insert {
        fragment: String,
        anchor: DocumentSemanticAnchor,
    },
    Replace {
        body: String,
        expected_etag: String,
    },
    Title {
        title: String,
        expected_etag: String,
    },
    BlockInsert {
        anchor: DocumentSemanticAnchor,
        block: DocumentSemanticBlockDraft,
    },
    BlockUpdate {
        block_id: String,
        expected_etag: String,
        patch: DocumentBlockUpdatePatch,
    },
    BlockMove {
        block_id: String,
        anchor: DocumentSemanticAnchor,
    },
    BlockDelete {
        block_id: String,
        expected_etag: String,
    },
}

impl SemanticWrite {
    fn file_kind(&self) -> LibraryPageProjectionFileKind {
        match self {
            Self::Title { .. } => LibraryPageProjectionFileKind::MetaYaml,
            Self::Patch(_)
            | Self::Insert { .. }
            | Self::Replace { .. }
            | Self::BlockInsert { .. }
            | Self::BlockUpdate { .. }
            | Self::BlockMove { .. }
            | Self::BlockDelete { .. } => LibraryPageProjectionFileKind::BodyNestedMarkdown,
        }
    }

    fn commands(&self) -> Vec<DocumentSemanticCommand> {
        match self {
            Self::Patch(patch) => patch
                .hunks
                .iter()
                .map(|hunk| DocumentSemanticCommand::PatchBody {
                    old_fragment: hunk.old_fragment.clone(),
                    new_fragment: hunk.new_fragment.clone(),
                    expected_matches: None,
                })
                .collect(),
            Self::Insert { fragment, anchor } => vec![DocumentSemanticCommand::InsertBody {
                anchor: anchor.clone(),
                nested_markdown: fragment.clone(),
            }],
            Self::Replace {
                body,
                expected_etag,
            } => vec![DocumentSemanticCommand::ReplaceBody {
                nested_markdown: body.clone(),
                expected_etag: expected_etag.clone(),
            }],
            Self::Title {
                title,
                expected_etag,
            } => vec![DocumentSemanticCommand::SetTitle {
                inline_markdown: title.clone(),
                expected_etag: expected_etag.clone(),
            }],
            Self::BlockInsert { anchor, block } => vec![DocumentSemanticCommand::InsertBlock {
                anchor: anchor.clone(),
                block: block.clone(),
            }],
            Self::BlockUpdate {
                block_id,
                expected_etag,
                patch,
            } => vec![DocumentSemanticCommand::UpdateBlock {
                block_id: block_id.clone(),
                expected_etag: expected_etag.clone(),
                patch: patch.clone(),
            }],
            Self::BlockMove { block_id, anchor } => vec![DocumentSemanticCommand::MoveBlock {
                block_id: block_id.clone(),
                anchor: anchor.clone(),
            }],
            Self::BlockDelete {
                block_id,
                expected_etag,
            } => vec![DocumentSemanticCommand::DeleteBlock {
                block_id: block_id.clone(),
                expected_etag: expected_etag.clone(),
            }],
        }
    }

    fn preflight(&self, snapshot: &LibraryPageProjectionFile) -> Result<(), CliError> {
        let Self::Patch(patch) = self else {
            return Ok(());
        };
        crate::patch::preflight(patch, &snapshot.content)
    }

    fn enrich_core_error(&self, mut error: CliError) -> CliError {
        let Self::Patch(patch) = self else {
            return error;
        };
        if !matches!(
            error.code,
            CliErrorCode::PatchNotFound | CliErrorCode::PatchAmbiguous | CliErrorCode::PatchOverlap
        ) {
            return error;
        }
        let indices = error
            .message
            .split(|character: char| !character.is_ascii_digit())
            .filter(|value| !value.is_empty())
            .filter_map(|value| value.parse::<usize>().ok())
            .collect::<Vec<_>>();
        let operation_index = if error.code == CliErrorCode::PatchOverlap {
            indices.last().copied()
        } else {
            indices.first().copied()
        };
        let Some(hunk) = operation_index.and_then(|index| patch.hunks.get(index)) else {
            return error;
        };
        error.line = Some(hunk.input_line);
        error.hunk = Some(hunk.index);
        error
    }
}

fn parse_anchor(value: &str) -> Result<DocumentSemanticAnchor, CliError> {
    match value {
        "start" => {
            return Ok(DocumentSemanticAnchor::Start {
                parent_block_id: None,
            });
        }
        "end" => {
            return Ok(DocumentSemanticAnchor::End {
                parent_block_id: None,
            });
        }
        _ => {}
    }
    let (kind, block_id) = value.split_once(':').ok_or_else(|| invalid_anchor(value))?;
    if block_id.is_empty()
        || block_id.len() > 512
        || block_id.trim() != block_id
        || block_id.contains(['/', '\\'])
    {
        return Err(invalid_anchor(value));
    }
    match kind {
        "before" => Ok(DocumentSemanticAnchor::Before {
            block_id: block_id.to_owned(),
        }),
        "after" => Ok(DocumentSemanticAnchor::After {
            block_id: block_id.to_owned(),
        }),
        "inside-start" => Ok(DocumentSemanticAnchor::Start {
            parent_block_id: Some(block_id.to_owned()),
        }),
        "inside-end" => Ok(DocumentSemanticAnchor::End {
            parent_block_id: Some(block_id.to_owned()),
        }),
        _ => Err(invalid_anchor(value)),
    }
}

fn invalid_anchor(value: &str) -> CliError {
    CliError::new(
        CliErrorCode::InvalidInput,
        format!(
            "unsupported anchor '{value}'; use start, end, before:<block-id>, after:<block-id>, inside-start:<block-id>, or inside-end:<block-id>"
        ),
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_selected_semantic_write(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    page_selector: &str,
    idempotency_key: Option<&str>,
    write: SemanticWrite,
    return_fields: &[String],
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, page_selector)?;
    let operation_id = operation_id(idempotency_key)?;
    apply_semantic_write(
        client,
        &project.id,
        page_id,
        operation_id,
        write,
        return_fields,
    )
}

fn validate_block_id(value: String) -> Result<String, CliError> {
    if !value.is_empty()
        && value.len() <= 512
        && value.trim() == value
        && !value.contains(['/', '\\'])
    {
        return Ok(value);
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "Block identity must be a non-empty stable ID of at most 512 bytes",
    ))
}

fn apply_semantic_write(
    client: &CoreClient,
    project_id: &str,
    page_id: String,
    operation_id: String,
    write: SemanticWrite,
    return_fields: &[String],
) -> Result<CommandOutput, CliError> {
    for attempt in 0..MAX_HEAD_REBASE_ATTEMPTS {
        let snapshot = read_page_file(client, project_id, &page_id, write.file_kind())?;
        write.preflight(&snapshot)?;
        let response = client
            .document_apply(
                Some(project_id),
                false,
                ModuleApplyRequest {
                    contract_version: OwnedDocumentContract::VERSION,
                    operation_id: operation_id.clone(),
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: OwnedDocumentIntent::ApplySemanticMutation {
                        document_id: snapshot.document_id,
                        generation: snapshot.document_generation,
                        expected_head_seq: snapshot.document_head_seq,
                        commands: write.commands(),
                    },
                },
            )
            .map_err(map_client_error)?;
        match response.0 {
            ResponseEnvelope::Ok(committed) => {
                return mutation_output(&page_id, committed, return_fields);
            }
            ResponseEnvelope::Error(error)
                if error.code == CoreErrorCode::HeadConflict
                    && attempt + 1 < MAX_HEAD_REBASE_ATTEMPTS =>
            {
                continue;
            }
            ResponseEnvelope::Error(error) => {
                return Err(write.enrich_core_error(map_core_error(error)));
            }
        }
    }
    unreachable!("bounded semantic write loop returns on its final attempt")
}

fn read_page_file(
    client: &CoreClient,
    project_id: &str,
    page_id: &str,
    file_kind: LibraryPageProjectionFileKind,
) -> Result<LibraryPageProjectionFile, CliError> {
    let snapshot = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageProjectionFile {
            page_id: page_id.to_owned(),
            file_kind,
            prepare: None,
        },
    ))?;
    let LibraryReadValue::PageProjectionFile { value } = snapshot.value else {
        return Err(CliError::new(
            CliErrorCode::Internal,
            "Core returned the wrong Page file snapshot",
        ));
    };
    Ok(*value)
}

fn mutation_output(
    page_id: &str,
    committed: nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::document::OwnedDocumentCommitValue,
        nodex_core_contracts::document::OwnedDocumentReceipt,
    >,
    return_fields: &[String],
) -> Result<CommandOutput, CliError> {
    Ok(CommandOutput::Json(semantic_mutation_result(
        page_id,
        &committed,
        return_fields,
    )?))
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SemanticMutationResult<'a> {
    pub operation_id: String,
    pub duplicate: bool,
    pub page_id: String,
    pub document_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub commit_seq: i64,
    pub outcome: DocumentCommitOutcome,
    pub affected: SemanticAffected,
    pub etags: SemanticEtags,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<&'a nodex_core_contracts::document::OwnedDocumentCommitValue>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SemanticAffected {
    pub created_block_ids: Vec<String>,
    pub updated_block_ids: Vec<String>,
    pub moved_block_ids: Vec<String>,
    pub deleted_block_ids: Vec<String>,
    pub title_changed: bool,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SemanticEtags {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<
        std::collections::BTreeMap<
            String,
            nodex_core_contracts::document::DocumentSemanticBlockEtags,
        >,
    >,
}

pub(crate) fn semantic_mutation_result(
    page_id: &str,
    committed: &nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::document::OwnedDocumentCommitValue,
        nodex_core_contracts::document::OwnedDocumentReceipt,
    >,
    return_fields: &[String],
) -> Result<Value, CliError> {
    let outcome = committed.outcome();
    let receipt = committed.receipt();
    let effect = outcome.mutation_effect.as_ref();
    let etags = outcome
        .semantic_etags
        .as_ref()
        .ok_or_else(|| internal("Core native CLI semantic receipt omitted post-commit ETags"))?;
    serde_json::to_value(SemanticMutationResult {
        operation_id: receipt.mutation.operation_id.clone(),
        duplicate: receipt.mutation.duplicate,
        page_id: page_id.to_owned(),
        document_id: outcome.document_id.clone(),
        generation: outcome.generation,
        head_seq: outcome.head_seq,
        commit_seq: committed.commit_cursor(),
        outcome: outcome.outcome,
        affected: SemanticAffected {
            created_block_ids: effect
                .map(|v| v.created_block_ids.clone())
                .unwrap_or_default(),
            updated_block_ids: effect
                .map(|v| v.updated_block_ids.clone())
                .unwrap_or_default(),
            moved_block_ids: effect
                .map(|v| v.moved_block_ids.clone())
                .unwrap_or_default(),
            deleted_block_ids: effect
                .map(|v| v.deleted_block_ids.clone())
                .unwrap_or_default(),
            title_changed: effect.is_some_and(|v| v.title_changed),
        },
        etags: SemanticEtags {
            title: etags.title.clone(),
            body: etags.body.clone(),
            blocks: outcome.semantic_block_etags.clone(),
        },
        commit: return_fields
            .iter()
            .any(|field| field == "commit")
            .then_some(outcome),
    })
    .map_err(internal)
}

pub(crate) fn validate_return_fields(fields: &[String]) -> Result<(), CliError> {
    let invalid = fields
        .iter()
        .filter(|field| field.as_str() != "commit")
        .collect::<Vec<_>>();
    if invalid.is_empty() {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        format!(
            "unsupported --return field(s): {}; supported field: commit",
            invalid
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

pub(crate) fn read_content_input(
    path: Option<&Path>,
    limit: usize,
    label: &str,
) -> Result<String, CliError> {
    let bytes = if let Some(path) = path.filter(|path| path.as_os_str() != "-") {
        let mut file = File::open(path).map_err(|error| input_error(path, error))?;
        read_bounded(&mut file, limit, label)
            .map_err(|error| error.at_path(path.display().to_string()))?
    } else {
        let stdin = io::stdin();
        if stdin.is_terminal() {
            return Err(CliError::new(
                CliErrorCode::InvalidInput,
                format!("{label} input requires --file or redirected stdin"),
            ));
        }
        read_bounded(&mut stdin.lock(), limit, label)?
    };
    let value = String::from_utf8(bytes).map_err(|_| {
        CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} input must be valid UTF-8"),
        )
    })?;
    if value.contains('\r') {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} input must use LF line endings"),
        ));
    }
    Ok(value)
}

fn read_json_file<T: DeserializeOwned>(path: &Path, label: &str) -> Result<T, CliError> {
    let bytes = crate::input::read_bytes(path, MAX_BLOCK_JSON_BYTES, label)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} must match the native semantic JSON contract: {error}"),
        )
        .at_path(path.display().to_string())
        .at_line(error.line())
    })
}

fn read_bounded(reader: &mut impl Read, limit: usize, label: &str) -> Result<Vec<u8>, CliError> {
    let take_limit = u64::try_from(limit)
        .map_err(internal)?
        .checked_add(1)
        .ok_or_else(|| internal("input limit overflow"))?;
    let mut bytes = Vec::new();
    reader
        .take(take_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| CliError::new(CliErrorCode::InvalidInput, error.to_string()))?;
    if bytes.len() <= limit {
        return Ok(bytes);
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        format!("{label} input exceeds the {limit}-byte limit"),
    ))
}

pub(crate) fn validate_title(mut value: String) -> Result<String, CliError> {
    if value.ends_with('\n') {
        value.pop();
    }
    if value.is_empty() || value.len() > MAX_TITLE_INPUT_BYTES || value.contains(['\n', '\r', '\t'])
    {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Page title must be one non-empty inline-Markdown line of at most 65536 bytes",
        ));
    }
    Ok(value)
}

fn input_error(path: &Path, error: impl std::fmt::Display) -> CliError {
    CliError::new(
        CliErrorCode::InvalidInput,
        format!("could not read {}: {error}", path.display()),
    )
    .at_path(path.display().to_string())
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_input_refuses_oversized_content_without_reading_unbounded_bytes() {
        let mut input = &b"12345"[..];
        let error = read_bounded(&mut input, 4, "body").expect_err("oversized input");
        assert_eq!(error.code, CliErrorCode::InvalidInput);
        assert!(error.message.contains("4-byte"));
    }

    #[test]
    fn title_file_may_have_one_final_lf_but_no_multiline_content() {
        assert_eq!(validate_title("Title\n".to_owned()).unwrap(), "Title");
        assert!(validate_title("First\nSecond\n".to_owned()).is_err());
        assert!(validate_title(String::new()).is_err());
    }

    #[test]
    fn return_fields_are_closed_and_explicit() {
        assert!(validate_return_fields(&[]).is_ok());
        assert!(validate_return_fields(&["commit".to_owned()]).is_ok());
        assert!(validate_return_fields(&["body".to_owned()]).is_err());
    }

    #[test]
    fn concurrent_core_patch_errors_map_back_to_the_input_hunk() {
        let patch = crate::patch::parse(
            b"*** Begin Patch\n*** Update Page: @page\n@@\n-one\n+ONE\n@@\n-two\n+TWO\n*** End Patch\n",
        )
        .unwrap();
        let write = SemanticWrite::Patch(patch);
        let error = write.enrich_core_error(CliError::new(
            CliErrorCode::PatchOverlap,
            "document operation NfmPatchOverlap: NFM patches 0 and 1 overlap",
        ));
        assert_eq!(error.hunk, Some(2));
        assert_eq!(error.line, Some(7));
    }

    #[test]
    fn semantic_anchors_cover_only_the_documented_stable_forms() {
        assert_eq!(
            parse_anchor("start").unwrap(),
            DocumentSemanticAnchor::Start {
                parent_block_id: None
            }
        );
        assert_eq!(
            parse_anchor("inside-end:block-1").unwrap(),
            DocumentSemanticAnchor::End {
                parent_block_id: Some("block-1".to_owned())
            }
        );
        assert!(parse_anchor("line:12").is_err());
        assert!(parse_anchor("before:").is_err());
    }

    #[test]
    fn block_json_uses_the_closed_core_semantic_contract() {
        let directory = tempfile::tempdir().unwrap();
        let draft_path = directory.path().join("block.json");
        std::fs::write(
            &draft_path,
            br#"{
                "local_id":"local-root",
                "block_type":"paragraph",
                "props":{},
                "content":{"kind":"absent"},
                "children":[]
            }"#,
        )
        .unwrap();
        let draft = read_json_file::<DocumentSemanticBlockDraft>(&draft_path, "Block draft")
            .expect("valid semantic Block draft");
        assert_eq!(draft.local_id, "local-root");

        let invalid_path = directory.path().join("invalid.json");
        std::fs::write(
            &invalid_path,
            br#"{
                "local_id":"local-root",
                "block_type":"paragraph",
                "props":{},
                "content":{"kind":"absent"},
                "children":[],
                "caller_owned_id":"block-1"
            }"#,
        )
        .unwrap();
        let error = read_json_file::<DocumentSemanticBlockDraft>(&invalid_path, "Block draft")
            .expect_err("unknown Block draft field");
        assert_eq!(error.code, CliErrorCode::InvalidInput);
        assert_eq!(error.path.as_deref(), Some(invalid_path.to_str().unwrap()));
    }

    #[test]
    fn stable_block_ids_reject_paths_and_unbounded_values() {
        assert_eq!(validate_block_id("block-1".to_owned()).unwrap(), "block-1");
        assert!(validate_block_id("parent/block".to_owned()).is_err());
        assert!(validate_block_id(" block".to_owned()).is_err());
        assert!(validate_block_id("x".repeat(513)).is_err());
    }

    #[test]
    fn nfm_fragment_validation_rejects_whitespace_and_accepts_explicit_empty_blocks() {
        let error =
            validate_nfm_fragment("\n \t\n".to_owned()).expect_err("whitespace-only Fragment");
        assert_eq!(error.code, CliErrorCode::InvalidInput);
        assert!(error.message.contains("<empty-block/>"));
        assert_eq!(
            validate_nfm_fragment("<empty-block/>".to_owned()).unwrap(),
            "<empty-block/>"
        );
    }
}
