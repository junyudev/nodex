use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use nodex_core_contracts::{
    ModuleApplyRequest, StoreEpoch,
    automation::{
        AUTOMATION_CONTRACT_VERSION, Automation, AutomationIntent, AutomationRead,
        AutomationReadValue, AutomationStatus,
    },
    collection::CollectionWindowRequest,
};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use sha2::{Digest, Sha256};

use crate::{
    error::{CliError, CliErrorCode},
    runtime::{CommandOutput, map_client_error, map_core_error, operation_id},
};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct AutomationsArgs {
    #[command(subcommand)]
    pub command: AutomationsCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum AutomationsCommand {
    /// List Automations, with bounded search and an opaque continuation cursor.
    List {
        /// Filter Automation names, instructions and IDs.
        #[arg(long)]
        query: Option<String>,
        /// Continue the same query from its returned next_cursor.
        #[arg(long)]
        cursor: Option<String>,
        /// Maximum Automations to return (1–100).
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        /// Include deleted Automations and their retained history.
        #[arg(long)]
        include_deleted: bool,
    },
    /// Read an Automation's current definition and waiting Inbox decision.
    Show {
        /// Stable Automation ID returned by list.
        id: String,
    },
    /// Create a clock Automation from its complete typed JSON definition.
    Create(AutomationCreateArgs),
    /// Replace an Automation's definition using its observed revision.
    Update(AutomationUpdateArgs),
    /// Pause an Automation without changing its condition or execution target.
    Pause(AutomationWriteArgs),
    /// Resume a paused Automation.
    Resume(AutomationWriteArgs),
    /// Delete an Automation and withdraw its unstarted decisions.
    Delete(AutomationWriteArgs),
    /// Dispatch an Automation now, or confirm its waiting Ask first decision.
    Run(AutomationRunArgs),
}

#[derive(Clone, Debug, PartialEq, Args)]
pub struct AutomationCreateArgs {
    /// AutomationInput JSON file, or - for redirected stdin; inspect --help-schema input.
    #[arg(long, default_value = "-", value_name = "JSON_FILE_OR_DASH")]
    pub file: PathBuf,
    /// Replay this exact mutation after an uncertain result.
    #[arg(long)]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Args)]
pub struct AutomationWriteArgs {
    /// Stable Automation ID returned by list or show.
    pub id: String,
    /// Observed automation_revision from show.
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    pub if_revision: i64,
    /// Replay this exact mutation after an uncertain result.
    #[arg(long)]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Args)]
pub struct AutomationUpdateArgs {
    #[command(flatten)]
    pub write: AutomationWriteArgs,
    /// Complete replacement AutomationInput JSON file, or - for redirected stdin.
    #[arg(long, default_value = "-", value_name = "JSON_FILE_OR_DASH")]
    pub file: PathBuf,
    /// Preserve or explicitly change the observed lifecycle from show.
    #[arg(long, value_enum)]
    pub status: AutomationWriteStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum AutomationWriteStatus {
    Active,
    Paused,
}

#[derive(Clone, Debug, PartialEq, Args)]
pub struct AutomationRunArgs {
    /// Stable Automation ID returned by list or show.
    pub id: String,
    /// Replay the same manual dispatch after an uncertain result.
    #[arg(long)]
    pub idempotency_key: Option<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct AutomationMutationResult {
    pub item: Option<Automation>,
    pub operation_id: String,
    pub duplicate: bool,
}

fn read(client: &CoreClient, read: AutomationRead) -> Result<AutomationReadValue, CliError> {
    match client
        .automation_read(None, read)
        .map_err(map_client_error)?
        .0
    {
        ResponseEnvelope::Ok(value) => Ok(value.value),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn get(client: &CoreClient, id: String) -> Result<Automation, CliError> {
    let AutomationReadValue::Automation { item } =
        read(client, AutomationRead::Automation { automation_id: id })?
    else {
        return Err(invalid_response());
    };
    item.map(|item| *item)
        .ok_or_else(|| CliError::new(CliErrorCode::ScopeNotFound, "Automation not found"))
}

pub(crate) fn execute(
    client: &CoreClient,
    args: AutomationsArgs,
) -> Result<CommandOutput, CliError> {
    match args.command {
        AutomationsCommand::List {
            query,
            cursor,
            limit,
            include_deleted,
        } => {
            let AutomationReadValue::Automations { window } = read(
                client,
                AutomationRead::Automations {
                    include_deleted: Some(include_deleted),
                    search_query: query,
                    window: CollectionWindowRequest {
                        after: cursor,
                        first: Some(limit),
                    },
                },
            )?
            else {
                return Err(invalid_response());
            };
            output(window)
        }
        AutomationsCommand::Show { id } => output(get(client, id)?),
        command => apply(client, command),
    }
}

fn apply(client: &CoreClient, command: AutomationsCommand) -> Result<CommandOutput, CliError> {
    let pause = matches!(&command, AutomationsCommand::Pause(_));
    let (key, intent) = match command {
        AutomationsCommand::Create(args) => {
            let key = operation_id(args.idempotency_key.as_deref())?;
            let automation_id =
                format!("automation:{}", hex::encode(Sha256::digest(key.as_bytes())));
            (
                key,
                AutomationIntent::CreateAutomation {
                    automation_id,
                    automation: crate::input::read_json(&args.file, "Automation definition")?,
                },
            )
        }
        AutomationsCommand::Update(args) => (
            operation_id(args.write.idempotency_key.as_deref())?,
            AutomationIntent::UpdateAutomation {
                automation_id: args.write.id,
                expected_revision: args.write.if_revision,
                status: match args.status {
                    AutomationWriteStatus::Active => AutomationStatus::Active,
                    AutomationWriteStatus::Paused => AutomationStatus::Paused,
                },
                automation: crate::input::read_json(&args.file, "Automation definition")?,
            },
        ),
        AutomationsCommand::Pause(args) | AutomationsCommand::Resume(args) => {
            let status = if pause {
                AutomationStatus::Paused
            } else {
                AutomationStatus::Active
            };
            (
                operation_id(args.idempotency_key.as_deref())?,
                AutomationIntent::SetAutomationStatus {
                    automation_id: args.id,
                    expected_revision: args.if_revision,
                    status,
                },
            )
        }
        AutomationsCommand::Delete(args) => (
            operation_id(args.idempotency_key.as_deref())?,
            AutomationIntent::DeleteAutomation {
                automation_id: args.id,
                expected_revision: args.if_revision,
            },
        ),
        AutomationsCommand::Run(args) => (
            operation_id(args.idempotency_key.as_deref())?,
            AutomationIntent::DispatchNow {
                automation_id: args.id,
            },
        ),
        _ => return Err(invalid_response()),
    };
    let response = client
        .automation_apply(
            None,
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: key,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent,
            },
        )
        .map_err(map_client_error)?;
    let result = match response.0 {
        ResponseEnvelope::Ok(result) => result,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    };
    output(AutomationMutationResult {
        item: result.outcome().automations.first().cloned(),
        operation_id: result.receipt().mutation.operation_id.clone(),
        duplicate: result.receipt().mutation.duplicate,
    })
}

fn output(value: impl serde::Serialize) -> Result<CommandOutput, CliError> {
    serde_json::to_value(value)
        .map(CommandOutput::Json)
        .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}

fn invalid_response() -> CliError {
    CliError::new(CliErrorCode::Internal, "Invalid Automations response")
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn writes_require_observed_revisions_and_lists_are_bounded() {
        for args in [
            vec!["nodex", "automations", "update", "automation"],
            vec!["nodex", "automations", "pause", "automation"],
            vec![
                "nodex",
                "automations",
                "delete",
                "automation",
                "--if-revision",
                "0",
            ],
            vec!["nodex", "automations", "list", "--limit", "101"],
        ] {
            assert!(crate::cli::Cli::try_parse_from(args).is_err());
        }
        assert!(
            crate::cli::Cli::try_parse_from([
                "nodex",
                "automations",
                "run",
                "automation",
                "--idempotency-key",
                "manual-1"
            ])
            .is_ok()
        );
    }
}
