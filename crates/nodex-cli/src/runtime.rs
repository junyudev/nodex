use std::collections::{BTreeMap, HashSet};
use std::env;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nodex_core_contracts::administration::{
    BackupTrigger, MaintenanceTask, StoreAdministrationContract, StoreAdministrationIntent,
    StoreAdministrationRead, StoreAdministrationReadValue,
};
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::database::{
    DatabaseIdentityTarget, DatabaseRead, DatabaseReadValue, DatabaseViewReadTarget,
};
use nodex_core_contracts::library::{
    LibraryCatalogKind, LibraryLifecycle, LibraryNavigationNode, LibraryNavigationParent,
    LibraryPageHistoryCursor, LibraryPageKeyTarget, LibraryPageOwnershipPath,
    LibraryPagePrepareKind, LibraryPageProjectionFileKind, LibraryPlacedResourceTarget,
    LibraryRead, LibraryReadValue, LibrarySearchSnapshotScope,
};
use nodex_core_contracts::workspace::{
    ProjectLifecycle, ProjectWorkspaceProject, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
};
use nodex_core_contracts::{
    CoreError, CoreErrorCode, ModuleApplyRequest, StoreEpoch, VersionedModuleContract,
};
use nodex_core_protocol::client::{ClientError, CoreClient, connect_or_launch};
use nodex_core_protocol::{
    DatabaseReadResponse, LibraryReadResponse, ProjectWorkspaceReadResponse, ResponseEnvelope,
    StoreAdministrationApplyResponse, StoreAdministrationReadResponse,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::cli::{
    BackupCommand, BlockArgs, BlockCommand, Cli, Command, DraftArgs, DraftCommand, HistoryArgs,
    OpenArgs, OpenCommand, PageArgs, PageCommand, PageTitleArgs, PageTitleCommand, PrepareKind,
    ProfileArgs, ProfileCloneArgs, ProfileCommand, ReadArgs, RgArgs, SedArgs, ServiceArgs,
    ViewArgs, ViewCommand,
};
use crate::error::{CliError, CliErrorCode};

#[derive(Clone, Debug)]
pub enum CommandOutput {
    Json(Value),
    Text(String),
    Bytes(Vec<u8>),
    Process { stdout: Vec<u8>, exit_status: i32 },
}

impl CommandOutput {
    pub fn exit_status(&self) -> i32 {
        match self {
            Self::Process { exit_status, .. } => *exit_status,
            _ => crate::EXIT_SUCCESS,
        }
    }

    pub fn write(self, json_output: bool) -> Result<(), CliError> {
        let mut stdout = io::stdout().lock();
        if json_output {
            let result = match self {
                Self::Json(value) => value,
                Self::Text(value) => Value::String(value),
                Self::Bytes(value) => Value::String(String::from_utf8(value).map_err(|_| {
                    CliError::new(
                        CliErrorCode::Internal,
                        "command returned non-UTF-8 bytes for JSON output",
                    )
                })?),
                Self::Process {
                    stdout,
                    exit_status,
                } => json!({
                    "stdout": String::from_utf8(stdout).map_err(|_| {
                        CliError::new(
                            CliErrorCode::Internal,
                            "command returned non-UTF-8 process output for JSON output",
                        )
                    })?,
                    "exit_status": exit_status,
                }),
            };
            serde_json::to_writer(
                &mut stdout,
                &json!({ "version": 1, "ok": true, "result": result }),
            )
            .map_err(internal)?;
            stdout.write_all(b"\n").map_err(internal)?;
            return Ok(());
        }

        self.write_human(&mut stdout)
    }

    fn write_human(self, writer: &mut impl Write) -> Result<(), CliError> {
        match self {
            Self::Bytes(value) => writer.write_all(&value).map_err(internal),
            Self::Json(value) => write_line_terminated(
                writer,
                serde_json::to_string_pretty(&value)
                    .map_err(internal)?
                    .as_bytes(),
            ),
            Self::Text(value) => write_line_terminated(writer, value.as_bytes()),
            Self::Process { stdout, .. } => writer.write_all(&stdout).map_err(internal),
        }
    }
}

fn write_line_terminated(writer: &mut impl Write, bytes: &[u8]) -> Result<(), CliError> {
    writer.write_all(bytes).map_err(internal)?;
    if bytes.ends_with(b"\n") {
        return Ok(());
    }
    writer.write_all(b"\n").map_err(internal)
}

pub fn execute(cli: Cli) -> Result<CommandOutput, CliError> {
    if matches!(&cli.command, Command::Capabilities) {
        return crate::agent_interface::capabilities().map(CommandOutput::Json);
    }
    if matches!(&cli.command, Command::Setup(_) | Command::Skills(_)) {
        reject_skill_scope_flags(&cli)?;
        return match cli.command {
            Command::Setup(arguments) => crate::skills::execute_setup(arguments, cli.json),
            Command::Skills(arguments) => crate::skills::execute_skills(arguments, cli.json),
            _ => unreachable!("guarded by the Skill command match"),
        };
    }
    if let Command::Profile(ProfileArgs {
        command: ProfileCommand::Clone(arguments),
    }) = &cli.command
    {
        reject_profile_clone_scope_flags(&cli)?;
        return clone_profile(arguments).map(CommandOutput::Json);
    }
    let cwd = env::current_dir().map_err(core_unavailable)?;
    match &cli.command {
        Command::Draft(DraftArgs {
            command: DraftCommand::Diff { directory },
        }) => return crate::draft::diff(directory),
        Command::Draft(DraftArgs {
            command: DraftCommand::Discard { directory },
        }) => return crate::draft::discard(directory),
        _ => {}
    }
    let home = resolve_home(&cwd)?;
    if let Command::Service(ServiceArgs { command }) = &cli.command {
        return serde_json::to_value(crate::service::execute(*command, &home))
            .map(CommandOutput::Json)
            .map_err(internal);
    }
    let client = connect_or_launch(
        &home,
        option_env!("NODEX_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
        None,
    )
    .map_err(map_client_error)?;
    validate_profile_selector(cli.profile.as_deref(), &client)?;

    match cli.command {
        Command::Context => context(
            &client,
            cli.project.as_deref(),
            cli.database.as_deref(),
            cli.page.as_deref(),
            &home,
            &cwd,
        ),
        Command::Read(arguments) => {
            read_page(&client, cli.project.as_deref(), &cwd, arguments, cli.json)
        }
        Command::Sed(arguments) => {
            sed_page(&client, cli.project.as_deref(), &cwd, arguments, cli.json)
        }
        Command::Rg(arguments) => rg_pages(
            &client,
            cli.project.as_deref(),
            cli.database.as_deref(),
            cli.page.as_deref(),
            &cwd,
            arguments,
        ),
        Command::History(arguments) => history(&client, cli.project.as_deref(), &cwd, arguments),
        Command::Patch(arguments) => crate::page_mutation::patch_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::View(ViewArgs {
            command: ViewCommand::Query(arguments),
        }) => crate::view::query(&client, cli.project.as_deref(), &cwd, arguments, cli.json),
        Command::Open(OpenArgs {
            command: OpenCommand::Page(arguments),
        }) => crate::open::page(&client, cli.project.as_deref(), &cwd, arguments, cli.json),
        Command::Open(OpenArgs {
            command: OpenCommand::View(arguments),
        }) => crate::open::view(&client, cli.project.as_deref(), &cwd, arguments, cli.json),
        Command::Page(PageArgs {
            command: PageCommand::Create(arguments),
        }) => crate::page_lifecycle::create_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::Move(arguments),
        }) => crate::page_lifecycle::move_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::Duplicate(arguments),
        }) => crate::page_lifecycle::duplicate_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::Delete(arguments),
        }) => crate::page_lifecycle::delete_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::File(arguments),
        }) => crate::page_files::execute(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments.command,
            cli.json,
        ),
        Command::File(arguments) => crate::files::execute(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments.command,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::Insert(arguments),
        }) => crate::page_mutation::insert_page_content(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command: PageCommand::Replace(arguments),
        }) => crate::page_mutation::replace_page(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Page(PageArgs {
            command:
                PageCommand::Title(PageTitleArgs {
                    command: PageTitleCommand::Set(arguments),
                }),
        }) => crate::page_mutation::set_page_title(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Block(BlockArgs {
            command: BlockCommand::Insert(arguments),
        }) => crate::page_mutation::insert_block(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Block(BlockArgs {
            command: BlockCommand::Update(arguments),
        }) => crate::page_mutation::update_block(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Block(BlockArgs {
            command: BlockCommand::Move(arguments),
        }) => crate::page_mutation::move_block(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Block(BlockArgs {
            command: BlockCommand::Delete(arguments),
        }) => crate::page_mutation::delete_block(
            &client,
            cli.project.as_deref(),
            &cwd,
            arguments,
            cli.json,
        ),
        Command::Tree { scope } => tree(
            &client,
            cli.project.as_deref(),
            cli.database.as_deref(),
            cli.page.as_deref(),
            scope.as_deref(),
            &cwd,
            cli.json,
        ),
        Command::Backup(backup) => match backup.command {
            BackupCommand::List => backup_list(&client),
            BackupCommand::Create { label, mutation } => {
                let operation_id = operation_id(mutation.idempotency_key.as_deref(), cli.json)?;
                backup_create(&client, operation_id, label)
            }
        },
        Command::Doctor(arguments) => doctor(
            &client,
            arguments.full,
            arguments.mutation.idempotency_key.as_deref(),
            cli.json,
        ),
        Command::Draft(DraftArgs {
            command: DraftCommand::Create { page, output },
        }) => crate::draft::create(&client, cli.project.as_deref(), &cwd, &page, &output),
        Command::Draft(DraftArgs {
            command: DraftCommand::Apply { directory },
        }) => crate::draft::apply(&client, cli.project.as_deref(), &cwd, &directory),
        _ => Err(CliError::new(
            CliErrorCode::InvalidInput,
            "this native CLI command is parsed but not implemented yet",
        )),
    }
}

fn clone_profile(arguments: &ProfileCloneArgs) -> Result<Value, CliError> {
    let backup = if arguments.backup == "latest" {
        nodex_core::administration::ProfileCloneBackupSelection::Latest
    } else {
        nodex_core::administration::ProfileCloneBackupSelection::Id(arguments.backup.clone())
    };
    let receipt = nodex_core::administration::materialize_profile_clone(
        nodex_core::administration::ProfileCloneRequest {
            source_profile_home: arguments.source.clone(),
            target_profile_home: arguments.target.clone(),
            backup,
        },
    )
    .map_err(map_profile_clone_error)?;
    serde_json::to_value(receipt).map_err(internal)
}

fn reject_profile_clone_scope_flags(cli: &Cli) -> Result<(), CliError> {
    if cli.profile.is_none()
        && cli.project.is_none()
        && cli.database.is_none()
        && cli.page.is_none()
    {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "profile clone does not accept Profile, Project, Database, or Page selectors",
    ))
}

fn map_profile_clone_error(error: nodex_core::infrastructure::sqlite::StoreError) -> CliError {
    let code = match error.code {
        nodex_core::infrastructure::sqlite::StoreErrorCode::AlreadyOwned
        | nodex_core::infrastructure::sqlite::StoreErrorCode::InvalidInput
        | nodex_core::infrastructure::sqlite::StoreErrorCode::InvalidProfile
        | nodex_core::infrastructure::sqlite::StoreErrorCode::NotFound
        | nodex_core::infrastructure::sqlite::StoreErrorCode::UnsupportedSchema => {
            CliErrorCode::InvalidInput
        }
        _ => CliErrorCode::Internal,
    };
    CliError::new(code, error.message)
}

fn reject_skill_scope_flags(cli: &Cli) -> Result<(), CliError> {
    if cli.profile.is_none()
        && cli.project.is_none()
        && cli.database.is_none()
        && cli.page.is_none()
    {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::InvalidInput,
        "global Agent Skill setup does not accept Profile, Project, Database, or Page scope",
    ))
}

fn rg_pages(
    client: &CoreClient,
    explicit_project: Option<&str>,
    explicit_database: Option<&str>,
    explicit_page: Option<&str>,
    cwd: &Path,
    arguments: RgArgs,
) -> Result<CommandOutput, CliError> {
    let invocation = crate::ripgrep::parse(arguments.arguments)?;
    if invocation.scope.is_some() && (explicit_database.is_some() || explicit_page.is_some()) {
        return Err(CliError::new(
            CliErrorCode::RgArgumentUnsupported,
            "the positional rg scope cannot be combined with --database or --page",
        ));
    }
    if explicit_database.is_some() && explicit_page.is_some() {
        return Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            "--database and --page select different rg scope kinds",
        ));
    }
    let project = selected_project(client, explicit_project, cwd)?;
    let scope = if let Some(selector) = invocation.scope.as_deref() {
        resolve_search_scope(client, &project, selector)?
    } else if let Some(selector) = explicit_page {
        LibrarySearchSnapshotScope::Page {
            page_id: resolve_page_scope(client, &project.id, selector)?,
        }
    } else if let Some(selector) = explicit_database {
        LibrarySearchSnapshotScope::Database {
            database_id: resolve_database_selector(client, &project, selector)?,
        }
    } else {
        LibrarySearchSnapshotScope::Database {
            database_id: project.database_id.clone(),
        }
    };
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::AcquireSearchSnapshot {
            scope,
            strict_materialization: true,
        },
    ))?;
    let LibraryReadValue::SearchSnapshotLease { value: lease } = snapshot.value else {
        return Err(internal("Core returned the wrong search snapshot lease"));
    };

    let searched = crate::ripgrep::run(&lease, &invocation);
    let released = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::ReleaseSearchSnapshot {
            lease_id: lease.lease_id.clone(),
        },
    ));
    match (searched, released) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(output), Ok(snapshot)) => {
            let LibraryReadValue::SearchSnapshotRelease { value } = snapshot.value else {
                return Err(internal("Core returned the wrong search snapshot release"));
            };
            if !value.released {
                return Err(CliError::new(
                    CliErrorCode::SnapshotExpired,
                    "Core search snapshot lease expired before release",
                ));
            }
            Ok(CommandOutput::Process {
                stdout: output.stdout,
                exit_status: output.exit_status,
            })
        }
    }
}

