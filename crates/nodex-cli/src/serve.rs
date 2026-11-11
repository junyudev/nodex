//! Native lifecycle and administration for a Host-owned team Space.
use crate::{
    error::{CliError, CliErrorCode},
    runtime::CommandOutput,
    space::{InviteRole, SpaceArgs, SpaceCommand},
};
use clap::{Args, Subcommand};
use fs2::FileExt;
use nodex_core_contracts::team::ListenRequest;
use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use nodex_platform::{
    private_fs::{self, EntryKind, OpenOptions},
    process,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct ServeArgs {
    /// Absolute private home for this team Space.
    #[arg(long, global = true)]
    pub home: Option<PathBuf>,
    #[command(subcommand)]
    pub command: ServeCommand,
}

#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum ServeCommand {
    /// Create a private team Space, Owner membership, and server certificate.
    Init {
        /// Numeric IP address and port for the Space's HTTPS listener.
        #[arg(long, default_value = "127.0.0.1:8443")]
        address: SocketAddr,
        /// Separate working and execution state; defaults to a sibling of the Core home.
        #[arg(long)]
        execution_home: Option<PathBuf>,
        /// Shared Space name; defaults to Core's Team Space name.
        #[arg(long)]
        name: Option<String>,
        /// The name Members see for this host's local Owner; defaults to the OS account's name.
        #[arg(long)]
        owner_name: Option<String>,
        /// Name of the Space's initial Project.
        #[arg(long, default_value = "Team")]
        project_name: String,
        /// Canonical HTTPS remote identifying the initial Project's repository.
        #[arg(long, requires = "clone")]
        repository: Option<String>,
        /// Existing host-local clone mapped to --repository.
        #[arg(long, requires = "repository")]
        clone: Option<PathBuf>,
    },
    /// Start this Space's Host and HTTPS listener.
    Start {
        /// Keep the Host attached for launchd, systemd, or an interactive terminal.
        #[arg(long)]
        foreground: bool,
        /// Acknowledge same-user Agent filesystem access when listening beyond loopback.
        #[arg(long)]
        allow_same_user_agents: bool,
    },
    /// Read the live Host generation and deployment warning.
    Status,
    /// Create a one-time device enrollment code.
    Invite {
        /// Role assigned to a newly enrolled Member.
        #[arg(long, value_enum, default_value = "member")]
        role: InviteRole,
        /// Enroll another Device for this existing Member instead of creating one.
        #[arg(long)]
        member: Option<String>,
    },
    /// Rename this Space for all Members on their next connection.
    Rename {
        /// Shared Space name.
        name: String,
    },
    /// Set the name Members see for this host's local Owner.
    DisplayName {
        /// The local Owner's name, as others should recognize it.
        name: String,
    },
    /// List this Space's Members.
    Members,
    /// List enrolled devices.
    Devices,
    /// Revoke an enrolled device.
    Revoke {
        /// Identifier of the Device whose access is withdrawn.
        device: String,
    },
    /// Internal lifetime lease, held until the embedding Host closes stdin.
    #[command(hide = true)]
    Lock {
        /// Exact Host lifetime identity for this native lease.
        #[arg(long)]
        instance: String,
        /// Process owning the Host lifetime represented by this lease.
        #[arg(long)]
        parent_pid: u32,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunner {
    pub user: String,
    pub launcher: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostConfiguration {
    pub version: u32,
    pub space_id: String,
    pub owner_member_id: String,
    pub address: SocketAddr,
    pub execution_home: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_runner: Option<AgentRunner>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub repositories: std::collections::BTreeMap<String, PathBuf>,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInitResult {
    #[schema(value_type = String)]
    pub home: PathBuf,
    pub space_id: String,
    pub owner_member_id: String,
    pub project_id: String,
    pub name: String,
    pub fingerprint: String,
    #[schema(value_type = String)]
    pub execution_home: PathBuf,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HostState {
    #[default]
    Stopped,
    Starting,
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct HostStatus {
    pub state: HostState,
    pub running: bool,
    pub instance: Option<String>,
    pub pid: Option<u32>,
    pub space_id: Option<String>,
    pub core_generation: Option<String>,
    pub listener: Option<nodex_core_contracts::team::ListenerInfo>,
    pub warning: Option<String>,
    pub agent_runner: Option<String>,
    pub allow_same_user_agents: bool,
}

fn output(value: impl Serialize) -> Result<CommandOutput, CliError> {
    serde_json::to_value(value)
        .map(CommandOutput::Json)
        .map_err(unavailable)
}

fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}
fn unavailable(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::CoreUnavailable, error.to_string())
}
fn private_json(path: &Path) -> Result<Value, CliError> {
    private_fs::checked_metadata(path, EntryKind::File, Some(0o600)).map_err(unavailable)?;
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(unavailable)?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(unavailable)?;
    if bytes.len() > 64 * 1024 {
        return Err(invalid("Host record exceeds its byte bound"));
    }
    serde_json::from_slice(&bytes).map_err(unavailable)
}
fn configuration(home: &Path) -> Result<HostConfiguration, CliError> {
    private_fs::checked_metadata(home, EntryKind::Directory, Some(0o700)).map_err(unavailable)?;
    let config: HostConfiguration =
        serde_json::from_value(private_json(&home.join("host.json"))?).map_err(unavailable)?;
    if config.version != 1
        || !config.execution_home.is_absolute()
        || config.execution_home.starts_with(home)
        || config.space_id.is_empty()
    {
        return Err(invalid("Host configuration is invalid"));
    }
    if config.agent_runner.as_ref().is_some_and(|runner| {
        runner.user.trim().is_empty()
            || runner.launcher.is_empty()
            || runner.launcher[0].trim().is_empty()
    }) {
        return Err(invalid("Agent Runner requires a user and executable argv"));
    }
    Ok(config)
}

pub(crate) fn execute(args: ServeArgs) -> Result<CommandOutput, CliError> {
    let home = args
        .home
        .ok_or_else(|| invalid("serve requires --home <absolute-space-home>"))?;
    if !home.is_absolute() || private_fs::has_traversal(&home) {
        return Err(invalid("serve requires an absolute home without traversal"));
    }
    if let ServeCommand::Init {
        address,
        execution_home,
        name,
        owner_name,
        project_name,
        repository,
        clone,
    } = args.command
    {
        return output(initialize(
            &home,
            address,
            execution_home,
            HostNames {
                space: name,
                owner: owner_name,
            },
            project_name,
            repository,
            clone,
        )?);
    }
    // Runtime descriptors bind their canonical socket path, including on macOS /tmp.
    let home = fs::canonicalize(home).map_err(unavailable)?;
    let config = configuration(&home)?;
    match args.command {
        ServeCommand::Init { .. } => unreachable!(),
        ServeCommand::Start {
            foreground,
            allow_same_user_agents,
        } => start(&home, &config, foreground, allow_same_user_agents),
        ServeCommand::Status => output(status(&home)?),
        ServeCommand::Lock {
            instance,
            parent_pid,
        } => hold_lock(&home, &instance, parent_pid),
        command => {
            let client = CoreClient::connect(&home, "nodex-host-admin").map_err(unavailable)?;
            match command {
                ServeCommand::Invite { role, member } => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::Invite { role, member },
                    },
                ),
                ServeCommand::DisplayName { name } => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::DisplayName { name },
                    },
                ),
                ServeCommand::Rename { name } => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::Rename { name },
                    },
                ),
                ServeCommand::Devices => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::Devices,
                    },
                ),
                ServeCommand::Revoke { device } => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::Revoke { device },
                    },
                ),
                ServeCommand::Members => crate::space::execute(
                    &client,
                    SpaceArgs {
                        command: SpaceCommand::Members,
                    },
                ),
                _ => unreachable!(),
            }
        }
    }
}

