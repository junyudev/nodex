use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    fs::{File, OpenOptions},
    io::{self, Write},
    mem::{size_of, zeroed},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr::{null, null_mut},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME,
        HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, UNICODE_STRING, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Globalization::{CSTR_EQUAL, CompareStringOrdinal},
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFinalPathNameByHandleW, OPEN_EXISTING,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        LibraryLoader::{GetModuleHandleW, GetProcAddress},
        SystemInformation::GetTickCount,
        Threading::{
            CREATE_NO_WINDOW, GetProcessTimes, OpenProcess, PROCESS_NAME_NATIVE,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
            SYNCHRONIZATION_SYNCHRONIZE, TerminateProcess, WaitForSingleObject,
        },
    },
    UI::{
        Shell::CommandLineToArgvW,
        WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE},
    },
};

type Result<T> = std::result::Result<T, String>;
const EXIT_BUDGET: Duration = Duration::from_secs(45);

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn win_error(operation: &str, pid: u32) -> String {
    format!("{operation} pid={pid}: {}", io::Error::last_os_error())
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct Log {
    file: Option<File>,
    started: Instant,
    step: &'static str,
}
impl Log {
    // Diagnostics explain a failure; they never decide whether an update proceeds.
    fn write(&mut self, message: &str) {
        if let Some(file) = &mut self.file {
            let _ = writeln!(
                file,
                "maintenance elapsedMs={} step={} {message}",
                self.started.elapsed().as_millis(),
                self.step
            );
        }
    }
    fn stage(&mut self, step: &'static str) {
        self.step = step;
        self.write("started");
    }
}
struct Arguments {
    installation: PathBuf,
    helpers: PathBuf,
    installer_pid: u32,
    log: Option<PathBuf>,
}
fn arguments() -> Result<Arguments> {
    let mut values = std::env::args_os().skip(1);
    let mut installation = None;
    let mut helpers = None;
    let mut installer_pid = None;
    let mut log = None;
    while let Some(key) = values.next() {
        let value = values.next().ok_or("Missing maintenance argument value")?;
        match key.to_str() {
            Some("--installation-directory") => installation = Some(PathBuf::from(value)),
            Some("--helper-directory") => helpers = Some(PathBuf::from(value)),
            Some("--installer-pid") => {
                installer_pid = value
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|p| *p > 0)
            }
            Some("--log-path") => log = Some(PathBuf::from(value)),
            _ => return Err("Unknown maintenance argument".into()),
        }
    }
    Ok(Arguments {
        installation: installation.ok_or("Missing installation directory")?,
        helpers: helpers.ok_or("Missing helper directory")?,
        installer_pid: installer_pid.ok_or("Missing installer PID")?,
        log,
    })
}

