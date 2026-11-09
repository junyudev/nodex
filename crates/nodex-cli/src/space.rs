use crate::{
    error::{CliError, CliErrorCode},
    runtime::CommandOutput,
};
use clap::{Args, Subcommand, ValueEnum};
use nodex_core_contracts::{library::MemberRole, team::*};
use nodex_core_protocol::client::CoreClient;
#[derive(Clone, Debug, PartialEq, Args)]
pub struct SpaceArgs {
    #[command(subcommand)]
    pub command: SpaceCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum SpaceCommand {
    /// Manage this host's private-network remote listener.
    RemoteAccess {
        #[command(subcommand)]
        command: RemoteAccessCommand,
    },
    /// Link another Device of your own Member for five minutes.
    LinkDevice,
    /// List this Space's Members (Owner only).
    Members,
    /// Enable HTTPS until this Core process stops.
    Listen {
        /// Bind address for HTTPS, such as 127.0.0.1:8443.
        #[arg(long)]
        address: String,
        /// Operator-provided server certificate PEM.
        #[arg(long, requires = "key")]
        cert: Option<String>,
        /// Private PEM key for the supplied certificate.
        #[arg(long, requires = "cert")]
        key: Option<String>,
    },
    /// Create a one-time enrollment code, valid for 24 hours.
    Invite {
        /// Space role granted by the invite.
        #[arg(long, value_enum, default_value = "member")]
        role: InviteRole,
        /// Enroll another device for an existing active Member.
        #[arg(long)]
        member: Option<String>,
    },
    /// Set this Space's name for every Member.
    Rename {
        /// Shared Space name.
        name: String,
    },
    /// Set the name other Members see for you in this Space.
    DisplayName {
        /// Your name, as others should recognize it.
        name: String,
    },
    /// List enrolled devices, including revoked devices.
    Devices,
    /// Revoke a device and close its live streams.
    #[command(alias = "revoke-device")]
    Revoke {
        /// Enrolled device ID from space devices.
        device: String,
    },
    /// Remove a Member and revoke all of their devices.
    RemoveMember {
        /// Member ID to remove from this Space.
        member: String,
    },
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum RemoteAccessCommand {
    /// Enable remote access and remember its listener address.
    On {
        /// Override the saved bind address; port zero chooses a new available port.
        #[arg(long)]
        address: Option<String>,
    },
    /// Disable remote access and close the listener and its live connections.
    Off,
    /// Read the current listener state without changing it.
    Status,
}
#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum InviteRole {
    Owner,
    Member,
}
pub(crate) fn execute(client: &CoreClient, args: SpaceArgs) -> Result<CommandOutput, CliError> {
    let result = match args.command {
        SpaceCommand::RemoteAccess { command } => match command {
            RemoteAccessCommand::On { address } => address
                .map(Ok)
                .unwrap_or_else(|| {
                    client
                        .space_remote_access()
                        .map(|state| state.intent.address)
                })
                .and_then(|address| {
                    client.space_listen(ListenRequest {
                        address,
                        cert: None,
                        key: None,
                        peer_policy: ListenerPeerPolicy::Private,
                    })
                })
                .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
            RemoteAccessCommand::Off => client
                .space_stop_listener()
                .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
            RemoteAccessCommand::Status => client
                .space_remote_access()
                .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        },
        SpaceCommand::LinkDevice => client
            .space_link_device()
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Members => client
            .space_members()
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Listen { address, cert, key } => client
            .space_listen(ListenRequest {
                peer_policy: Default::default(),
                address,
                cert,
                key,
            })
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Invite { role, member } => client
            .space_invite(InviteRequest {
                role: if role == InviteRole::Owner {
                    MemberRole::Owner
                } else {
                    MemberRole::Member
                },
                member_id: member,
            })
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Rename { name } => client
            .space_rename(name)
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::DisplayName { name } => client
            .space_rename_member(name)
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Devices => client
            .space_devices()
            .and_then(|v| serde_json::to_value(v).map_err(Into::into)),
        SpaceCommand::Revoke { device } => {
            client.space_revoke(RevokeDeviceRequest { device_id: device })
        }
        SpaceCommand::RemoveMember { member } => {
            client.space_remove_member(RemoveMemberRequest { member_id: member })
        }
    };
    result
        .map(CommandOutput::Json)
        .map_err(|error| CliError::new(CliErrorCode::InvalidInput, error.to_string()))
}