/// Names chosen at initialization; Core supplies the defaults.
struct HostNames {
    space: Option<String>,
    owner: Option<String>,
}

fn initialize(
    home: &Path,
    address: SocketAddr,
    execution_home: Option<PathBuf>,
    names: HostNames,
    project_name: String,
    repository: Option<String>,
    clone: Option<PathBuf>,
) -> Result<HostInitResult, CliError> {
    use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch, workspace::*};
    let repositories = match (repository, clone) {
        (None, None) => std::collections::BTreeMap::new(),
        (Some(remote), Some(path)) => {
            if !is_canonical_repository_remote(&remote) {
                return Err(invalid(
                    "Use a canonical HTTPS Git remote without credentials",
                ));
            }
            if !path.is_absolute() || private_fs::has_traversal(&path) {
                return Err(invalid("A clone must be an absolute host-local directory"));
            }
            let path = fs::canonicalize(path).map_err(unavailable)?;
            if !path.is_dir() {
                return Err(invalid("A clone must be a directory"));
            }
            std::collections::BTreeMap::from([(remote, path)])
        }
        _ => return Err(invalid("Supply --repository and --clone together")),
    };
    if home.try_exists().map_err(unavailable)?
        && fs::read_dir(home).map_err(unavailable)?.next().is_some()
    {
        return Err(invalid("Initialize an empty Space home"));
    }
    private_fs::create_dir_all(home).map_err(unavailable)?;
    private_fs::prepare_private_path(home, EntryKind::Directory).map_err(unavailable)?;
    let home = fs::canonicalize(home).map_err(unavailable)?;
    let execution_home = execution_home.unwrap_or_else(|| {
        home.with_file_name(format!(
            "{}-execution",
            home.file_name().unwrap_or_default().to_string_lossy()
        ))
    });
    if !execution_home.is_absolute()
        || execution_home.starts_with(&home)
        || home.starts_with(&execution_home)
        || private_fs::has_traversal(&execution_home)
    {
        return Err(invalid(
            "Execution home must be absolute and outside the private Core home",
        ));
    }
    if execution_home.try_exists().map_err(unavailable)?
        && fs::read_dir(&execution_home)
            .map_err(unavailable)?
            .next()
            .is_some()
    {
        return Err(invalid("Initialize an empty execution home"));
    }
    private_fs::create_dir_all(&execution_home).map_err(unavailable)?;
    private_fs::prepare_private_path(&execution_home, EntryKind::Directory).map_err(unavailable)?;
    let execution_home = fs::canonicalize(execution_home).map_err(unavailable)?;
    let client = connect_or_launch(&home, "nodex-host-init", None).map_err(unavailable)?;
    let result = (|| {
        let identity = client
            .space_prepare(ListenRequest {
                peer_policy: nodex_core_contracts::team::ListenerPeerPolicy::Operator,
                address: address.to_string(),
                cert: None,
                key: None,
            })
            .map_err(|error| unavailable(format!("Could not prepare Space identity: {error}")))?;
        let space_name = match names.space {
            Some(name) => client.space_rename(name).map_err(unavailable)?.name,
            None => identity.space_name,
        };
        if let Some(owner) = names.owner {
            client.space_rename_member(owner).map_err(unavailable)?;
        }
        let project_id = crate::identity::stable_entity_id(&identity.space_id, "host-project");
        let applied = client
            .workspace_apply(
                None,
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: crate::runtime::fresh_operation_id()?,
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: ProjectWorkspaceIntent::CreateProject {
                        project_id: project_id.clone(),
                        name: project_name,
                        description: String::new(),
                        appearance: None,
                        source_roots: repositories.keys().cloned().collect(),
                        page_key_prefix: None,
                    },
                },
            )
            .map_err(crate::runtime::map_client_error)?;
        if let nodex_core_protocol::ResponseEnvelope::Error(error) = applied.0 {
            return Err(crate::runtime::map_core_error(error));
        }
        let config = HostConfiguration {
            repositories,
            version: 1,
            space_id: identity.space_id.clone(),
            owner_member_id: identity.owner_member_id.clone(),
            address,
            execution_home,
            agent_runner: None,
        };
        private_fs::write(
            home.join("host.json"),
            serde_json::to_vec_pretty(&config)
                .map_err(unavailable)?
                .as_slice(),
        )
        .map_err(unavailable)?;
        Ok(HostInitResult {
            home: home.clone(),
            space_id: identity.space_id,
            owner_member_id: identity.owner_member_id,
            project_id,
            name: space_name,
            fingerprint: identity.fingerprint,
            execution_home: config.execution_home,
        })
    })();
    let stopped = (|| {
        let response = client
            .shutdown()
            .map_err(|error| unavailable(format!("Could not stop initialized Core: {error}")))?;
        if response.status != nodex_core_protocol::ShutdownStatus::Draining {
            return Err(unavailable("Initialized Core is still busy"));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let descriptor = home.join("run/core/core.json");
        while descriptor.try_exists().map_err(unavailable)? {
            if private_json(&descriptor)
                .ok()
                .and_then(|value| value["start_nonce"].as_str().map(str::to_owned))
                .as_deref()
                != Some(client.descriptor.start_nonce.as_str())
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err(unavailable("Initialized Core did not finish stopping"));
            }
            thread::sleep(Duration::from_millis(25));
        }
        Ok(())
    })();
    result.and_then(|value| stopped.map(|_| value))
}

