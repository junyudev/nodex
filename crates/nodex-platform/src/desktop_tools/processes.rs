use super::files::invalid;
use crate::windows::{handle, wide};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    // Decimal FILETIME preserves all 64 bits across the JavaScript boundary.
    pub creation_time: String,
    pub image_path: String,
}

pub(crate) fn open_process(pid: u32, access: u32) -> io::Result<OwnedHandle> {
    handle(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | access | SYNCHRONIZE,
            0,
            pid,
        )
    })
}

fn exited(process: &OwnedHandle) -> io::Result<bool> {
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_TIMEOUT => Ok(false),
        WAIT_OBJECT_0 => Ok(true),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(crate) fn identify(pid: u32, process: &OwnedHandle) -> io::Result<ProcessIdentity> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let raw = process.as_raw_handle();
    if unsafe { GetProcessTimes(raw, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(raw, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if exited(process)? {
        return Err(io::Error::new(io::ErrorKind::NotFound, "process exited"));
    }
    Ok(ProcessIdentity {
        pid,
        image_path: String::from_utf16(&image[..length as usize]).map_err(io::Error::other)?,
        creation_time: ((u64::from(creation.dwHighDateTime) << 32)
            | u64::from(creation.dwLowDateTime))
        .to_string(),
    })
}

pub fn process_identity(pid: u32) -> io::Result<ProcessIdentity> {
    identify(pid, &open_process(pid, 0)?)
}

fn snapshot() -> io::Result<HashMap<u32, Vec<u32>>> {
    let snapshot = handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut children = HashMap::<u32, Vec<u32>>::new();
    loop {
        if entry.th32ProcessID != entry.th32ParentProcessID {
            children
                .entry(entry.th32ParentProcessID)
                .or_default()
                .push(entry.th32ProcessID);
        }
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                Ok(children)
            } else {
                Err(error)
            };
        }
    }
}

fn same_logon(process: &OwnedHandle) -> io::Result<()> {
    if crate::windows::logon_sid(process.as_raw_handle())?
        != crate::windows::logon_sid(unsafe { GetCurrentProcess() })?
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "process is outside the current logon session",
        ));
    }
    Ok(())
}

struct Member {
    identity: ProcessIdentity,
    process: OwnedHandle,
    depth: usize,
}

fn members(root: &ProcessIdentity, access: u32) -> io::Result<Vec<Member>> {
    let process = open_process(root.pid, access)?;
    if identify(root.pid, &process)? != *root {
        return Err(invalid("root process identity changed"));
    }
    same_logon(&process)?;
    let mut members = vec![Member {
        identity: root.clone(),
        process,
        depth: 0,
    }];
    let mut children = snapshot()?;
    let mut index = 0;
    while index < members.len() {
        let parent = &members[index];
        let parent_time: u64 = parent
            .identity
            .creation_time
            .parse()
            .map_err(io::Error::other)?;
        let depth = parent.depth + 1;
        for pid in children.remove(&parent.identity.pid).unwrap_or_default() {
            let process = match open_process(pid, access) {
                Ok(process) => process,
                Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
                    continue;
                }
                Err(error) => return Err(error),
            };
            let identity = match identify(pid, &process) {
                Ok(identity) => identity,
                Err(_) if exited(&process)? => continue,
                Err(error) => return Err(error),
            };
            if identity
                .creation_time
                .parse::<u64>()
                .map_err(io::Error::other)?
                < parent_time
            {
                continue; // The recorded parent PID belonged to an older process.
            }
            same_logon(&process)?;
            if members.len() >= 4096 {
                return Err(io::Error::other("process subtree limit exceeded"));
            }
            members.push(Member {
                identity,
                process,
                depth,
            });
        }
        index += 1;
    }
    Ok(members)
}

pub fn descendants(root: &ProcessIdentity) -> io::Result<Vec<ProcessIdentity>> {
    Ok(members(root, 0)?
        .into_iter()
        .skip(1)
        .map(|member| member.identity)
        .collect())
}

