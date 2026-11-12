use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

/// A separate Nodex or Core process owns its own Profile and Agent bindings.
pub fn clear_agent_shell_environment(command: &mut Command) -> &mut Command {
    for key in [
        "NODEX_AGENT_ENDPOINT",
        "NODEX_AGENT_CREDENTIAL",
        "NODEX_AGENT_SHELL",
        "NODEX_AGENT_PROFILE_HOME",
        "NODEX_CLI_TASK_ID",
        "CODEX_THREAD_ID",
        "CODEX_SESSION_ID",
    ] {
        command.env_remove(key);
    }
    command
}

/// One run of a process. Operating systems recycle PIDs, Windows within seconds,
/// so a PID alone never proves that the process which once held it still runs.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProcessInstance {
    pub pid: u32,
    /// The OS start time: opaque, nonzero, and fixed for the life of the process.
    pub started: u64,
}

impl ProcessInstance {
    /// The run that currently holds `pid`.
    pub fn of(pid: u32) -> io::Result<Self> {
        process_start(pid)?
            .map(|started| Self { pid, started })
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "no process runs under this PID")
            })
    }

    /// False only with proof that this run ended: nothing runs under its PID, or a
    /// process started at another time does. A process the OS will not describe
    /// counts as alive.
    pub fn is_alive(&self) -> bool {
        match process_start(self.pid) {
            Ok(Some(started)) => started == self.started,
            Ok(None) => false,
            Err(_) => true,
        }
    }
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(HOME_VARIABLE)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}
pub fn executable_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
/// Stable on this OS, including paths containing non-Unicode bytes/code units.
pub fn path_bytes(path: impl AsRef<Path>) -> Vec<u8> {
    os_path_bytes(path.as_ref())
}
pub fn spawn_detached(command: &mut Command) -> io::Result<Child> {
    detached(command)
}
