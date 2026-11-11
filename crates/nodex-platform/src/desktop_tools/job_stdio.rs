//! Stdio modes for the job launcher. Both use the same suspended, checked process creation.
use super::files::invalid;
use super::pipes::MAX_CHUNK;
use super::processes::{
    JobChild, ancestors, identify, open_process, process_identity, spawn_in_job,
};
use super::{send, value};
use crate::windows::handle;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::*;

const JOB_INPUT_QUEUE_CHUNKS: usize = 8 * 1024 * 1024 / MAX_CHUNK + 2;

fn inherit_stdio(id: u32) -> io::Result<OwnedHandle> {
    let current = unsafe { GetCurrentProcess() };
    let mut duplicate = null_mut();
    if unsafe {
        DuplicateHandle(
            current,
            GetStdHandle(id),
            current,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    handle(duplicate)
}

fn launch_owner() -> io::Result<OwnedHandle> {
    let current = process_identity(std::process::id())?;
    let parent = ancestors(&current)?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("job launcher parent is unavailable"))?;
    let owner = open_process(parent.pid, 0)?;
    if identify(parent.pid, &owner)? != parent {
        return Err(invalid("job launcher parent identity changed"));
    }
    Ok(owner)
}

fn wait(handles: &[HANDLE]) -> io::Result<u32> {
    let status =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
    if status < WAIT_OBJECT_0 + handles.len() as u32 {
        return Ok(status - WAIT_OBJECT_0);
    }
    Err(io::Error::last_os_error())
}

fn exit_code(process: &OwnedHandle) -> io::Result<u32> {
    let mut code = 0;
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(code)
}

fn relay(
    owner: OwnedHandle,
    child: JobChild,
    mut input: io::PipeWriter,
    mut output: io::PipeReader,
) -> io::Result<u32> {
    let lease_closed = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
    let signal = lease_closed.try_clone()?;
    // The acknowledgement is the last control frame. Raw helper stdout follows.
    send(1, value(&child.identity))?;
    // Use an unbuffered handle. Helper frames may contain no newline.
    let mut stdout = File::from(inherit_stdio(STD_OUTPUT_HANDLE)?);
    let drain = std::thread::spawn(move || io::copy(&mut output, &mut stdout));

    // Keep reading the lease even when the child stops consuming input.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(JOB_INPUT_QUEUE_CHUNKS);
    std::thread::spawn(move || {
        for bytes in rx {
            if input.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buffer = [0; MAX_CHUNK];
        while let Ok(size) = stdin.read(&mut buffer) {
            if size == 0 || tx.try_send(buffer[..size].to_vec()).is_err() {
                break;
            }
        }
        unsafe { SetEvent(signal.as_raw_handle()) };
    });

    let JobChild { job, process, .. } = child;
    let ended = wait(&[
        owner.as_raw_handle(),
        lease_closed.as_raw_handle(),
        process.as_raw_handle(),
    ]);
    // Release descendants before draining stdout. They may still hold the write end.
    drop(job);
    if ended? != 2 {
        wait(&[process.as_raw_handle()])?;
        return Ok(0);
    }
    drain
        .join()
        .map_err(|_| io::Error::other("job stdout relay failed"))??;
    exit_code(&process)
}

/// Launch under the broker's lifetime and its verified parent's process instance.
pub fn run_job(mut command: impl Iterator<Item = String>) -> io::Result<u32> {
    let [Some(mode), Some(executable), Some(cwd), Some(environment)] =
        std::array::from_fn(|_| command.next())
    else {
        return Err(invalid("missing job launch arguments"));
    };
    let env: BTreeMap<String, String> = serde_json::from_str(&environment)?;
    let args = command.collect::<Vec<_>>();
    let cwd = Path::new(&cwd);
    let owner = launch_owner()?;
    let stderr = inherit_stdio(STD_ERROR_HANDLE)?;
    match mode.as_str() {
        "inherit" => {
            let handles = [
                inherit_stdio(STD_INPUT_HANDLE)?,
                inherit_stdio(STD_OUTPUT_HANDLE)?,
                stderr,
            ];
            let child = spawn_in_job(
                &executable,
                &args,
                cwd,
                env,
                Some(&handles.each_ref().map(AsRawHandle::as_raw_handle)),
            )?;
            drop(handles);
            let JobChild { job, process, .. } = child;
            let ended = wait(&[owner.as_raw_handle(), process.as_raw_handle()]);
            drop(job);
            if ended? == 1 {
                return exit_code(&process);
            }
            wait(&[process.as_raw_handle()])?;
            Ok(0)
        }
        "relay" => {
            let (child_input, input) = io::pipe()?;
            let (output, child_output) = io::pipe()?;
            let handles = [
                child_input.as_raw_handle(),
                child_output.as_raw_handle(),
                stderr.as_raw_handle(),
            ];
            for raw in &handles[..2] {
                if unsafe { SetHandleInformation(*raw, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                    == 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            let child = match spawn_in_job(&executable, &args, cwd, env, Some(&handles)) {
                Ok(child) => child,
                Err(error) => {
                    send(1, Err(error))?;
                    return Ok(1);
                }
            };
            drop((child_input, child_output, stderr));
            relay(owner, child, input, output)
        }
        _ => Err(invalid("unknown job stdio mode")),
    }
}