fn resolve_search_scope(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
) -> Result<LibrarySearchSnapshotScope, CliError> {
    if selector == "database" || selector.strip_prefix('@') == Some(project.database_id.as_str()) {
        return Ok(LibrarySearchSnapshotScope::Database {
            database_id: project.database_id.clone(),
        });
    }
    if let Some(data_source_id) = selector.strip_prefix("data_source:") {
        return Ok(LibrarySearchSnapshotScope::DataSource {
            data_source_id: stable_scope_id(data_source_id, "Data Source scope")?,
        });
    }
    let Some(identity) = selector.strip_prefix('@') else {
        return match resolve_content_selector(client, project, selector)? {
            ContentScope::Database { database_id } => {
                Ok(LibrarySearchSnapshotScope::Database { database_id })
            }
            ContentScope::Page { page_id } => Ok(LibrarySearchSnapshotScope::Page { page_id }),
        };
    };
    let page = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::PageLifecyclePreflight {
            page_id: identity.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageLifecyclePreflight { value } = page.value else {
        return Err(internal("Core returned the wrong Page scope preflight"));
    };
    if value.page.is_some_and(|page| page.lifecycle == "active") {
        return Ok(LibrarySearchSnapshotScope::Page {
            page_id: identity.to_owned(),
        });
    }
    let database = client
        .database_read(
            Some(&project.id),
            DatabaseRead::Database {
                target: DatabaseIdentityTarget::Database {
                    database_id: identity.to_owned(),
                },
            },
        )
        .map_err(map_client_error)?;
    match database.0 {
        ResponseEnvelope::Ok(snapshot) => {
            let DatabaseReadValue::Database { .. } = snapshot.value else {
                return Err(internal("Core returned the wrong Database scope snapshot"));
            };
            return Ok(LibrarySearchSnapshotScope::Database {
                database_id: identity.to_owned(),
            });
        }
        ResponseEnvelope::Error(error) if error.code == CoreErrorCode::NotFound => {}
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    }
    let source = client
        .database_read(
            Some(&project.id),
            DatabaseRead::DataSource {
                data_source_id: identity.to_owned(),
            },
        )
        .map_err(map_client_error)?;
    match source.0 {
        ResponseEnvelope::Ok(snapshot) => {
            let DatabaseReadValue::DataSource { .. } = snapshot.value else {
                return Err(internal(
                    "Core returned the wrong Data Source scope snapshot",
                ));
            };
            Ok(LibrarySearchSnapshotScope::DataSource {
                data_source_id: identity.to_owned(),
            })
        }
        ResponseEnvelope::Error(error) if error.code == CoreErrorCode::NotFound => {
            Err(CliError::new(
                CliErrorCode::ScopeNotFound,
                format!("no authorized Page, Database, or Data Source matches '{selector}'"),
            ))
        }
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn stable_scope_id(value: &str, label: &str) -> Result<String, CliError> {
    let value = value.strip_prefix('@').unwrap_or(value);
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} must contain one bounded stable identity"),
        ));
    }
    Ok(value.to_owned())
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ContentScope {
    Database { database_id: String },
    Page { page_id: String },
}

