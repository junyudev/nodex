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
/// How this OS account names its person: the full name it records, else its login name.
pub fn account_display_name() -> Option<String> {
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found = std::ptr::null_mut();
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: every pointer refers to a live, writable value sized as passed; the strings it
    // returns point into `buffer`, which outlives the reads below.
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        return None;
    }
    // SAFETY: a successful lookup initialized the entry.
    let entry = unsafe { entry.assume_init() };
    let field = |value: *const libc::c_char| {
        // SAFETY: non-null passwd fields are NUL-terminated strings inside `buffer`.
        (!value.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(value) }.to_string_lossy())
    };
    field(entry.pw_gecos)
        .and_then(|gecos| gecos.split(',').next().map(str::trim).map(str::to_owned))
        .filter(|name| !name.is_empty())
        .or_else(|| field(entry.pw_name).map(|name| name.trim().to_owned()))
        .filter(|name| !name.is_empty())
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
/// The start time of the process running under `pid`; a zombie has ended.
/// macOS reports microseconds since the epoch.
#[cfg(target_os = "macos")]
pub(super) fn process_start(pid: u32) -> io::Result<Option<u64>> {
    let Some(pid) = libc::c_int::try_from(pid).ok().filter(|pid| *pid > 0) else {
        return Ok(None);
    };
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the kernel writes at most `size` bytes into the zeroed buffer.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written <= 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(None),
            _ => Err(error),
        };
    }
    if written != size {
        return Err(io::Error::other("process information is incomplete"));
    }
    // SAFETY: the kernel filled the complete, plain-data structure.
    let info = unsafe { info.assume_init() };
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }
    Ok(Some(
        info.pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    ))
}

/// The start time of the process running under `pid`; a zombie has ended.
/// Linux reports clock ticks since boot.
#[cfg(target_os = "linux")]
pub(super) fn process_start(pid: u32) -> io::Result<Option<u64>> {
    if pid == 0 {
        return Ok(None);
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => proc_stat_start(&stat).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "process status is malformed")
        }),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// `/proc/<pid>/stat` fields follow the parenthesized command name, which may
/// itself contain spaces and parentheses: state is field 3, start time field 22.
#[cfg(any(target_os = "linux", test))]
fn proc_stat_start(stat: &str) -> Option<Option<u64>> {
    let (_, fields) = stat.rsplit_once(')')?;
    let mut fields = fields.split_ascii_whitespace();
    let state = fields.next()?;
    let started = fields.nth(18)?.parse().ok()?;
    Some((!matches!(state, "Z" | "X")).then_some(started))
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
mod process_start_tests {
    #[test]
    fn an_unreaped_zombie_has_ended() {
        let child = std::process::Command::new("true").spawn().unwrap();
        let pid = rustix::process::Pid::from_child(&child);
        rustix::process::waitid(
            rustix::process::WaitId::Pid(pid),
            rustix::process::WaitIdOptions::EXITED | rustix::process::WaitIdOptions::NOWAIT,
        )
        .unwrap();
        assert_eq!(super::process_start(child.id()).unwrap(), None);
        let mut child = child;
        child.wait().unwrap();
    }

    #[test]
    fn linux_status_fields_are_counted_after_the_command_name() {
        let running =
            "4242 (node (x) 1) S 1 4242 4242 0 -1 4194560 7 0 0 0 1 2 0 0 20 0 11 0 98765 1 2 3";
        assert_eq!(super::proc_stat_start(running), Some(Some(98765)));
        let zombie = "4242 (node) Z 1 4242 4242 0 -1 4194560 7 0 0 0 1 2 0 0 20 0 1 0 98765 0 0";
        assert_eq!(super::proc_stat_start(zombie), Some(None));
        assert_eq!(super::proc_stat_start("4242 (truncated) S 1 2"), None);
    }
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
