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