fn resolve_content_selector(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
) -> Result<ContentScope, CliError> {
    if selector.starts_with('@') {
        match resolve_page_scope(client, &project.id, selector) {
            Ok(page_id) => return Ok(ContentScope::Page { page_id }),
            Err(error) if error.code == CliErrorCode::ScopeNotFound => {}
            Err(error) => return Err(error),
        }
        return resolve_database_selector(client, project, selector)
            .map(|database_id| ContentScope::Database { database_id });
    }
    if selector.contains('/') {
        return resolve_page_selector(client, &project.id, selector)
            .map(|page_id| ContentScope::Page { page_id });
    }
    let database = resolve_database_selector(client, project, selector);
    let page = resolve_page_scope(client, &project.id, selector);
    match (database, page) {
        (Ok(database_id), Err(error)) if error.code == CliErrorCode::ScopeNotFound => {
            Ok(ContentScope::Database { database_id })
        }
        (Err(error), Ok(page_id)) if error.code == CliErrorCode::ScopeNotFound => {
            Ok(ContentScope::Page { page_id })
        }
        (Err(error), Ok(_)) => Err(error),
        (Ok(database_id), Ok(page_id)) => Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            format!("scope '{selector}' matches both Database @{database_id} and Page @{page_id}"),
        )),
        (Err(database_error), Err(page_error))
            if database_error.code == CliErrorCode::ScopeNotFound
                && page_error.code == CliErrorCode::ScopeNotFound =>
        {
            Err(CliError::new(
                CliErrorCode::ScopeNotFound,
                format!("no authorized Database or Page matches '{selector}'"),
            ))
        }
        (Err(error), _) if error.code != CliErrorCode::ScopeNotFound => Err(error),
        (_, Err(error)) => Err(error),
    }
}

fn resolve_database_selector(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
) -> Result<String, CliError> {
    if selector == "database" {
        return Ok(project.database_id.clone());
    }
    let explicit_identity = selector.starts_with('@');
    let identity = stable_scope_id(selector, "Database selector")?;
    if explicit_identity || identity == project.database_id || looks_like_uuid(&identity) {
        match read_database_name(client, &project.id, &identity) {
            Ok(_) => return Ok(identity),
            Err(error) if error.code == CliErrorCode::ScopeNotFound && !explicit_identity => {}
            Err(error) => return Err(error),
        }
    }

    let mut cursor = None;
    let mut matches = Vec::new();
    loop {
        let snapshot = unwrap_library(client.library_read(
            None,
            LibraryRead::Catalog {
                query: Some(selector.to_owned()),
                kinds: Some(vec![LibraryCatalogKind::Database]),
                lifecycle: Some(LibraryLifecycle::Active),
                cursor,
                limit: Some(100),
            },
        ))?;
        let LibraryReadValue::Catalog {
            items,
            next_cursor,
            has_more,
            ..
        } = snapshot.value
        else {
            return Err(internal(
                "Core returned the wrong Database catalog snapshot",
            ));
        };
        for item in items {
            if item.title != selector {
                continue;
            }
            let LibraryPlacedResourceTarget::Database { database_id } = item.target else {
                return Err(internal(
                    "Core Database catalog contained a non-Database target",
                ));
            };
            match read_database_name(client, &project.id, &database_id) {
                Ok(_) => matches.push(database_id),
                Err(error)
                    if matches!(
                        error.code,
                        CliErrorCode::ScopeNotFound | CliErrorCode::ScopeUnauthorized
                    ) => {}
                Err(error) => return Err(error),
            }
            if matches.len() > 10_000 {
                return Err(CliError::new(
                    CliErrorCode::ScopeBudgetExceeded,
                    "Database name resolution exceeds the 10000-candidate limit",
                ));
            }
        }
        if !has_more {
            break;
        }
        cursor = next_cursor;
        if cursor.is_none() {
            return Err(internal("Core Database catalog pagination has no cursor"));
        }
    }
    matches.sort();
    matches.dedup();
    match matches.as_slice() {
        [] => Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            format!("no authorized Database matches '{selector}'"),
        )),
        [database_id] => Ok(database_id.clone()),
        _ => Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            format!(
                "Database name '{selector}' matches multiple Databases: {}",
                matches.join(", ")
            ),
        )),
    }
}

fn looks_like_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn resolve_page_scope(
    client: &CoreClient,
    project_id: &str,
    selector: &str,
) -> Result<String, CliError> {
    let page_id = resolve_page_selector(client, project_id, selector)?;
    let snapshot = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageLifecyclePreflight {
            page_id: page_id.clone(),
        },
    ))?;
    let LibraryReadValue::PageLifecyclePreflight { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page scope preflight"));
    };
    if value.page.is_some_and(|page| page.lifecycle == "active") {
        return Ok(page_id);
    }
    Err(CliError::new(
        CliErrorCode::ScopeNotFound,
        format!("Page scope '@{page_id}' is unavailable"),
    ))
}

fn read_database_name(
    client: &CoreClient,
    project_id: &str,
    database_id: &str,
) -> Result<String, CliError> {
    let snapshot = unwrap_database(client.database_read(
        Some(project_id),
        DatabaseRead::Database {
            target: DatabaseIdentityTarget::Database {
                database_id: database_id.to_owned(),
            },
        },
    ))?;
    let DatabaseReadValue::Database { value } = snapshot.value else {
        return Err(internal(
            "Core returned the wrong Database selector snapshot",
        ));
    };
    Ok(value.database.name)
}

