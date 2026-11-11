use super::files::invalid;
use super::processes::{ProcessIdentity, identify, open_process};
use crate::local_endpoint::{desktop_instance, pipe_peer_pid, random_endpoint};
use crate::windows::{logon_sid, wide};
use serde::Serialize;
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer};
use tokio::sync::{Mutex, watch};
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const PREFIX: &str = r"\\.\pipe\";
pub(super) const MAX_CHUNK: usize = 65536;
pub(super) const MAX_CONNECTIONS: usize = 8;

fn simple_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'-' | b'_'))
}

fn endpoint_name(name: &str) -> io::Result<()> {
    if !name.strip_prefix(PREFIX).is_some_and(simple_name) {
        return Err(invalid("expected a local named pipe"));
    }
    Ok(())
}

pub struct PipeListener {
    pub endpoint: String,
    next: NamedPipeServer,
}

impl PipeListener {
    pub fn bind(prefix: &str) -> io::Result<Self> {
        if !simple_name(prefix) || prefix.len() > 160 {
            return Err(invalid("invalid pipe prefix"));
        }
        let endpoint = random_endpoint(prefix)?;
        let next = desktop_instance(&endpoint, true)?;
        Ok(Self { endpoint, next })
    }
    pub async fn accept(&mut self) -> io::Result<PipeConnection> {
        self.next.connect().await?;
        let next = match desktop_instance(&self.endpoint, false) {
            Ok(next) => next,
            Err(error) => {
                let _ = self.next.disconnect();
                return Err(error);
            }
        };
        let connected = std::mem::replace(&mut self.next, next);
        PipeConnection::new(connected, false)
    }
}

pub fn connect_pipe(endpoint: &str) -> io::Result<PipeConnection> {
    endpoint_name(endpoint)?;
    let client = ClientOptions::new()
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(endpoint)?;
    PipeConnection::new(client, true)
}

pub(super) trait PipeIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> PipeIo for T {}
type PipeRead = ReadHalf<Box<dyn PipeIo>>;
type PipeWrite = WriteHalf<Box<dyn PipeIo>>;

pub struct PipeConnection {
    pub identity: ProcessIdentity,
    // Keep the process object alive for the connection lifetime.
    _peer: OwnedHandle,
    pub(super) reader: Arc<Mutex<PipeRead>>,
    pub(super) writer: Arc<Mutex<PipeWrite>>,
    pub(super) closed: watch::Sender<()>,
}

impl PipeConnection {
    fn new(pipe: impl PipeIo + AsRawHandle + 'static, server_peer: bool) -> io::Result<Self> {
        let pid = pipe_peer_pid(pipe.as_raw_handle(), server_peer)?;
        let peer = open_process(pid, 0)?;
        if !server_peer
            && logon_sid(peer.as_raw_handle())? != logon_sid(unsafe { GetCurrentProcess() })?
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "pipe client is outside the current logon session",
            ));
        }
        let identity = identify(pid, &peer)?;
        if pipe_peer_pid(pipe.as_raw_handle(), server_peer)? != pid {
            return Err(io::Error::other(
                "pipe peer changed while reading its identity",
            ));
        }
        let (reader, writer) = tokio::io::split(Box::new(pipe) as Box<dyn PipeIo>);
        Ok(Self {
            identity,
            _peer: peer,
            reader: Arc::new(Mutex::new(reader)),
            writer: Arc::new(Mutex::new(writer)),
            closed: watch::channel(()).0,
        })
    }
}

#[derive(Serialize)]
pub struct PipeNames {
    names: Vec<String>,
    truncated: bool,
}

struct Search(HANDLE);
impl Drop for Search {
    fn drop(&mut self) {
        unsafe {
            FindClose(self.0);
        }
    }
}

/// Cap both matched names and namespace work. Callers treat names as discovery
/// hints and authenticate peers on the actual connection.
pub fn enumerate_pipes(prefix: &str, limit: usize) -> io::Result<PipeNames> {
    if !simple_name(prefix) || !(1..=256).contains(&limit) {
        return Err(invalid("invalid pipe prefix or enumeration limit"));
    }
    let wildcard = wide(format!("{PREFIX}*"))?;
    let mut data = WIN32_FIND_DATAW::default();
    let raw = unsafe { FindFirstFileW(wildcard.as_ptr(), &mut data) };
    let mut names = Vec::new();
    if raw == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
            Ok(PipeNames {
                names,
                truncated: false,
            })
        } else {
            Err(error)
        };
    }
    let search = Search(raw);
    let prefix = prefix.to_ascii_lowercase();
    for _ in 0..4096 {
        let end = data
            .cFileName
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(data.cFileName.len());
        if let Ok(name) = String::from_utf16(&data.cFileName[..end])
            && simple_name(&name)
            && name.to_ascii_lowercase().starts_with(&prefix)
        {
            if names.len() == limit {
                break;
            }
            names.push(format!("{PREFIX}{name}"));
        }
        if unsafe { FindNextFileW(search.0, &mut data) } == 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                Ok(PipeNames {
                    names,
                    truncated: false,
                })
            } else {
                Err(error)
            };
        }
    }
    Ok(PipeNames {
        names,
        truncated: true,
    })
}
