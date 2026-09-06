use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use nodex_core_contracts::collection::{CollectionWindow, CollectionWindowRequest};
use nodex_core_contracts::database::{DatabaseDataSourceQuery, DatabaseRead, DatabaseReadValue};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use utoipa::ToSchema;

use crate::error::{CliError, CliErrorCode};
use crate::input::read_json;
use crate::runtime::{CommandOutput, selected_project, unwrap_database};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct WindowArgs {
    #[arg(long)]
    pub after: Option<String>,
    #[arg(long)]
    pub limit: Option<u32>,
}
impl WindowArgs {
    pub(crate) fn request(self) -> CollectionWindowRequest {
        CollectionWindowRequest {
            after: self.after,
            first: self.limit,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Args)]
pub struct DataSourceArgs {
    #[command(subcommand)]
    pub command: DataSourceCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum DataSourceCommand {
    /// List the authorized Data Sources in a Database.
    List {
        #[arg(long)]
        database: String,
        #[command(flatten)]
        window: WindowArgs,
    },
    /// Describe one Data Source and a bounded Property schema window.
    Describe {
        data_source: String,
        #[command(flatten)]
        window: WindowArgs,
    },
    /// List stable selection options for one Property.
    Options {
        data_source: String,
        #[arg(long)]
        property: String,
        #[command(flatten)]
        window: WindowArgs,
    },
    /// Query a Data Source without creating or modifying a saved View.
    Query {
        data_source: String,
        #[arg(long, default_value = "-")]
        input: PathBuf,
        #[arg(skip)]
        prepared: Option<DatabaseDataSourceQuery>,
        #[arg(long)]
        after: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
}

#[derive(Serialize, ToSchema)]
pub(crate) struct DataSourceDescribeOutput {
    pub data_source: nodex_core_contracts::database::DatabaseDataSourceDescriptor,
    pub properties: CollectionWindow<nodex_core_contracts::database::DatabasePropertyDescriptor>,
    pub scope: &'static str,
}
pub(crate) fn prepare(args: &mut DataSourceArgs) -> Result<(), CliError> {
    if let DataSourceCommand::Query {
        input, prepared, ..
    } = &mut args.command
    {
        *prepared = Some(read_json(input, "Data Source query")?);
    }
    Ok(())
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: DataSourceArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let read = match args.command {
        DataSourceCommand::List { database, window } => DatabaseRead::DataSourceWindow {
            database_id: stable_id(&database)?,
            window: window.request(),
        },
        DataSourceCommand::Describe {
            data_source,
            window,
        } => {
            let id = stable_id(&data_source)?;
            let source = unwrap_database(client.database_read(
                Some(&project.id),
                DatabaseRead::DataSource {
                    data_source_id: id.clone(),
                },
            ))?;
            let DatabaseReadValue::DataSource { value } = source.value else {
                return Err(internal("unexpected Data Source descriptor"));
            };
            let properties = unwrap_database(client.database_read(
                Some(&project.id),
                DatabaseRead::PropertyWindow {
                    data_source_id: id,
                    window: window.request(),
                },
            ))?;
            let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
                return Err(internal("unexpected Property window"));
            };
            return serde_json::to_value(DataSourceDescribeOutput {
                data_source: value,
                properties,
                scope: "property_window",
            })
            .map(CommandOutput::Json)
            .map_err(internal);
        }
        DataSourceCommand::Options {
            data_source,
            property,
            window,
        } => DatabaseRead::OptionWindow {
            data_source_id: stable_id(&data_source)?,
            property_id: stable_id(&property)?,
            window: window.request(),
        },
        DataSourceCommand::Query {
            data_source,
            input: _,
            prepared,
            after,
            limit,
        } => {
            let mut query =
                prepared.ok_or_else(|| internal("Data Source query input was not prepared"))?;
            if let Some(after) = after {
                query.cursor = Some(after);
            }
            if let Some(limit) = limit {
                query.limit = Some(limit);
            }
            DatabaseRead::DataSourceQuery {
                data_source_id: stable_id(&data_source)?,
                query,
            }
        }
    };
    let snapshot = unwrap_database(client.database_read(Some(&project.id), read))?;
    serde_json::to_value(snapshot)
        .map(CommandOutput::Json)
        .map_err(internal)
}

pub(crate) fn stable_id(value: &str) -> Result<String, CliError> {
    let value = value.strip_prefix('@').unwrap_or(value);
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Expected one bounded stable resource identity",
        ));
    }
    Ok(value.to_owned())
}
fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}