fn read_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: ReadArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    if arguments.view.is_some() && arguments.prepare != Some(PrepareKind::PageMove) {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "--view is only valid with --prepare page.move",
        ));
    }
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
    let file_kind = if arguments.meta {
        LibraryPageProjectionFileKind::MetaYaml
    } else {
        LibraryPageProjectionFileKind::BodyNestedMarkdown
    };
    let prepare = match arguments.prepare {
        Some(PrepareKind::TitleSet) => Some(LibraryPagePrepareKind::TitleSet),
        Some(PrepareKind::DocumentReplace) => Some(LibraryPagePrepareKind::DocumentReplace),
        Some(PrepareKind::PageDelete) => Some(LibraryPagePrepareKind::PageDelete),
        Some(PrepareKind::PageMove) => Some(LibraryPagePrepareKind::PageMove {
            view_id: arguments
                .view
                .as_deref()
                .map(|view| stable_scope_id(view, "--view"))
                .transpose()?,
        }),
        None => None,
    };
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::PageProjectionFile {
            page_id,
            file_kind,
            prepare,
        },
    ))?;
    let LibraryReadValue::PageProjectionFile { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page file snapshot"));
    };
    if json_output {
        return Ok(CommandOutput::Json(
            serde_json::to_value(value).map_err(internal)?,
        ));
    }
    Ok(CommandOutput::Bytes(value.content.into_bytes()))
}

fn sed_page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: SedArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let range = crate::sed::parse_program(&arguments.program)?;
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::PageProjectionFile {
            page_id,
            file_kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
            prepare: None,
        },
    ))?;
    let LibraryReadValue::PageProjectionFile { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page file snapshot"));
    };
    let selected = crate::sed::select_lines(&value.content, range);
    if json_output {
        return Ok(CommandOutput::Json(json!({
            "content": selected,
            "range": { "start": range.start, "end": range.end },
            "page_id": value.page_id,
            "page_key": value.page_key,
        })));
    }
    Ok(CommandOutput::Bytes(selected.into_bytes()))
}

fn history(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: HistoryArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, &arguments.page)?;
    let before = arguments
        .before
        .as_deref()
        .map(|value| {
            serde_json::from_str::<LibraryPageHistoryCursor>(value).map_err(|_| {
                CliError::new(
                    CliErrorCode::InvalidInput,
                    "history --before must be the JSON cursor emitted by a prior history result",
                )
            })
        })
        .transpose()?;
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::PageHistory {
            page_id,
            before,
            limit: arguments.limit,
        },
    ))?;
    let LibraryReadValue::PageHistory { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page history snapshot"));
    };
    Ok(CommandOutput::Json(
        serde_json::to_value(value).map_err(internal)?,
    ))
}

fn tree(
    client: &CoreClient,
    explicit_project: Option<&str>,
    explicit_database: Option<&str>,
    explicit_page: Option<&str>,
    positional_scope: Option<&str>,
    cwd: &Path,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let selection_count = [
        explicit_database.is_some(),
        explicit_page.is_some(),
        positional_scope.is_some(),
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count();
    if selection_count > 1 {
        return Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            "tree accepts only one positional, --database, or --page scope",
        ));
    }
    let scope = if let Some(selector) = positional_scope {
        resolve_content_selector(client, &project, selector)?
    } else if let Some(selector) = explicit_database {
        ContentScope::Database {
            database_id: resolve_database_selector(client, &project, selector)?,
        }
    } else if let Some(selector) = explicit_page {
        ContentScope::Page {
            page_id: resolve_page_scope(client, &project.id, selector)?,
        }
    } else {
        ContentScope::Database {
            database_id: project.database_id.clone(),
        }
    };
    let mut budget = TreeBudget::default();
    let root = match scope {
        ContentScope::Page { page_id } => {
            let page = read_page_tree_node(client, &project.id, &page_id, 0, &mut budget)?;
            TreeRoot::Page { page }
        }
        ContentScope::Database { database_id } => {
            let (name, pages) = database_tree(client, &project.id, &database_id, &mut budget)?;
            TreeRoot::Database {
                database_id,
                name,
                pages,
            }
        }
    };
    if json_output {
        return Ok(CommandOutput::Json(
            serde_json::to_value(root).map_err(internal)?,
        ));
    }
    let mut rendered = String::new();
    render_tree_root(&root, &mut rendered);
    Ok(CommandOutput::Text(rendered))
}

pub(crate) fn selected_project(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
) -> Result<ProjectWorkspaceProject, CliError> {
    let projects = read_all_projects(client, false)?;
    resolve_project(client, projects, explicit_project, cwd).map(|resolved| resolved.project)
}

