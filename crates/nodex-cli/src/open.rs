use std::path::Path;
use std::process::Command;

use nodex_core_contracts::database::{DatabaseRead, DatabaseReadValue, DatabaseViewRecord};
use nodex_core_contracts::library::{LibraryRead, LibraryReadValue};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;

use crate::cli::OpenResourceArgs;
use crate::deeplink::{NodexDeepLinkKind, build};
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, resolve_page_selector, selected_project, unwrap_database, unwrap_library,
};
use crate::view::resolve_view_selector;

const OPEN_RESULT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
enum LaunchStatus {
    NotRequested,
    Launched,
    Unsupported,
}

#[derive(Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenLaunchResult {
    status: LaunchStatus,
    platform: &'static str,
}

#[derive(Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenResourceIdentity {
    kind: &'static str,
    id: String,
}

#[derive(Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenResult {
    schema_version: u32,
    resource: OpenResourceIdentity,
    url: String,
    launch: OpenLaunchResult,
}

pub(crate) fn page(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: OpenResourceArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, &arguments.resource)?;
    let snapshot = unwrap_library(client.library_read(
        Some(&project.id),
        LibraryRead::PageContent {
            page_id: page_id.clone(),
        },
    ))?;
    let LibraryReadValue::PageContent { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page open validation"));
    };
    if value.page_id != page_id {
        return Err(internal("Core Page open validation escaped its identity"));
    }
    open(
        NodexDeepLinkKind::Page,
        "page",
        page_id,
        arguments.print_only,
        json_output,
    )
}

pub(crate) fn view(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: OpenResourceArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let view_id = resolve_view_selector(client, &project, &arguments.resource)?;
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::View {
            view_id: view_id.clone(),
        },
    ))?;
    let DatabaseReadValue::View { value } = snapshot.value else {
        return Err(internal("Core returned the wrong View open validation"));
    };
    validate_view_descriptor(&value, &view_id)?;
    open(
        NodexDeepLinkKind::View,
        "view",
        view_id,
        arguments.print_only,
        json_output,
    )
}

fn validate_view_descriptor(value: &DatabaseViewRecord, view_id: &str) -> Result<(), CliError> {
    if value.view_id != view_id {
        return Err(internal("Core View open validation escaped its identity"));
    }
    if value.lifecycle != "active" {
        return Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            "the requested Database View is not active",
        ));
    }
    Ok(())
}

fn open(
    kind: NodexDeepLinkKind,
    resource_kind: &'static str,
    id: String,
    print_only: bool,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let url = build(kind, &id)
        .ok_or_else(|| internal("validated Core identity cannot be encoded as a deep link"))?;
    let launch = launch(&url, print_only)?;
    let unsupported = launch.status == LaunchStatus::Unsupported;
    let result = OpenResult {
        schema_version: OPEN_RESULT_SCHEMA_VERSION,
        resource: OpenResourceIdentity {
            kind: resource_kind,
            id,
        },
        url: url.clone(),
        launch,
    };
    if json_output {
        return serde_json::to_value(result)
            .map(CommandOutput::Json)
            .map_err(internal);
    }
    if unsupported {
        return Ok(CommandOutput::Text(format!(
            "{url}\nLaunching nodex:// links is unsupported on {}.",
            std::env::consts::OS
        )));
    }
    Ok(CommandOutput::Text(url))
}

fn launch(url: &str, print_only: bool) -> Result<OpenLaunchResult, CliError> {
    let platform = std::env::consts::OS;
    if print_only {
        return Ok(OpenLaunchResult {
            status: LaunchStatus::NotRequested,
            platform,
        });
    }
    if platform != "macos" {
        return Ok(OpenLaunchResult {
            status: LaunchStatus::Unsupported,
            platform,
        });
    }
    run_launcher(Command::new("/usr/bin/open").arg(url))?;
    Ok(OpenLaunchResult {
        status: LaunchStatus::Launched,
        platform,
    })
}

// Launcher diagnostics belong to the CLI error envelope, never inherited process streams.
fn run_launcher(command: &mut Command) -> Result<(), CliError> {
    let output = command.output().map_err(|error| {
        CliError::new(
            CliErrorCode::OpenFailed,
            format!("Nodex could not launch the canonical deep link: {error}"),
        )
    })?;
    if output.status.success() {
        return Ok(());
    }
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    let diagnostic = diagnostic.trim();
    let detail = if diagnostic.is_empty() {
        String::new()
    } else {
        format!(": {diagnostic}")
    };
    Err(CliError::new(
        CliErrorCode::OpenFailed,
        format!(
            "Nodex deep-link launcher exited with {}{detail}",
            output.status
        ),
    ))
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_failure_is_captured_in_one_structured_error() {
        let error = run_launcher(Command::new("/bin/sh").args([
            "-c", "printf 'unstructured stdout'; printf 'missing handler\nretry unavailable\n' >&2; exit 7",
        ])).expect_err("failed injected launcher");
        assert_eq!(error.code, CliErrorCode::OpenFailed);
        assert!(error.message.contains("missing handler\nretry unavailable"));
        assert!(!error.message.contains("unstructured stdout"));
        let encoded = serde_json::to_string(&crate::error::ErrorEnvelope::new(&error))
            .expect("error envelope");
        assert_eq!(encoded.lines().count(), 1);
        let envelope: serde_json::Value =
            serde_json::from_str(&encoded).expect("parseable JSON error");
        assert_eq!(envelope["error"]["code"], "OPEN_FAILED");
    }

    #[test]
    fn print_mode_is_explicitly_non_launching() {
        assert_eq!(
            launch("nodex://views/view%3Aplanning", true).expect("print launch result"),
            OpenLaunchResult {
                status: LaunchStatus::NotRequested,
                platform: std::env::consts::OS,
            }
        );
    }
}