fn hold_lock(home: &Path, instance: &str, parent_pid: u32) -> Result<CommandOutput, CliError> {
    if instance.len() < 16
        || instance.len() > 64
        || !instance
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || parent_pid == 0
    {
        return Err(invalid("Invalid Host lease identity"));
    }
    let path = home.join("run/host.lock");
    if path.try_exists().map_err(unavailable)? {
        private_fs::checked_metadata(&path, EntryKind::File, Some(0o600)).map_err(unavailable)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(unavailable)?;
    file.try_lock_exclusive()
        .map_err(|_| invalid("Another Host already owns this Space"))?;
    file.set_len(0).map_err(unavailable)?;
    file.write_all(
        json!({ "instance": instance, "pid": parent_pid })
            .to_string()
            .as_bytes(),
    )
    .map_err(unavailable)?;
    file.sync_all().map_err(unavailable)?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{{\"locked\":true}}").map_err(unavailable)?;
    stdout.flush().map_err(unavailable)?;
    let _ = io::stdin()
        .lock()
        .take(1)
        .read(&mut [0])
        .map_err(unavailable)?;
    drop(file);
    Ok(CommandOutput::Bytes(Vec::new()))
}

fn status(home: &Path) -> Result<HostStatus, CliError> {
    let lock_path = home.join("run/host.lock");
    if !lock_path.try_exists().map_err(unavailable)? {
        return Ok(HostStatus::default());
    }
    private_fs::checked_metadata(&lock_path, EntryKind::File, Some(0o600)).map_err(unavailable)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(unavailable)?;
    match file.try_lock_exclusive() {
        Ok(()) => return Ok(HostStatus::default()),
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
        Err(error) => return Err(unavailable(error)),
    }
    let lease = private_json(&lock_path)?;
    let descriptor = match private_json(&home.join("run/host.json")) {
        Ok(value) => value,
        Err(_) => {
            return Ok(HostStatus {
                state: HostState::Starting,
                ..Default::default()
            });
        }
    };
    if descriptor["instance"] != lease["instance"] || descriptor["pid"] != lease["pid"] {
        return Ok(HostStatus {
            state: HostState::Starting,
            ..Default::default()
        });
    }
    let client = match CoreClient::connect(home, "nodex-host-status") {
        Ok(client) => client,
        Err(_) => {
            return Ok(HostStatus {
                state: HostState::Unavailable,
                ..Default::default()
            });
        }
    };
    if descriptor["coreGeneration"].as_str() != Some(client.descriptor.start_nonce.as_str()) {
        return Ok(HostStatus {
            state: HostState::Unavailable,
            ..Default::default()
        });
    }
    serde_json::from_value(descriptor).map_err(unavailable)
}

fn host_launch() -> Result<(PathBuf, PathBuf), CliError> {
    if env::var("NODE_ENV").as_deref() == Ok("test")
        && let (Some(binary), Some(entry)) = (
            env::var_os("NODEX_TEST_HOST_ELECTRON"),
            env::var_os("NODEX_TEST_HOST_ENTRY"),
        )
    {
        return Ok((PathBuf::from(binary), PathBuf::from(entry)));
    }
    let executable = env::current_exe().map_err(unavailable)?;
    let resources = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| unavailable("Cannot locate Host resources"))?;
    let entry = resources.join("app.asar.unpacked/out/main/serve.js");
    let binary = if cfg!(target_os = "macos") {
        resources.parent().unwrap_or(resources).join("MacOS/Nodex")
    } else if cfg!(windows) {
        resources.parent().unwrap_or(resources).join("Nodex.exe")
    } else {
        resources.parent().unwrap_or(resources).join("nodex")
    };
    if binary.is_file() && entry.is_file() {
        return Ok((binary, entry));
    }
    Err(unavailable(
        "The bundled headless Host is unavailable; use a packaged Nodex installation",
    ))
}

fn start(
    home: &Path,
    config: &HostConfiguration,
    foreground: bool,
    allow_same_user_agents: bool,
) -> Result<CommandOutput, CliError> {
    if !config.address.ip().is_loopback()
        && config.agent_runner.is_none()
        && !allow_same_user_agents
    {
        return Err(invalid(
            "Listening beyond loopback requires agentRunner or --allow-same-user-agents",
        ));
    }
    let (binary, entry) = host_launch()?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(unavailable)?;
    let instance = hex::encode(bytes);
    let mut command = Command::new(binary);
    command
        .arg(entry)
        .arg("--home")
        .arg(home)
        .arg("--instance")
        .arg(&instance)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("NODEX_AGENT_ENDPOINT")
        .env_remove("NODEX_AGENT_CREDENTIAL")
        .env_remove("NODEX_AGENT_ATTRIBUTION");
    if allow_same_user_agents {
        command.arg("--allow-same-user-agents");
    }
    if foreground {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // The service manager must signal the process that owns the Host Scope.
            return Err(unavailable(command.exec()));
        }
        #[cfg(not(unix))]
        {
            let code = command.status().map_err(unavailable)?;
            if !code.success() {
                return Err(unavailable(format!("Host exited with {code}")));
            }
            return output(status(home)?);
        }
    }
    let logs = home.join("logs");
    private_fs::create_dir_all(&logs).map_err(unavailable)?;
    let log = logs.join("host.log");
    if log.try_exists().map_err(unavailable)? {
        private_fs::checked_metadata(&log, EntryKind::File, Some(0o600)).map_err(unavailable)?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log)
        .map_err(unavailable)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(unavailable)?))
        .stderr(Stdio::from(log));
    let mut child = process::spawn_detached(&mut command).map_err(unavailable)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some(code) = child.try_wait().map_err(unavailable)? {
            return Err(unavailable(format!(
                "Host exited with {code}; inspect logs/host.log"
            )));
        }
        if let Ok(value) = status(home)
            && value.running
            && value.instance.as_deref() == Some(instance.as_str())
        {
            return output(value);
        }
        if Instant::now() >= deadline {
            return Err(unavailable(
                "Host readiness timed out; inspect logs/host.log",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}
