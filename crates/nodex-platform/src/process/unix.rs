use std::fs::File;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::{Child, Command};
pub type UserIdentity = u32;
pub const HOME_VARIABLE: &str = "HOME";
pub fn current_user() -> io::Result<UserIdentity> {
    Ok(rustix::process::geteuid().as_raw())
}
pub fn process_is_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    !matches!(
        rustix::process::test_kill_process(pid),
        Err(rustix::io::Errno::SRCH)
    )
}
pub fn free_space(path: &Path) -> io::Result<u64> {
    let stat = rustix::fs::statvfs(path)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}
pub(super) fn os_path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().as_bytes().to_vec()
}
pub(super) fn detached(command: &mut Command) -> io::Result<Child> {
    command.spawn()
}
pub fn isolate_process() -> io::Result<()> {
    if rustix::process::getsid(None)? != rustix::process::getpid() {
        rustix::process::setsid()?;
    }
    rustix::stdio::dup2_stdin(File::open("/dev/null")?)?;
    Ok(())
}
pub async fn shutdown_signal() {
    let terminate = async {
        let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return std::future::pending::<()>().await;
        };
        signal.recv().await;
    };
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, () = terminate => {} }
}
pub struct Interrupt(signal_hook::iterator::Signals);
impl Interrupt {
    pub fn new() -> io::Result<Self> {
        Ok(Self(signal_hook::iterator::Signals::new([
            signal_hook::consts::SIGINT,
        ])?))
    }
    pub fn pending(&mut self) -> bool {
        self.0
            .pending()
            .any(|signal| signal == signal_hook::consts::SIGINT)
    }
}
impl Drop for Interrupt {
    fn drop(&mut self) {
        self.0.handle().close();
    }
}
pub fn terminate_process(pid: u32) -> io::Result<()> {
    let pid = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid process id"))?;
    Ok(rustix::process::kill_process(
        pid,
        rustix::process::Signal::TERM,
    )?)
}
pub fn uri_path_bytes(path: &Path) -> io::Result<Vec<u8>> {
    Ok(os_path_bytes(path))
}
pub fn application_install_roots(home: &Path) -> Vec<std::path::PathBuf> {
    vec!["/Applications".into(), home.join("Applications")]
}
pub fn command_names(command: &str) -> Vec<String> {
    vec![command.into()]
}
pub fn bootstrap_detached() -> io::Result<Option<i32>> {
    Ok(None)
}

/// Dispatch an explicitly requested desktop URI; unsupported Unix desktops return false.
pub fn launch_desktop_uri(uri: &str) -> io::Result<bool> {
    if !cfg!(target_os = "macos") {
        return Ok(false);
    }
    captured_launcher(std::process::Command::new("/usr/bin/open").arg(uri))?;
    Ok(true)
}

fn captured_launcher(command: &mut std::process::Command) -> io::Result<()> {
    let output = command.output()?;
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
    Err(io::Error::other(format!(
        "Desktop URI launcher exited with {}{detail}",
        output.status
    )))
}

#[cfg(test)]
mod launcher_tests {
    #[test]
    fn failed_launch_diagnostics_are_captured_without_inheriting_process_streams() {
        let error = super::captured_launcher(std::process::Command::new("/bin/sh").args([
            "-c", "printf 'unstructured stdout'; printf 'missing handler\nretry unavailable\n' >&2; exit 7",
        ])).unwrap_err();
        let diagnostic = error.to_string();
        assert!(diagnostic.contains("missing handler\nretry unavailable"));
        assert!(!diagnostic.contains("unstructured stdout"));
    }
}
