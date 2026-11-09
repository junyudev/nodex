use crate::windows::{handle, process_sid, wide};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, STILL_ACTIVE, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::Console::FreeConsole;
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, WaitForSingleObject,
};
pub type UserIdentity = String;
pub const HOME_VARIABLE: &str = "USERPROFILE";
pub fn current_user() -> io::Result<UserIdentity> {
    process_sid(None)
}
pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match handle(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) }) {
        Ok(process) => unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_TIMEOUT },
        Err(error) => error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32),
    }
}
/// The creation time of the process running under `pid`, in 100 ns FILETIME units.
pub(super) fn process_start(pid: u32) -> io::Result<Option<u64>> {
    if pid == 0 {
        return Ok(None);
    }
    let process = match handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }) {
        Ok(process) => process,
        Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Any open handle keeps an exited process, and its PID, from being recycled.
    // An exit code equal to STILL_ACTIVE stays indistinguishable from running.
    if exit_code != STILL_ACTIVE as u32 {
        return Ok(None);
    }
    let mut times = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    let [created, exited, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(process.as_raw_handle(), created, exited, kernel, user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
    ))
}
pub fn free_space(path: &Path) -> io::Result<u64> {
    let mut available = 0;
    if unsafe { GetDiskFreeSpaceExW(wide(path)?.as_ptr(), &mut available, null_mut(), null_mut()) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}
pub(super) fn os_path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}
pub(super) fn detached(command: &mut Command) -> io::Result<Child> {
    let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    match command
        .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(child) => Ok(child),
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
            command.creation_flags(flags).spawn()
        }
        Err(error) => Err(error),
    }
}
/// Launchers detach and request job breakaway before creation. FreeConsole also
/// protects a Core invoked directly from a console without touching readiness stdout.
pub fn isolate_process() -> io::Result<()> {
    unsafe {
        FreeConsole();
    }
    Ok(())
}
pub async fn shutdown_signal() {
    use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_shutdown};
    let break_signal = async {
        match ctrl_break() {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    let close_signal = async {
        match ctrl_close() {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    let shutdown_signal = async {
        match ctrl_shutdown() {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, () = break_signal => {}, () = close_signal => {}, () = shutdown_signal => {} }
}
static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
unsafe extern "system" fn interrupt_handler(event: u32) -> i32 {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    if !matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
        return 0;
    }
    INTERRUPTED.store(true, std::sync::atomic::Ordering::Release);
    1
}
pub struct Interrupt;
impl Interrupt {
    pub fn new() -> io::Result<Self> {
        INTERRUPTED.store(false, std::sync::atomic::Ordering::Release);
        if unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(interrupt_handler), 1)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self)
    }
    pub fn pending(&mut self) -> bool {
        INTERRUPTED.swap(false, std::sync::atomic::Ordering::AcqRel)
    }
}
impl Drop for Interrupt {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(interrupt_handler), 0);
        }
    }
}
pub fn terminate_process(pid: u32) -> io::Result<()> {
    let process = handle(unsafe {
        OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    })?;
    if unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(process.as_raw_handle(), 1)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) }
        != windows_sys::Win32::Foundation::WAIT_OBJECT_0
    {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process did not exit after termination",
        ));
    }
    Ok(())
}
/// SQLite file URIs use UTF-8, slash separators and /C:/ drive roots.
pub fn uri_path_bytes(path: &Path) -> io::Result<Vec<u8>> {
    let path = path.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "file URI requires a Unicode path",
        )
    })?;
    let normalized = path
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!("//{path}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned())
        .replace('\\', "/");
    let normalized = if normalized.as_bytes().get(1) == Some(&b':') {
        format!("/{normalized}")
    } else {
        normalized
    };
    Ok(normalized.into_bytes())
}
pub fn application_install_roots(_home: &Path) -> Vec<std::path::PathBuf> {
    [
        std::env::var_os("ProgramFiles").map(std::path::PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(std::path::PathBuf::from),
        std::env::var_os("LOCALAPPDATA")
            .map(|path| std::path::PathBuf::from(path).join("Programs")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path| path.canonicalize().ok())
    .collect()
}
pub fn command_names(command: &str) -> Vec<String> {
    vec![
        command.into(),
        format!("{command}.exe"),
        format!("{command}.cmd"),
        format!("{command}.bat"),
    ]
}
/// Node cannot request job breakaway. Re-exec once through the native launcher,
/// retaining readiness pipes while the authority gets its own process/job lifetime.
pub fn bootstrap_detached() -> io::Result<Option<i32>> {
    const MARKER: &str = "NODEX_CORE_ISOLATED_LAUNCH";
    if std::env::var_os(MARKER).as_deref() == Some(std::ffi::OsStr::new("1")) {
        return Ok(None);
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(std::env::args_os().skip(1))
        .env(MARKER, "1")
        .stdin(std::process::Stdio::null());
    let status = detached(&mut command)?.wait()?;
    Ok(Some(status.code().unwrap_or(1)))
}

/// Launch the registered URI handler without a command shell or launcher error UI.
pub fn launch_desktop_uri(uri: &str) -> io::Result<bool> {
    let uri = uri.to_owned();
    std::thread::spawn(move || {
        use windows_sys::Win32::System::Com::{
            COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
        };
        use windows_sys::Win32::UI::Shell::{
            SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let status = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        if status < 0 {
            return Err(io::Error::other(format!(
                "Could not initialize the desktop URI launcher ({status:#x})"
            )));
        }
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let uri = crate::windows::wide(uri)?;
        let verb = crate::windows::wide("open")?;
        let mut information: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        information.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        information.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
        information.lpVerb = verb.as_ptr();
        information.lpFile = uri.as_ptr();
        information.nShow = SW_SHOWNORMAL;
        if unsafe { ShellExecuteExW(&mut information) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(true)
    })
    .join()
    .map_err(|_| io::Error::other("desktop URI launcher stopped unexpectedly"))?
}
