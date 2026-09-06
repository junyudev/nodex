use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, selected_project, unwrap_library};
use clap::Args;
use nodex_core_contracts::library::{LibraryRead, LibraryReadValue};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use std::path::Path;
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, Args)]
pub struct SearchArgs {
    pub query: String,
    #[arg(long)]
    pub limit: Option<u32>,
}
#[derive(Serialize, ToSchema)]
pub(crate) struct SearchOutput {
    pub scope: &'static str,
    pub items: Vec<nodex_core_contracts::library::LibraryProjectPageSearchHit>,
    pub limit: u32,
    pub commit_seq: i64,
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: SearchArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::ProjectPageSearch {
            project_ids: vec![project.id.clone()],
            query: args.query,
            filters: None,
            preferred_project_id: Some(project.id.clone()),
            recent_page_ids: Vec::new(),
            limit: args.limit,
        },
    ))?;
    let LibraryReadValue::ProjectPageSearch { items } = snapshot.value else {
        return Err(CliError::new(
            CliErrorCode::Internal,
            "unexpected Page search result",
        ));
    };
    serde_json::to_value(SearchOutput {
        scope: "ranked_search_evidence",
        items,
        limit: args.limit.unwrap_or(20),
        commit_seq: snapshot.commit_head,
    })
    .map(CommandOutput::Json)
    .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}