// Resolve filesystem aliases and short names consistently for roots and images.
// The open root handle also prevents an alias from changing our termination scope.
struct Installation {
    _directory: Handle,
    prefix: Vec<u16>,
}
impl Installation {
    fn open(path: &Path) -> Result<Self> {
        let directory = unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if directory == INVALID_HANDLE_VALUE {
            return Err(win_error("CreateFileW installation", 0));
        }
        let directory = Handle(directory);
        let mut dos_path = vec![0; 32768];
        let size = unsafe {
            GetFinalPathNameByHandleW(directory.0, dos_path.as_mut_ptr(), dos_path.len() as u32, 0)
        } as usize;
        if size == 0 || size >= dos_path.len() {
            return Err(win_error("Resolve installation path", 0));
        }
        dos_path.truncate(size);
        if PathBuf::from(OsString::from_wide(&dos_path))
            .parent()
            .is_none()
        {
            return Err("Refusing a drive root as an installation".into());
        }
        let mut prefix = dos_path;
        while prefix.last() == Some(&(b'\\' as u16)) {
            prefix.pop();
        }
        prefix.push(b'\\' as u16);
        Ok(Self {
            _directory: directory,
            prefix,
        })
    }
    fn contains(&self, image: &[u16]) -> bool {
        image.len() > self.prefix.len()
            && unsafe {
                CompareStringOrdinal(
                    self.prefix.as_ptr(),
                    self.prefix.len() as i32,
                    image.as_ptr(),
                    self.prefix.len() as i32,
                    1,
                )
            } == CSTR_EQUAL
    }
}
struct Process {
    pid: u32,
    created: u64,
    handle: Handle,
    image: Vec<u16>,
}
impl Process {
    fn exited(&self) -> Result<bool> {
        match unsafe { WaitForSingleObject(self.handle.0, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(win_error("WaitForSingleObject", self.pid)),
        }
    }
    fn core(&self) -> bool {
        self.name().eq_ignore_ascii_case("nodex-core.exe")
    }
    fn name(&self) -> String {
        let start = self
            .image
            .iter()
            .rposition(|c| *c == b'\\' as u16)
            .map_or(0, |p| p + 1);
        String::from_utf16_lossy(&self.image[start..])
    }
    fn stop(&self, log: &mut Log) -> Result<()> {
        if self.exited()? {
            return Ok(());
        }
        if unsafe { TerminateProcess(self.handle.0, 0) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // Windows returns ACCESS_DENIED for a process terminating concurrently.
        // Retain its identity and require the exit signal; a live denied process
        // still fails the completion barrier before installation files can change.
        if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) || self.exited()? {
            log.write(&format!(
                "TerminateProcess pid={} win32={}; awaiting confirmed exit",
                self.pid,
                error.raw_os_error().unwrap_or_default()
            ));
            return Ok(());
        }
        Err(format!("TerminateProcess pid={}: {error}", self.pid))
    }
    fn command_line(&self) -> Result<Vec<u16>> {
        // Query only a verified Core handle, never the system-wide command lines.
        // Resolve dynamically: unsupported native information classes fail closed.
        type Query =
            unsafe extern "system" fn(HANDLE, i32, *mut std::ffi::c_void, u32, *mut u32) -> i32;
        let module = unsafe { GetModuleHandleW(wide("ntdll.dll").as_ptr()) };
        let address =
            unsafe { GetProcAddress(module, c"NtQueryInformationProcess".as_ptr().cast()) }
                .ok_or("NtQueryInformationProcess unavailable")?;
        let query: Query = unsafe { std::mem::transmute(address) };
        let mut buffer = vec![0usize; 16384];
        let mut length = 0;
        let status = unsafe {
            query(
                self.handle.0,
                60,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * size_of::<usize>()) as u32,
                &mut length,
            )
        };
        if status < 0 {
            return Err(format!(
                "Query process command line pid={} status={status:#x}",
                self.pid
            ));
        }
        let command = unsafe { &*buffer.as_ptr().cast::<UNICODE_STRING>() };
        let begin = command.Buffer as usize;
        let end = begin
            .checked_add(command.Length as usize)
            .ok_or("Invalid process command line length")?;
        let base = buffer.as_ptr() as usize;
        if command.Length % 2 != 0 || begin < base || end > base + buffer.len() * size_of::<usize>()
        {
            return Err("Invalid process command line buffer".into());
        }
        let text =
            unsafe { std::slice::from_raw_parts(command.Buffer, command.Length as usize / 2) }
                .to_vec();
        Ok(text)
    }
    fn arguments(&self) -> Result<Vec<OsString>> {
        let mut text = self.command_line()?;
        text.push(0);
        let mut count = 0;
        let argv = unsafe { CommandLineToArgvW(text.as_ptr(), &mut count) };
        if argv.is_null() {
            return Err(win_error("CommandLineToArgvW", self.pid));
        }
        let mut result = Vec::new();
        for i in 0..count as usize {
            let text = unsafe { *argv.add(i) };
            let mut size = 0;
            while unsafe { *text.add(size) } != 0 {
                size += 1;
            }
            result.push(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(text, size)
            }));
        }
        unsafe {
            LocalFree(argv.cast());
        }
        Ok(result)
    }
}
fn select_process(installation: &Installation, pid: u32, stop: bool) -> Result<Option<Process>> {
    let access = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZATION_SYNCHRONIZE;
    let requested = access | if stop { PROCESS_TERMINATE } else { 0 };
    let mut raw = unsafe { OpenProcess(requested, 0, pid) };
    if raw.is_null() && stop {
        raw = unsafe { OpenProcess(access, 0, pid) };
    }
    if raw.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(code)
                if code == ERROR_ACCESS_DENIED as i32 || code == ERROR_INVALID_PARAMETER as i32 =>
            {
                Ok(None)
            }
            _ => Err(format!("OpenProcess pid={pid}: {error}")),
        };
    }
    let handle = Handle(raw);
    let mut image = vec![0; 32768];
    let mut size = image.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(handle.0, PROCESS_NAME_NATIVE, image.as_mut_ptr(), &mut size)
    } == 0
    {
        // System processes without a readable executable cannot be selected.
        // Every selected image retains its verified handle through the exit barrier.
        return Ok(None);
    }
    image.truncate(size as usize);
    let mut physical = wide(r"\\?\GLOBALROOT");
    physical.pop();
    physical.extend(&image);
    physical.push(0);
    let file = unsafe {
        CreateFileW(
            physical.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    };
    if file == INVALID_HANDLE_VALUE {
        if installation.contains(&image) {
            return Err(win_error("Open process image", pid));
        }
        return Ok(None);
    }
    let file = Handle(file);
    image.resize(32768, 0);
    let length =
        unsafe { GetFinalPathNameByHandleW(file.0, image.as_mut_ptr(), image.len() as u32, 0) }
            as usize;
    if length == 0 || length >= image.len() {
        return Err(win_error("Resolve process image", pid));
    }
    image.truncate(length);
    if !installation.contains(&image) {
        return Ok(None);
    }
    let mut created: FILETIME = unsafe { zeroed() };
    let mut exited: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(win_error("GetProcessTimes", pid));
    }
    let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok(Some(Process {
        pid,
        created,
        handle,
        image,
    }))
}
fn inventory(installation: &Installation, installer_pid: u32, stop: bool) -> Result<Vec<Process>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(win_error("CreateToolhelp32Snapshot", 0));
    }
    let snapshot = Handle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut result = Vec::new();
    while next != 0 {
        let pid = entry.th32ProcessID;
        if pid != installer_pid
            && pid != std::process::id()
            && pid != 0
            && let Some(process) = select_process(installation, pid, stop)?
        {
            result.push(process);
        }
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if io::Error::last_os_error().raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(win_error("Process32 enumeration", 0));
    }
    Ok(result)
}

