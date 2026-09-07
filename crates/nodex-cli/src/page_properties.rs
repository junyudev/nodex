use crate::cli::MutationArgs;
use crate::data_source::stable_id;
use crate::error::{CliError, CliErrorCode};
use crate::input::read_json;
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, resolve_page_selector,
    selected_project, unwrap_library,
};
use clap::{Args, Subcommand};
use nodex_core_contracts::database::{
    DatabaseIntent, DatabasePagePropertyAddress, DatabasePropertyValueEdit,
    DatabasePropertyValueInput, DatabasePropertyValueMutation,
};
use nodex_core_contracts::library::{LibraryPageDataSourceContext, LibraryRead, LibraryReadValue};
use nodex_core_contracts::{DATABASE_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct PagePropertiesArgs {
    #[command(subcommand)]
    pub command: PagePropertiesCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum PagePropertiesCommand {
    /// Freeze SQL result targets and observed Property revisions into an apply document.
    PrepareBatch(crate::selection_batch::PrepareBatchArgs),
    /// Atomically apply typed Property edits from JSON.
    Apply {
        /// Typed Property edits JSON or a prepare-batch result; - reads stdin.
        #[arg(long, default_value = "-")]
        input: PathBuf,
        #[arg(skip)]
        prepared: Option<PropertyApplyInput>,
        #[command(flatten)]
        mutation: MutationArgs,
    },
    /// Replace one select, text, or number Property using its current revision.
    Set(PropertySetArgs),
}
#[derive(Clone, Debug, PartialEq, Args)]
#[command(group(clap::ArgGroup::new("value").required(true).args(["option", "text", "number"])))]
pub struct PropertySetArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Source ID; omitted uses the Page’s current membership.
    #[arg(long)]
    pub data_source: Option<String>,
    /// Stable Property ID within the Source (not its display name).
    #[arg(long)]
    pub property: String,
    /// Select option ID; choose exactly one of --option, --text or --number.
    #[arg(long)]
    pub option: Option<String>,
    /// Replacement text value, including an empty string.
    #[arg(long)]
    pub text: Option<String>,
    /// Replacement numeric value.
    #[arg(long, allow_hyphen_values = true)]
    pub number: Option<f64>,
    /// Observed value_revision from property_values; zero denotes no existing value.
    #[arg(long)]
    pub if_revision: i64,
    #[command(flatten)]
    pub mutation: MutationArgs,
}
#[derive(Clone, Debug, PartialEq, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PropertyApplyInput {
    #[schema(min_items = 1, max_items = 4096)]
    pub edits: Vec<DatabasePropertyValueMutation>,
}

pub(crate) type PropertyApplyDocument = crate::input_document::InputDocument<PropertyApplyInput>;

pub(crate) fn prepare(args: &mut PagePropertiesArgs) -> Result<(), CliError> {
    if let PagePropertiesCommand::PrepareBatch(args) = &mut args.command {
        return crate::selection_batch::prepare(args);
    }
    if let PagePropertiesCommand::Apply {
        input, prepared, ..
    } = &mut args.command
    {
        *prepared = Some(read_json::<PropertyApplyDocument>(input, "Property edits")?.into_inner());
    }
    Ok(())
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: PagePropertiesArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let (edits, mutation) = match args.command {
        PagePropertiesCommand::PrepareBatch(args) => {
            return crate::selection_batch::execute(client, &project.id, args);
        }
        PagePropertiesCommand::Apply {
            input: _,
            prepared,
            mutation,
        } => (
            prepared
                .ok_or_else(|| internal("Property edits input was not prepared"))?
                .edits,
            mutation,
        ),
        PagePropertiesCommand::Set(args) => {
            let page_id = resolve_page_selector(client, &project.id, &args.page)?;
            let data_source_id = match args.data_source {
                Some(id) => stable_id(&id)?,
                None => page_source(client, &project.id, &page_id)?
                    .map(|(id, _)| id)
                    .ok_or_else(|| {
                        CliError::new(
                            CliErrorCode::InvalidInput,
                            "Page has no Data Source Property schema",
                        )
                    })?,
            };
            let value = match (args.option, args.text, args.number) {
                (Some(option), None, None) => DatabasePropertyValueInput::Select {
                    option_id: stable_id(&option)?,
                },
                (None, Some(value), None) => DatabasePropertyValueInput::Text { value },
                (None, None, Some(value)) if value.is_finite() => {
                    DatabasePropertyValueInput::Number { value }
                }
                _ => {
                    return Err(CliError::new(
                        CliErrorCode::InvalidInput,
                        "Specify exactly one finite --number, --text, or --option value",
                    ));
                }
            };
            (
                vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id,
                        data_source_id,
                        property_id: stable_id(&args.property)?,
                    },
                    edit: DatabasePropertyValueEdit::Replace {
                        expected_value_revision: args.if_revision,
                        value,
                    },
                }],
                args.mutation,
            )
        }
    };
    crate::page_mutation::validate_return_fields(&mutation.r#return)?;
    let response = client
        .database_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: operation_id(mutation.idempotency_key.as_deref())?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![DatabaseIntent::EditPropertyValues { edits }],
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => serde_json::to_value(committed)
            .map(CommandOutput::Json)
            .map_err(internal),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}
fn page_source(
    client: &CoreClient,
    project_id: &str,
    page_id: &str,
) -> Result<Option<(String, Vec<String>)>, CliError> {
    let result = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageDetail {
            page_id: page_id.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageDetail { value } = result.value else {
        return Err(internal("unexpected Page detail"));
    };
    match value.data_source_context {
        LibraryPageDataSourceContext::Standalone => Ok(None),
        LibraryPageDataSourceContext::Member {
            membership,
            properties,
            ..
        } => Ok(Some((
            membership.data_source_id,
            properties
                .into_iter()
                .map(|property| property.property_id)
                .collect(),
        ))),
    }
}
fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}