fn read_all_projects(
    client: &CoreClient,
    include_archived: bool,
) -> Result<Vec<ProjectWorkspaceProject>, CliError> {
    let mut projects = Vec::new();
    let mut after = None;
    loop {
        let snapshot = unwrap_workspace(client.workspace_read(
            None,
            ProjectWorkspaceRead::ProjectWindow {
                include_archived: Some(include_archived),
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            },
        ))?;
        let ProjectWorkspaceReadValue::ProjectWindow { projects: window } = snapshot.value else {
            return Err(internal("Core returned the wrong Project window"));
        };
        projects.extend(window.items);
        after = window.next_cursor;
        if after.is_none() {
            return Ok(projects);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PageSelectorLookup {
    PageKey,
    TitlePath,
}

const PAGE_SELECTOR_LOOKUP_ORDER: [PageSelectorLookup; 2] =
    [PageSelectorLookup::PageKey, PageSelectorLookup::TitlePath];

fn canonical_page_selector(selector: &str) -> Result<Option<&str>, CliError> {
    if let Some(page_id) = selector.strip_prefix('@') {
        if !page_id.is_empty() && page_id.len() <= 512 && page_id.trim() == page_id {
            return Ok(Some(page_id));
        }
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "a canonical @Page selector must contain one bounded stable ID",
        ));
    }
    Ok(None)
}

pub(crate) fn resolve_page_selector(
    client: &CoreClient,
    project_id: &str,
    selector: &str,
) -> Result<String, CliError> {
    if let Some(page_id) = canonical_page_selector(selector)? {
        return Ok(page_id.to_owned());
    }
    for lookup in PAGE_SELECTOR_LOOKUP_ORDER {
        match lookup {
            PageSelectorLookup::PageKey => {
                if let Some(page_id) = resolve_page_key_selector(client, project_id, selector)? {
                    return Ok(page_id);
                }
                if selector.trim().starts_with('#') {
                    return Err(CliError::new(
                        CliErrorCode::InvalidInput,
                        "the explicit Page key was not found in this Project",
                    ));
                }
            }
            PageSelectorLookup::TitlePath => {
                return resolve_page_title_selector(client, project_id, selector);
            }
        }
    }
    Err(internal("Page selector resolution has no terminal lookup"))
}

fn resolve_page_key_selector(
    client: &CoreClient,
    project_id: &str,
    selector: &str,
) -> Result<Option<String>, CliError> {
    let key_target = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageKeyTarget {
            page_key: selector.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageKeyTarget { value: key_target } = key_target.value else {
        return Err(internal("Core returned the wrong Page-key target snapshot"));
    };
    page_key_target_selector_outcome(key_target)
}

fn page_key_target_selector_outcome(
    key_target: LibraryPageKeyTarget,
) -> Result<Option<String>, CliError> {
    match key_target {
        LibraryPageKeyTarget::NotFound => Ok(None),
        LibraryPageKeyTarget::Resolved { page_id, .. } => Ok(Some(page_id)),
        LibraryPageKeyTarget::Ambiguous => Err(CliError::new(
            CliErrorCode::InvalidInput,
            "the Page key is ambiguous; use its canonical hyphenated form (for example LAB-13) or an @Page ID",
        )),
    }
}

fn resolve_page_title_selector(
    client: &CoreClient,
    project_id: &str,
    selector: &str,
) -> Result<String, CliError> {
    let components = selector.split('/').collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 64
        || components
            .iter()
            .any(|component| component.is_empty() || component.len() > 4_096)
    {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "a Page title path must contain 1 to 64 non-empty bounded components",
        ));
    }
    let query = components.last().expect("non-empty selector");
    let mut cursor = None;
    let mut candidates = Vec::new();
    loop {
        let snapshot = unwrap_library(client.library_read(
            None,
            LibraryRead::Catalog {
                query: Some((*query).to_owned()),
                kinds: Some(vec![LibraryCatalogKind::Page]),
                lifecycle: Some(LibraryLifecycle::Active),
                cursor,
                limit: Some(100),
            },
        ))?;
        let LibraryReadValue::Catalog {
            items,
            next_cursor,
            has_more,
            ..
        } = snapshot.value
        else {
            return Err(internal("Core returned the wrong Page catalog snapshot"));
        };
        for item in items {
            if item.title != *query {
                continue;
            }
            let LibraryPlacedResourceTarget::Page { page_id } = item.target else {
                return Err(internal("Core Page catalog contained a non-Page target"));
            };
            candidates.push(page_id);
            if candidates.len() > 10_000 {
                return Err(CliError::new(
                    CliErrorCode::ScopeBudgetExceeded,
                    "Page title resolution exceeds the 10000-candidate limit",
                ));
            }
        }
        if !has_more {
            break;
        }
        cursor = next_cursor;
        if cursor.is_none() {
            return Err(internal("Core Page catalog pagination has no cursor"));
        }
    }
    let mut matches = Vec::new();
    for candidate in candidates {
        let content = match unwrap_library(client.library_read(
            Some(project_id),
            LibraryRead::PageContent {
                page_id: candidate.clone(),
            },
        )) {
            Ok(content) => content,
            Err(error)
                if matches!(
                    error.code,
                    CliErrorCode::ScopeNotFound | CliErrorCode::ScopeUnauthorized
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let LibraryReadValue::PageContent { value: content } = content.value else {
            return Err(internal("Core returned the wrong Page content snapshot"));
        };
        if content.title != *query {
            continue;
        }
        let ownership = unwrap_library(client.library_read(
            Some(project_id),
            LibraryRead::PageOwnershipPath {
                page_id: candidate.clone(),
            },
        ))?;
        let LibraryReadValue::PageOwnershipPath { value: Some(path) } = ownership.value else {
            continue;
        };
        let LibraryPageOwnershipPath::Available { ancestors, .. } = *path else {
            continue;
        };
        let mut titles = ancestors
            .into_iter()
            .map(|ancestor| ancestor.title)
            .collect::<Vec<_>>();
        titles.push(content.title);
        if titles
            .iter()
            .map(String::as_str)
            .eq(components.iter().copied())
        {
            matches.push(candidate);
        }
    }
    matches.sort();
    matches.dedup();
    match matches.as_slice() {
        [] => Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            format!("no authorized Page matches title path '{selector}'"),
        )),
        [page_id] => Ok(page_id.clone()),
        _ => Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            format!(
                "title path '{selector}' matches multiple Pages: {}",
                matches.join(", ")
            ),
        )),
    }
}

const MAX_TREE_DEPTH: usize = 64;
const MAX_TREE_NODES: usize = 10_000;

#[derive(Default)]
struct TreeBudget {
    commit_head: Option<i64>,
    nodes: usize,
    seen_pages: HashSet<String>,
}

impl TreeBudget {
    fn observe(&mut self, commit_head: i64) -> Result<(), CliError> {
        if self
            .commit_head
            .is_some_and(|expected| expected != commit_head)
        {
            return Err(CliError::new(
                CliErrorCode::EtagConflict,
                "Nodex changed while the tree was being assembled; retry the command",
            ));
        }
        self.commit_head = Some(commit_head);
        Ok(())
    }

    fn enter_page(&mut self, page_id: &str, depth: usize) -> Result<(), CliError> {
        if depth > MAX_TREE_DEPTH {
            return Err(CliError::new(
                CliErrorCode::ScopeBudgetExceeded,
                format!("Page tree exceeds the {MAX_TREE_DEPTH}-level depth limit"),
            ));
        }
        if self.nodes == MAX_TREE_NODES {
            return Err(CliError::new(
                CliErrorCode::ScopeBudgetExceeded,
                format!("Page tree exceeds the {MAX_TREE_NODES}-node limit"),
            ));
        }
        if !self.seen_pages.insert(page_id.to_owned()) {
            return Err(CliError::new(
                CliErrorCode::InvalidInput,
                format!("Page tree repeats or cycles through @{page_id}"),
            ));
        }
        self.nodes += 1;
        Ok(())
    }