struct ShutdownClient {
    core_pid: u32,
    child: Child,
}
impl Drop for ShutdownClient {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
struct PreparedCore {
    home: OsString,
    executable: PathBuf,
}
fn prepare_core(process: &Process, helpers: &Path, log: &mut Log) -> Result<Option<PreparedCore>> {
    if process.exited()? {
        return Ok(None);
    }
    let args = match process.arguments() {
        Ok(args) => args,
        Err(_) if process.exited()? => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(index) = args.iter().position(|a| a == "--home") else {
        return Ok(None);
    };
    let home = args
        .get(index + 1)
        .ok_or("Core is missing its Profile argument")?
        .clone();
    if !Path::new(&home).is_absolute() {
        return Err("Core Profile must be absolute".into());
    }
    let executable = helpers.join(format!("nodex-core-maintenance-{}.exe", process.pid));
    log.write(&format!(
        "copying matching shutdown client pid={}",
        process.pid
    ));
    std::fs::copy(
        PathBuf::from(OsString::from_wide(&process.image)),
        &executable,
    )
    .map_err(|e| format!("Copy matching Core pid={}: {e}", process.pid))?;
    log.write(&format!("shutdown client copied pid={}", process.pid));
    Ok(Some(PreparedCore { home, executable }))
}
fn start_client(process: &Process, prepared: &PreparedCore) -> Result<ShutdownClient> {
    let child = Command::new(&prepared.executable)
        .args([
            OsStr::new("--shutdown"),
            OsStr::new("--home"),
            &prepared.home,
            OsStr::new("--expected-pid"),
            OsStr::new(&process.pid.to_string()),
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Start matching Core client pid={}: {e}", process.pid))?;
    Ok(ShutdownClient {
        core_pid: process.pid,
        child,
    })
}
unsafe extern "system" fn close_window(window: HWND, context: LPARAM) -> i32 {
    let selected = unsafe { &*(context as *const HashSet<u32>) };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    if selected.contains(&pid) {
        unsafe {
            PostMessageW(window, WM_CLOSE, 0, 0);
        }
    }
    1
}
fn maintain(args: &Arguments, log: &mut Log) -> Result<()> {
    if !args.installation.is_absolute() {
        return Err("Installation directory must be absolute".into());
    }
    if !args.installation.exists() {
        log.write("skipped: installation does not exist");
        return Ok(());
    }
    log.stage("native-boundary");
    let installation = Installation::open(&args.installation)?;
    log.write(&format!(
        "physical installation={}",
        OsString::from_wide(&installation.prefix).to_string_lossy()
    ));
    log.stage("inventory");
    let mut selected = inventory(&installation, args.installer_pid, true)?;
    log.write(&format!(
        "selected {} installation processes",
        selected.len()
    ));
    let mut prepared = HashMap::new();
    log.stage("core-client-copy");
    for process in selected.iter().filter(|p| p.core()) {
        if let Some(core) = prepare_core(process, &args.helpers, log)? {
            prepared.insert(process.pid, core);
        }
    }
    log.stage("desktop-close");
    let desktops: HashSet<_> = selected
        .iter()
        .filter(|p| p.name().eq_ignore_ascii_case("Nodex.exe"))
        .map(|p| p.pid)
        .collect();
    unsafe {
        EnumWindows(Some(close_window), &desktops as *const _ as LPARAM);
    }
    if !desktops.is_empty() {
        thread::sleep(Duration::from_millis(1500));
    }
    log.stage("desktop-stop");
    for process in &selected {
        if !prepared.contains_key(&process.pid) {
            process.stop(log)?;
        }
    }
    log.stage("core-shutdown");
    let mut clients = Vec::new();
    for process in &selected {
        if let Some(core) = prepared.get(&process.pid)
            && !process.exited()?
        {
            clients.push(start_client(process, core)?);
        }
    }
    // Startup, enumeration and copying are preparation, not failed shutdown.
    // Bound the actual exit wait collectively; never grant each process a new budget.
    let deadline = Instant::now() + EXIT_BUDGET;
    log.stage("exit-confirmation");
    loop {
        let fresh = inventory(&installation, args.installer_pid, true)?;
        let known: HashSet<_> = selected.iter().map(|p| (p.pid, p.created)).collect();
        for process in fresh
            .into_iter()
            .filter(|p| !known.contains(&(p.pid, p.created)))
        {
            if process.core() {
                if let Some(core) = prepare_core(&process, &args.helpers, log)? {
                    clients.push(start_client(&process, &core)?);
                    prepared.insert(process.pid, core);
                } else {
                    process.stop(log)?;
                }
            } else {
                process.stop(log)?;
            }
            selected.push(process);
        }
        let all_exited = selected.iter().try_fold(true, |complete, process| {
            process.exited().map(|exited| complete && exited)
        })?;
        if all_exited {
            break;
        }
        if Instant::now() >= deadline {
            let pending: Vec<_> = selected
                .iter()
                .filter(|p| !matches!(p.exited(), Ok(true)))
                .map(|p| p.pid)
                .collect();
            return Err(format!(
                "Installation processes did not exit within 45000 ms; pending={pending:?}"
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    for client in &mut clients {
        if let Some(status) = client.child.try_wait().map_err(|e| e.to_string())? {
            log.write(&format!(
                "shutdown client pid={} exit={status}",
                client.core_pid
            ));
        }
    }
    log.write("completed");
    Ok(())
}
pub fn run() -> Result<()> {
    let values: Vec<_> = std::env::args_os().skip(1).collect();
    if values.len() == 2 && values[0] == "--inspect" {
        return inspection(Path::new(&values[1]));
    }
    let args = arguments()?;
    let mut log = Log {
        file: args
            .log
            .as_ref()
            .and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok()),
        started: Instant::now(),
        step: "initialize",
    };
    log.write(&format!("started uptimeMs={}", unsafe { GetTickCount() }));
    let result = maintain(&args, &mut log);
    if let Err(error) = &result {
        log.write(&format!("failed: {error}"));
    }
    result
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionProcess {
    pid: u32,
    command_line: String,
    created_at: String,
}
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    processes: Vec<InspectionProcess>,
    listener_addresses: Vec<String>,
}

fn tcp_table(family: u32) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::ERROR_INSUFFICIENT_BUFFER,
        NetworkManagement::IpHelper::{GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER},
    };
    let mut size = 0;
    for _ in 0..4 {
        let mut buffer = vec![0u8; size as usize];
        let pointer = if buffer.is_empty() {
            null_mut()
        } else {
            buffer.as_mut_ptr().cast()
        };
        let result = unsafe {
            GetExtendedTcpTable(
                pointer,
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == 0 {
            buffer.truncate(size as usize);
            return Ok(buffer);
        }
        if result != ERROR_INSUFFICIENT_BUFFER || size > 16 * 1024 * 1024 {
            return Err(format!(
                "GetExtendedTcpTable family={family} win32={result}"
            ));
        }
    }
    Err("TCP listener table did not settle".into())
}
fn listener_addresses(pids: &HashSet<u32>) -> Result<Vec<String>> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID,
    };
    let mut addresses = HashSet::new();
    for family in [2, 23] {
        let table = tcp_table(family)?;
        if table.len() < 4 {
            return Err("Invalid TCP listener table".into());
        }
        let count = u32::from_ne_bytes(table[..4].try_into().unwrap()) as usize;
        let size = if family == 2 {
            size_of::<MIB_TCPROW_OWNER_PID>()
        } else {
            size_of::<MIB_TCP6ROW_OWNER_PID>()
        };
        let offset = if family == 2 {
            std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table)
        } else {
            std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table)
        };
        if offset > table.len() || count > (table.len() - offset) / size {
            return Err("Truncated TCP listener table".into());
        }
        for index in 0..count {
            let row = unsafe { table.as_ptr().add(offset + index * size) };
            if family == 2 {
                let row = unsafe { row.cast::<MIB_TCPROW_OWNER_PID>().read_unaligned() };
                if pids.contains(&row.dwOwningPid) {
                    addresses.insert(
                        std::net::Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()).to_string(),
                    );
                }
            } else {
                let row = unsafe { row.cast::<MIB_TCP6ROW_OWNER_PID>().read_unaligned() };
                if pids.contains(&row.dwOwningPid) {
                    addresses.insert(std::net::Ipv6Addr::from(row.ucLocalAddr).to_string());
                }
            }
        }
    }
    let mut addresses: Vec<_> = addresses.into_iter().collect();
    addresses.sort();
    Ok(addresses)
}
// Read-only probe support shares the exact installation boundary with maintenance.
fn inspection(path: &Path) -> Result<()> {
    let mut result = Inspection::default();
    if path.exists() {
        let installation = Installation::open(path)?;
        let processes = inventory(&installation, 0, false)?;
        let pids = processes.iter().map(|p| p.pid).collect();
        result.listener_addresses = listener_addresses(&pids)?;
        for process in processes {
            match process.command_line() {
                Ok(command) => result.processes.push(InspectionProcess {
                    pid: process.pid,
                    command_line: String::from_utf16_lossy(&command),
                    created_at: process.created.to_string(),
                }),
                Err(_) if process.exited()? => {}
                Err(error) => return Err(error),
            }
        }
    }
    serde_json::to_writer(io::stdout().lock(), &result).map_err(|e| e.to_string())
}
