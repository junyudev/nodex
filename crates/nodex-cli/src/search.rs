use crate::deeplink::page_url;
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
    /// Match query words across a Page’s title, key, ID, Properties, and body. Word starts, stems, fragments, and eligible typos can match.
    pub query: String,
    /// Maximum ranked Page hits to return.
    #[arg(long)]
    pub limit: Option<u32>,
}
#[derive(Serialize, ToSchema)]
pub(crate) struct SearchOutput {
    truncated: bool,
    coverage: nodex_core_contracts::library::LibrarySearchCoverage,
    pub scope: &'static str,
    pub items: Vec<SearchHit>,
    pub limit: u32,
    pub commit_seq: i64,
}
/// Search identifies candidates; Page reads and SQL supply complete content and Properties.
#[derive(Serialize, ToSchema)]
pub(crate) struct SearchHit {
    pub page_id: String,
    pub url: String,
    pub page_key: Option<String>,
    pub title: String,
    pub archived: bool,
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
    Context {
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

impl TryFrom<LibraryProjectPageSearchHit> for SearchHit {
    type Error = CliError;

    fn try_from(hit: LibraryProjectPageSearchHit) -> Result<Self, CliError> {
        Ok(Self {
            url: page_url(&hit.page_id)?,
            page_id: hit.page_id,
            page_key: hit.page_key,
            title: hit.title,
            archived: hit.archived,
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
                    LibraryPageSearchMatch::Context { parts, .. } => {
                        Some(SearchEvidence::Context { text: text(parts) })
                    }
                    LibraryPageSearchMatch::Body {
                        block_id, parts, ..
                    } => Some(SearchEvidence::Body {
                        block_id,
                        text: text(parts),
                    }),
                })
                .collect(),
        })
    }
}

pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: SearchArgs,
) -> Result<CommandOutput, CliError> {
    let project = explicit_project
        .map(|_| selected_project(client, explicit_project, cwd))
        .transpose()?;
    let snapshot = unwrap_library(client.library_read(
        project.as_ref().map(|project| project.id.as_str()),
        LibraryRead::ProjectPageSearch {
            project_filter_ids: None,
            query: args.query,
            instant: false,
            exclude_page_ids: Vec::new(),
            data_source_ids: None,
            preferred_project_id: project.as_ref().map(|project| project.id.clone()),
            recent_page_ids: Vec::new(),
            limit: args.limit,
        },
    ))?;
    let LibraryReadValue::ProjectPageSearch {
        items,
        truncated,
        coverage,
    } = snapshot.value
    else {
        return Err(CliError::new(
            CliErrorCode::Internal,
            "unexpected Page search result",
        ));
    };
    serde_json::to_value(SearchOutput {
        truncated,
        coverage,
        scope: "ranked_search_evidence",
        items: items
            .into_iter()
            .map(SearchHit::try_from)
            .collect::<Result<_, _>>()?,
        limit: args.limit.unwrap_or(20),
        commit_seq: snapshot.commit_head,
    })
    .map(CommandOutput::Json)
    .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}