    fn add_leaf(&mut self) -> Result<(), CliError> {
        if self.nodes == MAX_TREE_NODES {
            return Err(CliError::new(
                CliErrorCode::ScopeBudgetExceeded,
                format!("Page tree exceeds the {MAX_TREE_NODES}-node limit"),
            ));
        }
        self.nodes += 1;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TreeRoot {
    Database {
        database_id: String,
        name: String,
        pages: Vec<TreeNode>,
    },
    Page {
        page: TreeNode,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TreeNode {
    Page {
        page_id: String,
        title: String,
        children: Vec<TreeNode>,
    },
    Database {
        database_id: String,
        title: String,
    },
    Canvas {
        canvas_id: String,
        title: String,
    },
}

fn database_tree(
    client: &CoreClient,
    project_id: &str,
    database_id: &str,
    budget: &mut TreeBudget,
) -> Result<(String, Vec<TreeNode>), CliError> {
    let database = unwrap_database(client.database_read(
        Some(project_id),
        DatabaseRead::Database {
            target: DatabaseIdentityTarget::Database {
                database_id: database_id.to_owned(),
            },
        },
    ))?;
    budget.observe(database.commit_head)?;
    let DatabaseReadValue::Database { value: database } = database.value else {
        return Err(internal("Core returned the wrong Database tree descriptor"));
    };
    let name = database.database.name;
    let view_id = database
        .database
        .default_view_id
        .ok_or_else(|| internal("Core Database tree has no default View"))?;
    let mut pages = Vec::new();
    let mut cursor = None;
    loop {
        let window = unwrap_database(client.database_read(
            Some(project_id),
            DatabaseRead::ViewWindow {
                target: DatabaseViewReadTarget::View {
                    view_id: view_id.clone(),
                },
                window: CollectionWindowRequest {
                    after: cursor,
                    first: Some(200),
                },
                group_scope: None,
            },
        ))?;
        budget.observe(window.commit_head)?;
        let DatabaseReadValue::ViewWindow { value } = window.value else {
            return Err(internal("Core returned the wrong Database tree window"));
        };
        for row in value.rows.items {
            pages.push(read_page_tree_node(
                client,
                project_id,
                &row.page_id,
                0,
                budget,
            )?);
        }
        let Some(next_cursor) = value.rows.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok((name, pages))
}

fn read_page_tree_node(
    client: &CoreClient,
    project_id: &str,
    page_id: &str,
    depth: usize,
    budget: &mut TreeBudget,
) -> Result<TreeNode, CliError> {
    budget.enter_page(page_id, depth)?;
    let content = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageContent {
            page_id: page_id.to_owned(),
        },
    ))?;
    budget.observe(content.commit_head)?;
    let LibraryReadValue::PageContent { value: content } = content.value else {
        return Err(internal("Core returned the wrong Page tree content"));
    };
    let mut cursor = None;
    let mut children = Vec::new();
    loop {
        let snapshot = unwrap_library(client.library_read(
            Some(project_id),
            LibraryRead::Children {
                parent: LibraryNavigationParent::Page {
                    page_id: page_id.to_owned(),
                },
                cursor,
                limit: Some(100),
                force_include_target: None,
            },
        ))?;
        budget.observe(snapshot.commit_head)?;
        let LibraryReadValue::Children {
            items,
            next_cursor,
            has_more,
            ..
        } = snapshot.value
        else {
            return Err(internal("Core returned the wrong Page child snapshot"));
        };
        for child in items {
            match child {
                LibraryNavigationNode::Page { page_id, .. } => children.push(read_page_tree_node(
                    client,
                    project_id,
                    &page_id,
                    depth + 1,
                    budget,
                )?),
                LibraryNavigationNode::Database {
                    database_id, title, ..
                } => {
                    budget.add_leaf()?;
                    children.push(TreeNode::Database { database_id, title });
                }
                LibraryNavigationNode::Canvas {
                    canvas_id, title, ..
                } => {
                    budget.add_leaf()?;
                    children.push(TreeNode::Canvas { canvas_id, title });
                }
                LibraryNavigationNode::View { .. } => {
                    return Err(internal("a Page tree unexpectedly contained a View"));
                }
            }
        }
        if !has_more {
            break;
        }
        cursor = next_cursor;
        if cursor.is_none() {
            return Err(internal("Core Page child pagination has no cursor"));
        }
    }
    Ok(TreeNode::Page {
        page_id: content.page_id,
        title: content.title,
        children,
    })
}

fn render_tree_root(root: &TreeRoot, output: &mut String) {
    match root {
        TreeRoot::Database {
            database_id,
            name,
            pages,
        } => {
            output.push_str(&format!("Database {name} @{database_id}\n"));
            for page in pages {
                render_tree_node(page, 1, output);
            }
        }
        TreeRoot::Page { page } => render_tree_node(page, 0, output),
    }
}

fn render_tree_node(node: &TreeNode, depth: usize, output: &mut String) {
    output.push_str(&"  ".repeat(depth));
    match node {
        TreeNode::Page {
            page_id,
            title,
            children,
        } => {
            output.push_str(&format!("Page {title} @{page_id}\n"));
            for child in children {
                render_tree_node(child, depth + 1, output);
            }
        }
        TreeNode::Database { database_id, title } => {
            output.push_str(&format!("Database {title} @{database_id}\n"));
        }
        TreeNode::Canvas { canvas_id, title } => {
            output.push_str(&format!("Canvas {title} @{canvas_id}\n"));
        }
    }
}

fn context(
    client: &CoreClient,
    explicit_project: Option<&str>,
    explicit_database: Option<&str>,
    explicit_page: Option<&str>,
    home: &Path,
    cwd: &Path,
) -> Result<CommandOutput, CliError> {
    let projects = read_all_projects(client, false)?;
    let resolved = resolve_project(client, projects, explicit_project, cwd)?;
    let health = client.health().map_err(map_client_error)?;
    if explicit_database.is_some() && explicit_page.is_some() {
        return Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            "context accepts only one of --database or --page",
        ));
    }
    let primary_database_id = resolved.project.database_id.clone();
    let scope = if let Some(selector) = explicit_database {
        ContextScope {
            kind: "database",
            id: resolve_database_selector(client, &resolved.project, selector)?,
        }
    } else if let Some(selector) = explicit_page {
        ContextScope {
            kind: "page",
            id: resolve_page_scope(client, &resolved.project.id, selector)?,
        }
    } else {
        ContextScope {
            kind: "database",
            id: primary_database_id.clone(),
        }
    };
    let background_registration = crate::service::status(home);
    let value = serde_json::to_value(ContextOutput {
        profile: ContextProfile {
            id: client.handshake.generation.profile_id.clone(),
            library_id: client.handshake.library_id.clone(),
        },
        project: resolved.project,
        matched_by: resolved.matched_by,
        matched_root: resolved.matched_root,
        primary_database_id,
        scope,
        core: ContextCore {
            pid: client.handshake.generation.pid,
            build_id: client.handshake.artifact.build_id.clone(),
            transport_version: client.handshake.selected_transport_version,
            schema_version: client.handshake.schema_version,
            store_epoch: client.handshake.store_epoch.clone(),
            readiness: format!("{:?}", health.status).to_ascii_lowercase(),
        },
        background_registration: background_registration.status,
    })
    .map_err(internal)?;
    Ok(CommandOutput::Json(value))
}

fn backup_list(client: &CoreClient) -> Result<CommandOutput, CliError> {
    let mut items = Vec::new();
    let mut after = None;
    loop {
        let snapshot = unwrap_administration(client.administration_read(
            StoreAdministrationRead::Backups {
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            },
        ))?;
        let StoreAdministrationReadValue::Backups { backups, .. } = snapshot.value else {
            return Err(CliError::new(
                CliErrorCode::Internal,
                "Core returned the wrong backup window",
            ));
        };
        items.extend(backups.items);
        after = backups.next_cursor;
        if after.is_none() {
            break;
        }
    }
    Ok(CommandOutput::Json(json!({ "backups": items })))
}

fn backup_create(
    client: &CoreClient,
    operation_id: String,
    label: Option<String>,
) -> Result<CommandOutput, CliError> {
    let committed = unwrap_administration_apply(client.administration_apply(ModuleApplyRequest {
        contract_version: StoreAdministrationContract::VERSION,
        operation_id,
        store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
        intent: StoreAdministrationIntent::CreateBackup {
            label,
            include_assets: true,
            trigger: BackupTrigger::Manual,
        },
    }))?;
    Ok(CommandOutput::Json(
        serde_json::to_value(committed).map_err(internal)?,
    ))
}

fn doctor(
    client: &CoreClient,
    full: bool,
    idempotency_key: Option<&str>,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let maintenance = if full {
        let operation_id = operation_id(idempotency_key, json_output)?;
        Some(unwrap_administration_apply(client.administration_apply(
            ModuleApplyRequest {
                contract_version: StoreAdministrationContract::VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: StoreAdministrationIntent::RunMaintenance {
                    tasks: vec![
                        MaintenanceTask::IntegrityCheck,
                        MaintenanceTask::ForeignKeyCheck,
                    ],
                    block_retention_count: None,
                    work_token: None,
                },
            },
        ))?)
    } else {
        None
    };
    let status =
        unwrap_administration(client.administration_read(StoreAdministrationRead::Status))?;
    let health = client.health().map_err(map_client_error)?;
    Ok(CommandOutput::Json(json!({
        "status": status.value,
        "health": health,
        "maintenance": maintenance,
    })))
}

fn resolve_project(
    client: &CoreClient,
    projects: Vec<ProjectWorkspaceProject>,
    explicit: Option<&str>,
    cwd: &Path,
) -> Result<ResolvedProject, CliError> {
    if let Some(selector) = explicit {
        let matches = projects
            .into_iter()
            .filter(|project| project.id == selector || project.name == selector)
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [] => Err(CliError::new(
                CliErrorCode::ProjectNotFound,
                format!("no Project matches '{selector}'"),
            )),
            [project] => Ok(ResolvedProject {
                project: project.clone(),
                matched_by: "explicit",
                matched_root: None,
            }),
            _ => Err(CliError::new(
                CliErrorCode::ProjectAmbiguous,
                format!("multiple Projects are named '{selector}'"),
            )),
        };
    }

