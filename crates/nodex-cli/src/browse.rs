use crate::data_source::WindowArgs;
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, resolve_page_selector, selected_project, unwrap_database, unwrap_library,
};
use clap::Args;
use nodex_core_contracts::collection::{CollectionWindowRequest, MAX_COLLECTION_WINDOW_ITEMS};
use nodex_core_contracts::database::{
    DatabaseDataSourceQuery, DatabaseRead, DatabaseReadValue, DatabaseViewFilter,
    DatabaseViewFilterGroupOperator,
};
use nodex_core_contracts::library::{LibraryNavigationParent, LibraryRead, LibraryReadValue};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Args)]
pub struct BrowseArgs {
    /// Page selector or Database identity; `database` uses the Project default.
    pub target: String,
    #[command(flatten)]
    pub window: WindowArgs,
}
#[derive(Serialize, utoipa::ToSchema)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub(crate) enum BrowseOutput {
    DirectPageChildren {
        parent: LibraryNavigationParent,
        items: Vec<nodex_core_contracts::library::LibraryNavigationNode>,
        next_cursor: Option<String>,
        has_more: bool,
        total: u64,
    },
    DirectDataSourcePages {
        database_id: String,
        data_source_id: String,
        items: Vec<BrowsePage>,
        next_cursor: Option<String>,
        has_more: bool,
        projection: nodex_core_contracts::events::ProjectionSnapshotAuthority,
    },
}
#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct BrowsePage {
    pub kind: &'static str,
    pub page_id: String,
    pub page_key: Option<String>,
    pub title: String,
}
fn output(value: BrowseOutput) -> Result<CommandOutput, CliError> {
    serde_json::to_value(value)
        .map(CommandOutput::Json)
        .map_err(internal)
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: BrowseArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let target = args.target.strip_prefix('@').unwrap_or(&args.target);
    let database_id = if target == "database" || target == project.database_id {
        Some(project.database_id.clone())
    } else {
        let result = unwrap_library(client.library_read(
            Some(&project.id),
            LibraryRead::PageLifecyclePreflight {
                page_id: target.to_owned(),
            },
        ))?;
        let LibraryReadValue::PageLifecyclePreflight { value } = result.value else {
            return Err(internal("unexpected target preflight"));
        };
        if value.page.is_some() || !args.target.starts_with('@') {
            None
        } else {
            Some(target.to_owned())
        }
    };
    let Some(database_id) = database_id else {
        let page_id = resolve_page_selector(client, &project.id, &args.target)?;
        let result = unwrap_library(client.library_read(
            Some(&project.id),
            LibraryRead::Children {
                parent: LibraryNavigationParent::Page { page_id },
                cursor: args.window.after,
                limit: args.window.limit,
                force_include_target: None,
            },
        ))?;
        let LibraryReadValue::Children {
            parent,
            items,
            next_cursor,
            has_more,
            total,
        } = result.value
        else {
            return Err(internal("unexpected child window"));
        };
        return output(BrowseOutput::DirectPageChildren {
            parent,
            items,
            next_cursor,
            has_more,
            total,
        });
    };
    let source_id = unique_active_source(client, &project.id, &database_id)?;
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::DataSourceQuery {
            data_source_id: source_id.clone(),
            query: DatabaseDataSourceQuery {
                cursor: args.window.after,
                limit: args.window.limit,
                projection_property_ids: Some(Vec::new()),
                filter: DatabaseViewFilter::Group {
                    operator: DatabaseViewFilterGroupOperator::And,
                    children: Vec::new(),
                },
                sort: Vec::new(),
            },
        },
    ))?;
    let DatabaseReadValue::DataSourceQuery { value } = snapshot.value else {
        return Err(internal("unexpected Data Source rows"));
    };
    let items = value
        .rows
        .items
        .into_iter()
        .map(|row| BrowsePage {
            kind: "page",
            page_id: row.page_id,
            page_key: row.page_key,
            title: row.title,
        })
        .collect();
    output(BrowseOutput::DirectDataSourcePages {
        database_id,
        data_source_id: source_id,
        items,
        has_more: value.rows.next_cursor.is_some(),
        next_cursor: value.rows.next_cursor,
        projection: value.projection,
    })
}
fn unique_active_source(
    client: &CoreClient,
    project_id: &str,
    database_id: &str,
) -> Result<String, CliError> {
    let mut after = None;
    let mut found = None;
    loop {
        let result = unwrap_database(client.database_read(
            Some(project_id),
            DatabaseRead::DataSourceWindow {
                database_id: database_id.to_owned(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(MAX_COLLECTION_WINDOW_ITEMS),
                },
            },
        ))?;
        let DatabaseReadValue::DataSourceWindow { data_sources } = result.value else {
            return Err(internal("unexpected Data Source window"));
        };
        for source in data_sources
            .items
            .into_iter()
            .filter(|source| source.lifecycle == "active")
        {
            if found.is_some() {
                return Err(CliError::new(
                    CliErrorCode::ScopeAmbiguous,
                    "Database has multiple active Data Sources; use data-source list and query a stable identity",
                ));
            }
            found = Some(source.data_source_id);
        }
        let Some(cursor) = data_sources.next_cursor else {
            break;
        };
        after = Some(cursor);
    }
    found.ok_or_else(|| {
        CliError::new(
            CliErrorCode::ScopeNotFound,
            "Database has no active Data Source",
        )
    })
}
fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}
