use crate::{
    error::{CliError, CliErrorCode},
    runtime::{
        CommandOutput, map_client_error, map_core_error, operation_id, resolve_page_selector,
        selected_project,
    },
};
use clap::{Args, Subcommand};
use nodex_core_contracts::{
    ModuleApplyRequest, StoreEpoch,
    workspace::{
        ExecutionHoldScope, PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent,
        ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    },
};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
#[derive(Clone, Debug, PartialEq, Args)]
pub struct WorkArgs {
    #[command(subcommand)]
    pub command: WorkCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum WorkCommand {
    /// Pause Agent work until you explicitly resume it.
    Pause(WorkScopeArgs),
    /// Clear this scope's hold; parent holds still apply.
    Resume(WorkScopeArgs),
    /// List all durable execution holds.
    Holds,
}
#[derive(Clone, Debug, PartialEq, Args)]
#[command(group(clap::ArgGroup::new("scope").required(true).args(["page","project","space"])))]
pub struct WorkScopeArgs {
    /// Pause or resume one Page selected in the current Project.
    #[arg(long, group = "scope")]
    pub page: Option<String>,
    /// Pause or resume all work in this Project.
    #[arg(long, group = "scope")]
    pub project: Option<String>,
    /// Pause or resume every Agent in this Space, including Nodex.
    #[arg(long, group = "scope")]
    pub space: bool,
    /// Replay this exact operation safely after an uncertain response.
    #[arg(long, global = false)]
    pub idempotency_key: Option<String>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct WorkHoldChange {
    pub scope: ExecutionHoldScope,
    pub paused: bool,
    pub operation_id: String,
    pub duplicate: bool,
}
pub(crate) fn execute(
    client: &CoreClient,
    args: WorkArgs,
    project: Option<&str>,
    cwd: &std::path::Path,
) -> Result<CommandOutput, CliError> {
    if matches!(args.command, WorkCommand::Holds) {
        let mut holds = Vec::new();
        let mut after_key = None;
        loop {
            let response = client
                .workspace_read(
                    None,
                    ProjectWorkspaceRead::ExecutionHolds {
                        after_key,
                        limit: 100,
                    },
                )
                .map_err(map_client_error)?;
            let snapshot = match response.0 {
                ResponseEnvelope::Ok(value) => value,
                ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
            };
            let ProjectWorkspaceReadValue::ExecutionHolds {
                holds: items,
                next_key,
            } = snapshot.value
            else {
                return Err(CliError::new(CliErrorCode::Internal, "Invalid holds read"));
            };
            holds.extend(items);
            after_key = next_key;
            if after_key.is_none() {
                break;
            }
        }
        return serde_json::to_value(holds)
            .map(CommandOutput::Json)
            .map_err(|e| CliError::new(CliErrorCode::Internal, e.to_string()));
    }
    let pause = matches!(args.command, WorkCommand::Pause(_));
    let arguments = match args.command {
        WorkCommand::Pause(args) | WorkCommand::Resume(args) => args,
        _ => unreachable!(),
    };
    let scope = if arguments.space {
        ExecutionHoldScope::Space
    } else if let Some(page) = arguments.page {
        let selected = selected_project(client, project, cwd)?;
        ExecutionHoldScope::Page {
            page_id: resolve_page_selector(client, &selected.id, &page)?,
        }
    } else {
        ExecutionHoldScope::Project {
            project_id: selected_project(client, arguments.project.as_deref(), cwd)?.id,
        }
    };
    let response = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: operation_id(arguments.idempotency_key.as_deref())?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: if pause {
                    ProjectWorkspaceIntent::PauseWork {
                        scope: scope.clone(),
                    }
                } else {
                    ProjectWorkspaceIntent::ResumeWork {
                        scope: scope.clone(),
                    }
                },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(value) => value,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    };
    serde_json::to_value(WorkHoldChange {
        scope,
        paused: pause,
        operation_id: committed.receipt().mutation.operation_id.clone(),
        duplicate: committed.receipt().mutation.duplicate,
    })
    .map(CommandOutput::Json)
    .map_err(|e| CliError::new(CliErrorCode::Internal, e.to_string()))
}
#[cfg(test)]
mod tests {
    use clap::Parser;
    #[test]
    fn scopes_are_exclusive_and_required() {
        for args in [
            vec!["nodex", "work", "pause"],
            vec!["nodex", "work", "pause", "--space", "--page", "page"],
        ] {
            assert!(crate::cli::Cli::try_parse_from(args).is_err());
        }
        for args in [
            vec!["nodex", "work", "pause", "--space"],
            vec!["nodex", "work", "resume", "--page", "page"],
            vec![
                "nodex",
                "work",
                "pause",
                "--project",
                "project",
                "--idempotency-key",
                "pause-1",
            ],
            vec!["nodex", "work", "holds"],
        ] {
            assert!(crate::cli::Cli::try_parse_from(&args).is_ok(), "{args:?}");
        }
    }
}