    let cwd = cwd.canonicalize().map_err(core_unavailable)?;
    let mut source_candidates = Vec::new();
    let mut worktree_candidates = Vec::new();
    for project in projects {
        if project.lifecycle == ProjectLifecycle::Archived {
            continue;
        }
        for source in &project.sources {
            add_path_candidate(
                &mut source_candidates,
                &project,
                &cwd,
                &source.root,
                "source",
            );
        }
        let mut after = None;
        loop {
            let worktrees = unwrap_workspace(client.workspace_read(
                Some(&project.id),
                ProjectWorkspaceRead::ManagedWorktreeWindow {
                    project_id: Some(project.id.clone()),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(200),
                    },
                },
            ))?;
            let ProjectWorkspaceReadValue::ManagedWorktreeWindow { worktrees } = worktrees.value
            else {
                return Err(CliError::new(
                    CliErrorCode::Internal,
                    "Core returned the wrong managed-worktree window",
                ));
            };
            for worktree in worktrees.items {
                add_path_candidate(
                    &mut worktree_candidates,
                    &project,
                    &cwd,
                    &worktree.path,
                    "managed_worktree",
                );
            }
            after = worktrees.next_cursor;
            if after.is_none() {
                break;
            }
        }
    }
    let candidates = if worktree_candidates.is_empty() {
        source_candidates
    } else {
        worktree_candidates
    };
    select_path_candidate(candidates, &cwd)
}

