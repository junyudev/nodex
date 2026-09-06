use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::cli::ServiceCommand;

const ADAPTER_ENVIRONMENT: &str = "NODEX_SERVICE_ADAPTER";
const ADAPTER_BINARY: &str = "nodex-service";
const ADAPTER_BUNDLE: &str = "Nodex Service.app";
const ADAPTER_PROTOCOL_VERSION: u32 = 1;
const MAX_ADAPTER_OUTPUT_BYTES: usize = 64 * 1024;
const ADAPTER_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, utoipa::ToSchema)]
pub(crate) struct ServiceReport {
    pub version: u32,
    pub adapter: &'static str,
    pub platform: &'static str,
    pub supported: bool,
    pub status: String,
    pub selected_home: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdapterResponse {
    version: u32,
    adapter: String,
    supported: bool,
    status: String,
    #[serde(default)]
    configured_home: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

struct BoundedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

pub(crate) fn execute(command: ServiceCommand, home: &Path) -> ServiceReport {
    let adapter = resolve_adapter();
    execute_with_adapter(command, home, adapter.as_deref())
}

pub(crate) fn status(home: &Path) -> ServiceReport {
    execute(ServiceCommand::Status, home)
}

fn execute_with_adapter(
    command: ServiceCommand,
    home: &Path,
    adapter: Option<&Path>,
) -> ServiceReport {
    let selected_home = home.to_string_lossy().into_owned();
    let Some(adapter) = adapter else {
        return unavailable(
            selected_home,
            "the packaged macOS ServiceManagement adapter is unavailable",
        );
    };
    let metadata = match fs::symlink_metadata(adapter) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            metadata
        }
        Ok(_) => {
            return unavailable(
                selected_home,
                "the ServiceManagement adapter is not a regular file",
            );
        }
        Err(error) => {
            return unavailable(
                selected_home,
                format!("the ServiceManagement adapter could not be inspected: {error}"),
            );
        }
    };
    if metadata.len() == 0 {
        return unavailable(selected_home, "the ServiceManagement adapter is empty");
    }

    let response = match invoke_adapter(adapter, command, home) {
        Ok(response) => response,
        Err(message) => return unavailable(selected_home, message),
    };
    if response.version != ADAPTER_PROTOCOL_VERSION || response.adapter != "sm_app_service" {
        return unavailable(
            selected_home,
            "the ServiceManagement adapter returned an incompatible protocol",
        );
    }
    if !matches!(
        response.status.as_str(),
        "enabled"
            | "enabled_other_profile"
            | "disabled"
            | "requires_approval"
            | "unavailable"
            | "unsupported"
    ) {
        return unavailable(
            selected_home,
            "the ServiceManagement adapter returned an unknown status",
        );
    }
    ServiceReport {
        version: ADAPTER_PROTOCOL_VERSION,
        adapter: "sm_app_service",
        platform: env::consts::OS,
        supported: response.supported,
        status: response.status,
        selected_home,
        configured_home: response.configured_home,
        message: response.message,
    }
}

fn resolve_adapter() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os(ADAPTER_ENVIRONMENT).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    let executable = fs::canonicalize(env::current_exe().ok()?).ok()?;
    Some(default_adapter(&executable))
}

fn default_adapter(executable: &Path) -> PathBuf {
    if let Some(application) = executable
        .ancestors()
        .find(|ancestor| ancestor.extension() == Some(OsStr::new("app")))
    {
        return application
            .join("Contents/Helpers")
            .join(ADAPTER_BUNDLE)
            .join("Contents/MacOS")
            .join(ADAPTER_BINARY);
    }
    executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(ADAPTER_BINARY)
}

