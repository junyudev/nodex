use crate::cli::MutationArgs;
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, map_client_error, map_core_error, operation_id};
use clap::Args;
use nodex_core_contracts::database::DatabaseIntent;
use nodex_core_contracts::database_configuration::DatabaseConfigurationScript;
use nodex_core_contracts::{DATABASE_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Args)]
pub struct ConfigureArgs {
    /// Data Source ID or unique name; omitted uses the unique active Source in the selected Database.
    pub data_source: Option<String>,
    /// Configuration JSON with if_schema_revision and 1–100 operations; - reads stdin.
    #[arg(long, default_value = "-")]
    pub input: PathBuf,
    #[arg(skip)]
    pub prepared: Option<DatabaseConfigurationScript>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}
pub(crate) fn prepare(args: &mut ConfigureArgs) -> Result<(), CliError> {
    let script: DatabaseConfigurationScript =
        crate::input::read_json(&args.input, "Configuration script")?;
    if script.if_schema_revision < 1
        || script.operations.is_empty()
        || script.operations.len() > 100
    {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Configuration requires a positive if_schema_revision and 1–100 operations",
        ));
    }
    args.prepared = Some(script);
    Ok(())
}
pub(crate) fn execute(
    client: &CoreClient,
    project_id: &str,
    data_source_id: String,
    args: ConfigureArgs,
) -> Result<CommandOutput, CliError> {
    let script = args.prepared.ok_or_else(|| {
        CliError::new(
            CliErrorCode::Internal,
            "Configuration script was not prepared",
        )
    })?;
    crate::page_mutation::validate_return_fields(&args.mutation.r#return)?;
    let response = client
        .database_apply(
            Some(project_id),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: operation_id(args.mutation.idempotency_key.as_deref())?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![DatabaseIntent::Configure {
                    data_source_id,
                    script,
                }],
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => serde_json::to_value(committed)
            .map(CommandOutput::Json)
            .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string())),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}
