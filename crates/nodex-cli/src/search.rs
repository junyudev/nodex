use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, selected_project, unwrap_library};
use clap::Args;
use nodex_core_contracts::library::{
    LibraryPageSearchMatch, LibraryPageSearchTextPart, LibraryProjectPageSearchHit, LibraryRead,
    LibraryReadValue,
};
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
    pub items: Vec<SearchHit>,
    pub limit: u32,
    pub commit_seq: i64,
}
/// Search identifies candidates; Page reads and SQL supply complete content and Properties.
#[derive(Serialize, ToSchema)]
pub(crate) struct SearchHit {
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
    pub location_label: String,
    pub matches: Vec<SearchEvidence>,
}

#[derive(Serialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub(crate) enum SearchEvidence {
    PageKey {
        page_key: String,
        is_current: bool,
    },
    Property {
        property_id: String,
        property_name: String,
        text: String,
    },
    Body {
        block_id: String,
        text: String,
    },
}

fn text(parts: Vec<LibraryPageSearchTextPart>) -> String {
    parts.into_iter().map(|part| part.text).collect()
}

impl From<LibraryProjectPageSearchHit> for SearchHit {
    fn from(hit: LibraryProjectPageSearchHit) -> Self {
        Self {
            page_id: hit.page_id,
            page_key: hit.page_key,
            title: hit.title,
            location_label: hit.location_label,
            matches: hit
                .matches
                .into_iter()
                .filter_map(|evidence| match evidence {
                    LibraryPageSearchMatch::Identity { .. }
                    | LibraryPageSearchMatch::Title { .. } => None,
                    LibraryPageSearchMatch::PageKey {
                        page_key,
                        is_current,
                        ..
                    } => Some(SearchEvidence::PageKey {
                        page_key,
                        is_current,
                    }),
                    LibraryPageSearchMatch::Property {
                        property_id,
                        property_name,
                        parts,
                        ..
                    } => Some(SearchEvidence::Property {
                        property_id,
                        property_name,
                        text: text(parts),
                    }),
                    LibraryPageSearchMatch::Body {
                        block_id, parts, ..
                    } => Some(SearchEvidence::Body {
                        block_id,
                        text: text(parts),
                    }),
                })
                .collect(),
        }
    }
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
        items: items.into_iter().map(SearchHit::from).collect(),
        limit: args.limit.unwrap_or(20),
        commit_seq: snapshot.commit_head,
    })
    .map(CommandOutput::Json)
    .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}