fn select_path_candidate(
    candidates: Vec<ProjectCandidate>,
    cwd: &Path,
) -> Result<ResolvedProject, CliError> {
    let Some(maximum) = candidates.iter().map(|candidate| candidate.depth).max() else {
        return Err(CliError::new(
            CliErrorCode::ProjectNotFound,
            format!(
                "cwd {} is not inside a Project source or managed worktree",
                cwd.display()
            ),
        ));
    };
    let mut winners = candidates
        .into_iter()
        .filter(|candidate| candidate.depth == maximum)
        .fold(BTreeMap::new(), |mut winners, candidate| {
            winners
                .entry(candidate.project.id.clone())
                .or_insert(candidate);
            winners
        })
        .into_values()
        .collect::<Vec<_>>();
    if winners.len() != 1 {
        winners.sort_by(|left, right| left.project.id.cmp(&right.project.id));
        return Err(CliError::new(
            CliErrorCode::ProjectAmbiguous,
            format!(
                "cwd matches multiple Projects at the same root depth: {}",
                winners
                    .iter()
                    .map(|candidate| candidate.project.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    let winner = winners.pop().expect("one winner");
    Ok(ResolvedProject {
        project: winner.project,
        matched_by: winner.kind,
        matched_root: Some(winner.root),
    })
}

fn add_path_candidate(
    candidates: &mut Vec<ProjectCandidate>,
    project: &ProjectWorkspaceProject,
    cwd: &Path,
    root: &str,
    kind: &'static str,
) {
    let root = Path::new(root);
    if !root.is_absolute() {
        return;
    }
    let Ok(root) = root.canonicalize() else {
        return;
    };
    if !cwd.starts_with(&root) {
        return;
    }
    candidates.push(ProjectCandidate {
        project: project.clone(),
        root: root.to_string_lossy().into_owned(),
        kind,
        depth: root.components().count(),
    });
}

fn validate_profile_selector(selector: Option<&str>, client: &CoreClient) -> Result<(), CliError> {
    let Some(selector) = selector else {
        return Ok(());
    };
    if selector == client.handshake.generation.profile_id {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::ScopeNotFound,
        format!("the selected home does not contain Profile '{selector}'"),
    ))
}

fn resolve_home(cwd: &Path) -> Result<PathBuf, CliError> {
    crate::config::resolve_home(
        cwd,
        env::var_os("NODEX_HOME").as_deref(),
        env::var_os("HOME").as_deref(),
    )
}

pub(crate) fn operation_id(explicit: Option<&str>, json_output: bool) -> Result<String, CliError> {
    if let Some(explicit) = explicit {
        if explicit.is_empty() || explicit.len() > 512 {
            return Err(CliError::new(
                CliErrorCode::InvalidInput,
                "idempotency key must contain 1 to 512 bytes",
            ));
        }
        return Ok(explicit.to_owned());
    }
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| {
        CliError::new(
            CliErrorCode::Internal,
            format!("could not generate idempotency key: {error}"),
        )
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_millis();
    let key = format!("cli-{timestamp}-{}", hex::encode(random));
    if json_output {
        eprintln!(
            "{}",
            json!({ "version": 1, "diagnostic": "generated_idempotency_key", "value": key })
        );
    } else {
        eprintln!("idempotency key: {key}");
    }
    Ok(key)
}

fn unwrap_workspace(
    result: Result<ProjectWorkspaceReadResponse, ClientError>,
) -> Result<nodex_core_contracts::ModuleReadSnapshot<ProjectWorkspaceReadValue>, CliError> {
    match result.map_err(map_client_error)?.0 {
        ResponseEnvelope::Ok(snapshot) => Ok(snapshot),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

pub(crate) fn unwrap_library(
    result: Result<LibraryReadResponse, ClientError>,
) -> Result<nodex_core_contracts::ModuleReadSnapshot<LibraryReadValue>, CliError> {
    match result.map_err(map_client_error)?.0 {
        ResponseEnvelope::Ok(snapshot) => Ok(snapshot),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

pub(crate) fn unwrap_database(
    result: Result<DatabaseReadResponse, ClientError>,
) -> Result<nodex_core_contracts::ModuleReadSnapshot<DatabaseReadValue>, CliError> {
    match result.map_err(map_client_error)?.0 {
        ResponseEnvelope::Ok(snapshot) => Ok(snapshot),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn unwrap_administration(
    result: Result<StoreAdministrationReadResponse, ClientError>,
) -> Result<nodex_core_contracts::ModuleReadSnapshot<StoreAdministrationReadValue>, CliError> {
    match result.map_err(map_client_error)?.0 {
        ResponseEnvelope::Ok(snapshot) => Ok(snapshot),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn unwrap_administration_apply(
    result: Result<StoreAdministrationApplyResponse, ClientError>,
) -> Result<
    nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::administration::StoreAdministrationCommitValue,
        nodex_core_contracts::administration::StoreAdministrationReceipt,
    >,
    CliError,
> {
    match result.map_err(map_client_error)?.0 {
        ResponseEnvelope::Ok(committed) => Ok(committed),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

pub(crate) fn map_client_error(error: ClientError) -> CliError {
    match error {
        ClientError::ProtocolIncompatible(message) => {
            CliError::new(CliErrorCode::ProtocolIncompatible, message)
        }
        error => CliError::new(CliErrorCode::CoreUnavailable, error.to_string()),
    }
}

pub(crate) fn map_core_error(error: CoreError) -> CliError {
    let code = match error.code {
        CoreErrorCode::NotFound => CliErrorCode::ScopeNotFound,
        CoreErrorCode::Ambiguous => CliErrorCode::ScopeAmbiguous,
        CoreErrorCode::Unauthorized => CliErrorCode::ScopeUnauthorized,
        CoreErrorCode::ResourceExhausted => CliErrorCode::ScopeBudgetExceeded,
        CoreErrorCode::PatchNotFound => CliErrorCode::PatchNotFound,
        CoreErrorCode::PatchAmbiguous => CliErrorCode::PatchAmbiguous,
        CoreErrorCode::PatchOverlap => CliErrorCode::PatchOverlap,
        CoreErrorCode::IdempotencyKeyReused => CliErrorCode::IdempotencyKeyReused,
        CoreErrorCode::ProtectedOwnerDeletion => CliErrorCode::ProtectedOwnerDeletion,
        CoreErrorCode::MaterializationStale => CliErrorCode::MaterializationStale,
        CoreErrorCode::ProtocolIncompatible => CliErrorCode::ProtocolIncompatible,
        CoreErrorCode::CoreUnavailable => CliErrorCode::CoreUnavailable,
        CoreErrorCode::RevisionConflict
        | CoreErrorCode::GenerationConflict
        | CoreErrorCode::HeadConflict
        | CoreErrorCode::StaleStoreEpoch => CliErrorCode::EtagConflict,
        _ => CliErrorCode::InvalidInput,
    };
    CliError::new(code, error.message)
}

fn core_unavailable(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::CoreUnavailable, error.to_string())
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[derive(Serialize)]
struct ContextOutput {
    profile: ContextProfile,
    project: ProjectWorkspaceProject,
    matched_by: &'static str,
    matched_root: Option<String>,
    primary_database_id: String,
    scope: ContextScope,
    core: ContextCore,
    background_registration: String,
}

#[derive(Serialize)]
struct ContextProfile {
    id: String,
    library_id: String,
}

#[derive(Serialize)]
struct ContextScope {
    kind: &'static str,
    id: String,
}

#[derive(Serialize)]
struct ContextCore {
    pid: u32,
    build_id: String,
    transport_version: u32,
    schema_version: u32,
    store_epoch: String,
    readiness: String,
}

#[derive(Debug)]
struct ResolvedProject {
    project: ProjectWorkspaceProject,
    matched_by: &'static str,
    matched_root: Option<String>,
}

#[derive(Clone, Debug)]
struct ProjectCandidate {
    project: ProjectWorkspaceProject,
    root: String,
    kind: &'static str,
    depth: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::workspace::{ProjectAppearance, ProjectSource};
    use tempfile::tempdir;

    fn project(id: &str, name: &str, root: &Path) -> ProjectWorkspaceProject {
        ProjectWorkspaceProject {
            id: id.to_owned(),
            library_id: "library".to_owned(),
            database_id: format!("database-{id}"),
            default_database_view_id: Some(format!("view-{id}")),
            lifecycle: ProjectLifecycle::Active,
            binding_revision: 1,
            name: name.to_owned(),
            description: String::new(),
            appearance: ProjectAppearance::default(),
            sources: vec![ProjectSource {
                root: root.to_string_lossy().into_owned(),
                order: 0,
            }],
            primary_workspace_root: Some(root.to_string_lossy().into_owned()),
            pinned: false,
            pinned_order: None,
            created_at: "2026-07-20T00:00:00Z".to_owned(),
            updated_at: "2026-07-20T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn explicit_project_selection_is_unique_by_id_or_name() {
        let directory = tempdir().expect("root");
        let projects = [
            project("p1", "Docs", directory.path()),
            project("p2", "Docs", directory.path()),
        ];
        assert_eq!(
            projects
                .iter()
                .filter(|project| project.id == "p1" || project.name == "p1")
                .count(),
            1
        );
        assert_eq!(
            projects
                .iter()
                .filter(|project| project.id == "Docs" || project.name == "Docs")
                .count(),
            2
        );
    }

    #[test]
    fn page_selector_order_keeps_canonical_ids_first_and_titles_last() {
        assert_eq!(
            canonical_page_selector("@019b1000-1000-7000-8000-000000000002")
                .expect("canonical selector"),
            Some("019b1000-1000-7000-8000-000000000002")
        );
        assert!(canonical_page_selector("LAB-13").unwrap().is_none());
        assert_eq!(
            PAGE_SELECTOR_LOOKUP_ORDER,
            [PageSelectorLookup::PageKey, PageSelectorLookup::TitlePath]
        );
        assert_eq!(
            canonical_page_selector("@ ")
                .expect_err("invalid canonical selector")
                .code,
            CliErrorCode::InvalidInput
        );
    }

    #[test]
    fn ambiguous_page_key_selector_requires_a_canonical_key_or_page_id() {
        let error = page_key_target_selector_outcome(LibraryPageKeyTarget::Ambiguous)
            .expect_err("compact Page-key ambiguity");

        assert_eq!(error.code, CliErrorCode::InvalidInput);
        assert!(error.message.contains("canonical hyphenated form"));
    }

    #[test]
    fn path_candidates_use_component_boundaries_and_longest_depth() {
        let directory = tempdir().expect("root");
        let root = directory.path().join("project");
        let nested = root.join("packages/nested");
        let cwd = nested.join("src");
        std::fs::create_dir_all(&cwd).expect("nested cwd");
        let cwd = cwd.canonicalize().expect("canonical cwd");
        let root_project = project("root", "Root", &root);
        let nested_project = project("nested", "Nested", &nested);
        let mut candidates = Vec::new();
        add_path_candidate(
            &mut candidates,
            &root_project,
            &cwd,
            &root.to_string_lossy(),
            "source",
        );
        add_path_candidate(
            &mut candidates,
            &nested_project,
            &cwd,
            &nested.to_string_lossy(),
            "source",
        );
        let selected = select_path_candidate(candidates.clone(), &cwd).expect("deepest source");
        assert_eq!(selected.project.id, "nested");

        let sibling = directory.path().join("project-other");
        std::fs::create_dir_all(&sibling).expect("sibling");
        let before = candidates.len();
        add_path_candidate(
            &mut candidates,
            &root_project,
            &sibling.canonicalize().unwrap(),
            &root.to_string_lossy(),
            "source",
        );
        assert_eq!(candidates.len(), before);
    }

    #[test]
    fn managed_worktree_precedence_and_equal_depth_ambiguity_are_explicit() {
        let directory = tempdir().expect("root");
        let root = directory.path().join("workspace");
        let deep_source = root.join("managed/nested");
        let cwd = deep_source.join("src");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let cwd = cwd.canonicalize().expect("canonical cwd");
        let source_project = project("source", "Source", &deep_source);
        let worktree_project = project("worktree", "Worktree", &root);
        let mut sources = Vec::new();
        let mut worktrees = Vec::new();
        add_path_candidate(
            &mut sources,
            &source_project,
            &cwd,
            &deep_source.to_string_lossy(),
            "source",
        );
        add_path_candidate(
            &mut worktrees,
            &worktree_project,
            &cwd,
            &root.to_string_lossy(),
            "managed_worktree",
        );
        let candidates = if worktrees.is_empty() {
            sources
        } else {
            worktrees
        };
        let selected = select_path_candidate(candidates, &cwd).expect("worktree precedence");
        assert_eq!(selected.project.id, "worktree");
        assert_eq!(selected.matched_by, "managed_worktree");

        let second = project("worktree-2", "Worktree 2", &root);
        let mut tied = Vec::new();
        add_path_candidate(
            &mut tied,
            &worktree_project,
            &cwd,
            &root.to_string_lossy(),
            "managed_worktree",
        );
        add_path_candidate(
            &mut tied,
            &second,
            &cwd,
            &root.to_string_lossy(),
            "managed_worktree",
        );
        let error = select_path_candidate(tied, &cwd).expect_err("tie must not guess");
        assert_eq!(error.code, CliErrorCode::ProjectAmbiguous);
        assert!(error.message.contains("worktree"));
        assert!(error.message.contains("worktree-2"));
    }

    #[test]
    fn human_bytes_are_written_exactly_while_structured_output_gets_a_final_lf() {
        let mut bytes = Vec::new();
        CommandOutput::Bytes(Vec::new())
            .write_human(&mut bytes)
            .expect("empty exact output");
        assert!(bytes.is_empty());

        CommandOutput::Bytes(b"body without lf".to_vec())
            .write_human(&mut bytes)
            .expect("nonempty exact output");
        assert_eq!(bytes, b"body without lf");

        let mut text = Vec::new();
        CommandOutput::Text("status".to_owned())
            .write_human(&mut text)
            .expect("line-oriented output");
        assert_eq!(text, b"status\n");
    }
}