/// The caller supplies the root identity captured at launch. Hold the checked
/// process objects through termination so PID recycling cannot redirect a kill.
pub fn terminate_subtree(root: &ProcessIdentity) -> io::Result<Vec<u32>> {
    if root.pid == std::process::id() {
        return Err(invalid("cannot terminate platform command"));
    }
    let mut tree = members(root, PROCESS_TERMINATE)?;
    if tree
        .iter()
        .any(|member| member.identity.pid == std::process::id())
    {
        return Err(invalid("cannot terminate a platform command ancestor"));
    }
    tree.sort_by_key(|member| std::cmp::Reverse(member.depth));
    let mut terminated = Vec::new();
    let mut failure = None;
    let mut signalled = Vec::new();
    for member in tree {
        match exited(&member.process) {
            Ok(true) => continue,
            Err(error) => {
                failure.get_or_insert(error);
                continue;
            }
            Ok(false) => {}
        }
        if unsafe { TerminateProcess(member.process.as_raw_handle(), 1) } != 0 {
            signalled.push(member);
        } else {
            let error = io::Error::last_os_error();
            if !matches!(exited(&member.process), Ok(true)) {
                failure.get_or_insert(error);
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for member in signalled {
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u32;
        match unsafe { WaitForSingleObject(member.process.as_raw_handle(), timeout) } {
            WAIT_OBJECT_0 => terminated.push(member.identity.pid),
            WAIT_TIMEOUT => {
                failure.get_or_insert_with(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "process termination timed out")
                });
            }
            _ => {
                failure.get_or_insert_with(io::Error::last_os_error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(terminated)
}

pub struct JobChild {
    pub identity: ProcessIdentity,
    _job: OwnedHandle,
}

// MSVCRT argument quoting for a direct executable launch (no shell).
fn quote(argument: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in argument.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            '\\',
            slashes * if ch == '"' { 2 } else { 1 },
        ));
        if ch == '"' {
            quoted.push('\\');
        }
        quoted.push(ch);
        slashes = 0;
    }
    quoted.extend(std::iter::repeat_n('\\', slashes * 2));
    quoted.push('"');
    quoted
}

// The list points into the allocation, which stays alive through CreateProcessW.
struct JobAttribute {
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl JobAttribute {
    fn new(job: &HANDLE) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = Self {
            _storage: storage,
            list,
        };
        if unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                (job as *const HANDLE).cast(),
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(attributes)
    }
}
impl Drop for JobAttribute {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

/// Atomically assign the job at creation, even if the owner exits before resume.
/// The caller supplies the complete environment and owns the returned handle.
pub fn spawn_in_job(
    executable: &str,
    args: &[String],
    cwd: &Path,
    env: BTreeMap<String, String>,
) -> io::Result<JobChild> {
    if !Path::new(executable).is_absolute()
        || !cwd.is_absolute()
        || !executable.to_ascii_lowercase().ends_with(".exe")
    {
        return Err(invalid(
            "expected an absolute executable and working directory",
        ));
    }
    let mut entries = BTreeMap::new();
    for (key, value) in env {
        if key.is_empty()
            || !key.is_ascii()
            || key.contains('=')
            || entries
                .insert(key.to_ascii_uppercase(), wide(format!("{key}={value}"))?)
                .is_some()
        {
            return Err(invalid("invalid or duplicate Windows environment variable"));
        }
    }
    let mut environment = entries.into_values().flatten().collect::<Vec<_>>();
    if environment.is_empty() {
        environment.push(0);
    }
    environment.push(0);
    let cwd = wide(cwd)?;
    let command = std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = wide(command)?;
    let executable = wide(executable)?;
    let job = handle(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let job_handle = job.as_raw_handle();
    let attributes = JobAttribute::new(&job_handle)?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            ..Default::default()
        },
        lpAttributeList: attributes.list,
    };
    let mut info = PROCESS_INFORMATION::default();
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let process = handle(info.hProcess)?;
    let thread = handle(info.hThread)?;
    let identity = identify(info.dwProcessId, &process)?;
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(JobChild {
        identity,
        _job: job,
    })
}