fn invoke_adapter(
    adapter: &Path,
    command: ServiceCommand,
    home: &Path,
) -> Result<AdapterResponse, String> {
    let mut child = Command::new(adapter)
        .arg(service_command_name(command))
        .arg("--home")
        .arg(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("the ServiceManagement adapter could not start: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "the ServiceManagement adapter stdout was unavailable".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "the ServiceManagement adapter stderr was unavailable".to_owned())?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let deadline = Instant::now() + ADAPTER_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("the ServiceManagement adapter timed out".to_owned());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "the ServiceManagement adapter could not be observed: {error}"
                ));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "the ServiceManagement adapter stdout reader failed".to_owned())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "the ServiceManagement adapter stderr reader failed".to_owned())??;
    if stdout.overflowed || stderr.overflowed {
        return Err("the ServiceManagement adapter exceeded its output limit".to_owned());
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr.bytes).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("the ServiceManagement adapter exited with {status}")
        } else {
            format!("the ServiceManagement adapter failed: {detail}")
        });
    }
    serde_json::from_slice(&stdout.bytes)
        .map_err(|error| format!("the ServiceManagement adapter returned invalid JSON: {error}"))
}

fn read_bounded(mut reader: impl Read) -> Result<BoundedOutput, String> {
    let mut bytes = Vec::new();
    let mut overflowed = false;
    let mut buffer = [0_u8; 4096];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("could not read ServiceManagement adapter output: {error}"))?;
        if count == 0 {
            return Ok(BoundedOutput { bytes, overflowed });
        }
        let remaining = MAX_ADAPTER_OUTPUT_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        overflowed |= count > remaining;
    }
}

fn service_command_name(command: ServiceCommand) -> &'static OsStr {
    OsStr::new(match command {
        ServiceCommand::Status => "status",
        ServiceCommand::Enable => "enable",
        ServiceCommand::Disable => "disable",
    })
}

fn unavailable(selected_home: String, message: impl Into<String>) -> ServiceReport {
    ServiceReport {
        version: ADAPTER_PROTOCOL_VERSION,
        adapter: "sm_app_service",
        platform: env::consts::OS,
        supported: false,
        status: "unavailable".to_owned(),
        selected_home,
        configured_home: None,
        message: Some(message.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn unavailable_adapter_is_a_latency_status_not_a_command_error() {
        let directory = tempdir().expect("profile");
        let report = execute_with_adapter(
            ServiceCommand::Enable,
            directory.path(),
            Some(&directory.path().join("missing")),
        );
        assert!(!report.supported);
        assert_eq!(report.status, "unavailable");
        assert_eq!(report.selected_home, directory.path().to_string_lossy());
        assert_eq!(
            fs::read_dir(directory.path()).expect("empty home").count(),
            0
        );
    }

    #[test]
    fn adapter_protocol_is_bounded_and_passes_the_selected_profile() {
        let directory = tempdir().expect("adapter");
        let adapter = directory.path().join("nodex-service");
        fs::write(
            &adapter,
            "#!/bin/sh\nprintf '{\"version\":1,\"adapter\":\"sm_app_service\",\"supported\":true,\"status\":\"enabled\",\"configured_home\":\"%s\",\"message\":null}' \"$3\"\n",
        )
        .expect("adapter fixture");
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).expect("executable");
        let profile = directory.path().join("profile");
        let report = execute_with_adapter(ServiceCommand::Status, &profile, Some(&adapter));
        assert!(report.supported);
        assert_eq!(report.status, "enabled");
        assert_eq!(
            report.configured_home.as_deref(),
            Some(profile.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn unknown_adapter_status_fails_closed() {
        let directory = tempdir().expect("adapter");
        let adapter = directory.path().join("nodex-service");
        fs::write(
            &adapter,
            "#!/bin/sh\nprintf '%s' '{\"version\":1,\"adapter\":\"sm_app_service\",\"supported\":true,\"status\":\"maybe\",\"configured_home\":null,\"message\":null}'\n",
        )
        .expect("adapter fixture");
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).expect("executable");
        let report = execute_with_adapter(ServiceCommand::Status, directory.path(), Some(&adapter));
        assert_eq!(report.status, "unavailable");
        assert!(!report.supported);
    }

    #[test]
    fn packaged_cli_resolves_the_nested_signed_controller() {
        let adapter = default_adapter(Path::new(
            "/Applications/Nodex.app/Contents/Resources/bin/nodex",
        ));
        assert_eq!(
            adapter,
            Path::new(
                "/Applications/Nodex.app/Contents/Helpers/Nodex Service.app/Contents/MacOS/nodex-service"
            )
        );
        assert_eq!(
            default_adapter(Path::new("/opt/nodex/bin/nodex")),
            Path::new("/opt/nodex/bin/nodex-service")
        );
    }
}
