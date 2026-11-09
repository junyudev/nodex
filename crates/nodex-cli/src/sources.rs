use crate::{
    error::CliError,
    runtime::{CommandOutput, unwrap_workspace},
};
use clap::{Args, Subcommand};
use nodex_core_contracts::{
    sources::{Source, SourcePosition, SourceProblem, SourceRead, SourceReadValue, SourceTrigger},
    workspace::{ProjectWorkspaceRead, ProjectWorkspaceReadValue},
};
use nodex_core_protocol::client::CoreClient;
#[derive(Clone, Debug, PartialEq, Args)]
pub struct SourcesArgs {
    #[command(subcommand)]
    pub command: SourcesCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum SourcesCommand {
    /// List configured external Sources.
    List,
    /// Read Source positions and open problems.
    Status,
    /// Read the most recent immutable observations on an external thread.
    Triggers {
        /// GitHub issue or pull-request URL.
        #[arg(long)]
        thread: String,
        /// Maximum number of recent Triggers to return (1–100).
        #[arg(long,default_value_t=50,value_parser=clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        /// Read Triggers older than this Trigger id.
        #[arg(long)]
        before: Option<String>,
    },
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SourceStatus {
    source: Source,
    positions: Vec<SourcePosition>,
    problems: Vec<SourceProblem>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct SourceTriggerWindow {
    triggers: Vec<SourceTrigger>,
    next_before: Option<String>,
}
fn read(client: &CoreClient, read: SourceRead) -> Result<SourceReadValue, CliError> {
    let value =
        unwrap_workspace(client.workspace_read(None, ProjectWorkspaceRead::Sources { read }))?
            .value;
    let ProjectWorkspaceReadValue::Sources { value } = value else {
        unreachable!("Source read")
    };
    Ok(value)
}
pub(crate) fn execute(client: &CoreClient, args: SourcesArgs) -> Result<CommandOutput, CliError> {
    if let SourcesCommand::Triggers {
        thread,
        limit,
        before,
    } = args.command
    {
        let SourceReadValue::Triggers { triggers } = read(
            client,
            SourceRead::Triggers {
                thread_url: thread,
                before_id: before,
                limit,
            },
        )?
        else {
            unreachable!("Trigger window")
        };
        let next_before = if triggers.len() == limit as usize {
            triggers.last().map(|t| t.id.clone())
        } else {
            None
        };
        return Ok(CommandOutput::Json(
            serde_json::to_value(SourceTriggerWindow {
                triggers,
                next_before,
            })
            .expect("Source serialization"),
        ));
    }

    let mut sources = vec![];
    let mut after = None;
    loop {
        let SourceReadValue::Sources { sources: items } = read(
            client,
            SourceRead::Sources {
                after_id: after,
                limit: 100,
            },
        )?
        else {
            unreachable!()
        };
        let done = items.len() < 100;
        after = items.last().map(|s| s.id.clone());
        sources.extend(items);
        if done {
            break;
        }
    }
    if matches!(args.command, SourcesCommand::List) {
        return Ok(CommandOutput::Json(serde_json::json!(sources)));
    }
    let mut status = vec![];
    for source in sources {
        let mut positions = vec![];
        let mut after = None;
        loop {
            let SourceReadValue::Positions { positions: items } = read(
                client,
                SourceRead::Positions {
                    source_id: source.id.clone(),
                    after_partition: after,
                    limit: 100,
                },
            )?
            else {
                unreachable!()
            };
            let done = items.len() < 100;
            after = items.last().map(|p| p.partition.clone());
            positions.extend(items);
            if done {
                break;
            }
        }
        let mut problems = vec![];
        let mut after = None;
        loop {
            let SourceReadValue::OpenProblems { problems: items } = read(
                client,
                SourceRead::OpenProblems {
                    source_id: Some(source.id.clone()),
                    after_id: after,
                    limit: 100,
                },
            )?
            else {
                unreachable!()
            };
            let done = items.len() < 100;
            after = items.last().map(|p| p.id.clone());
            problems.extend(items);
            if done {
                break;
            }
        }
        status.push(SourceStatus {
            source,
            positions,
            problems,
        });
    }
    Ok(CommandOutput::Json(serde_json::json!(status)))
}
