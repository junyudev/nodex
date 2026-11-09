use crate::{
    error::CliError,
    runtime::{CommandOutput, unwrap_library},
};
use clap::{Args, Subcommand};
use nodex_core_contracts::library::{LibraryRead, LibraryReadValue};
use nodex_core_protocol::client::CoreClient;

#[derive(Clone, Debug, PartialEq, Args)]
pub struct MembersArgs {
    #[command(subcommand)]
    pub command: MembersCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum MembersCommand {
    /// List the people in this Library, including retained removed Members.
    List,
    /// Read the Member bound to this local Profile.
    Me,
}
pub(crate) fn execute(client: &CoreClient, args: MembersArgs) -> Result<CommandOutput, CliError> {
    let read = match args.command {
        MembersCommand::List => LibraryRead::Members,
        MembersCommand::Me => LibraryRead::LocalMember,
    };
    let value = unwrap_library(client.library_read(None, read))?.value;
    let value = match value {
        LibraryReadValue::Members { items } => serde_json::to_value(items),
        LibraryReadValue::LocalMember { value } => serde_json::to_value(value),
        _ => unreachable!("Members read"),
    };
    value.map(CommandOutput::Json).map_err(|e| {
        crate::error::CliError::new(crate::error::CliErrorCode::Internal, e.to_string())
    })
}
