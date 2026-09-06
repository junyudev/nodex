use crate::cli::MutationArgs;
use crate::error::{CliError, CliErrorCode};
use crate::input::read_json;
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, selected_project,
};
use clap::Args;
use nodex_core_contracts::library::{
    LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest, LibraryAgentPageDestination,
    LibraryIntent, LibraryPageCopyValue,
};
use nodex_core_contracts::{LIBRARY_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct PageCreateBatchArgs {
    #[arg(long, default_value = "-")]
    pub input: PathBuf,
    #[arg(skip)]
    pub(crate) prepared: Option<PageBatchInput>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}
#[derive(Clone, Debug, PartialEq, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PageBatchInput {
    pub destination: LibraryAgentPageDestination,
    #[schema(min_items = 1, max_items = 16)]
    pub pages: Vec<PageBatchDraft>,
    #[serde(default)]
    #[schema(default = false)]
    pub include_block_ids: bool,
    #[serde(default = "default_true")]
    #[schema(default = true)]
    pub include_etags: bool,
}
#[derive(Clone, Debug, PartialEq, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PageBatchDraft {
    pub title_markdown: String,
    pub nested_markdown: String,
    #[serde(default)]
    pub values: Vec<LibraryPageCopyValue>,
}
#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct PageBatchOutput {
    pub operation_id: String,
    pub duplicate: bool,
    pub commit_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<nodex_core_contracts::library::LibraryCommitValue>,
    #[serde(flatten)]
    pub result: nodex_core_contracts::library::LibraryAgentCreatePagesResult,
}
fn default_true() -> bool {
    true
}
pub(crate) fn prepare(args: &mut PageCreateBatchArgs) -> Result<(), CliError> {
    args.prepared = Some(read_json(&args.input, "Page batch")?);
    Ok(())
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: PageCreateBatchArgs,
) -> Result<CommandOutput, CliError> {
    crate::page_mutation::validate_return_fields(&args.mutation.r#return)?;
    let input = args.prepared.ok_or_else(|| {
        CliError::new(CliErrorCode::Internal, "Page batch input was not prepared")
    })?;
    let project = selected_project(client, explicit_project, cwd)?;
    let request = LibraryAgentCreatePagesRequest {
        destination: input.destination,
        pages: input
            .pages
            .into_iter()
            .map(|page| LibraryAgentCreatePageDraft {
                title_markdown: page.title_markdown,
                nfm: page.nested_markdown,
                values: page.values,
            })
            .collect(),
        include_block_ids: input.include_block_ids,
        include_etags: input.include_etags,
    };
    let response = client
        .library_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: operation_id(args.mutation.idempotency_key.as_deref())?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreatePagesFromNfm { request },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(value) => value,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    };
    let pages = committed
        .outcome()
        .agent_create_pages
        .as_ref()
        .ok_or_else(|| {
            CliError::new(
                CliErrorCode::Internal,
                "Core omitted the created Page batch",
            )
        })?;
    serde_json::to_value(PageBatchOutput {
        operation_id: committed.receipt().mutation.operation_id.clone(),
        duplicate: committed.receipt().mutation.duplicate,
        commit_seq: committed.commit_cursor(),
        commit: args
            .mutation
            .r#return
            .iter()
            .any(|field| field == "commit")
            .then(|| committed.outcome().clone()),
        result: pages.clone(),
    })
    .map(CommandOutput::Json)
    .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}
