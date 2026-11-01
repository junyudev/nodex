use super::PeerIdentity;
use crate::windows::{PrivateSecurity, handle, process_sid, wide};
use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use std::future::Future;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
use std::path::Path;
use std::pin::Pin;
use std::ptr::{null, null_mut};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ,
    GENERIC_WRITE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

pub struct LocalListener {
    endpoint: String,
    next: NamedPipeServer,
}
impl LocalListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        Ok(Self {
            endpoint: endpoint.into(),
            next: instance(endpoint, true)?,
        })
    }
}
fn instance(endpoint: &str, first: bool) -> io::Result<NamedPipeServer> {
    let security = PrivateSecurity::new(false)?;
    let mut attributes = security.attributes();
    // SAFETY: security descriptor and attributes outlive synchronous pipe creation;
    // Tokio takes ownership of the resulting overlapped handle.
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                endpoint,
                (&mut attributes as *mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES).cast(),
            )
    }
}
impl Listener for LocalListener {
    type Io = Connection;
    type Addr = String;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if self.next.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
            // Keep an available instance alive before handing the connected one to HTTP.
            let next = match instance(&self.endpoint, false) {
                Ok(next) => next,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
            };
            let connected = std::mem::replace(&mut self.next, next);
            let peer = peer(&connected);
            if !peer.is_authenticated_owner(&crate::process::current_user().unwrap_or_default()) {
                continue;
            }
            return (
                Connection {
                    pipe: connected,
                    drain: None,
                },
                self.endpoint.clone(),
            );
        }
    }
    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.endpoint.clone())
    }
}
fn peer(stream: &NamedPipeServer) -> PeerIdentity {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle(), &mut pid) } == 0 || pid == 0 {
        return PeerIdentity {
            user: None,
            pid: None,
        };
    }
    PeerIdentity {
        user: process_sid(Some(pid)).ok(),
        pid: Some(pid),
    }
}
impl Connected<IncomingStream<'_, LocalListener>> for PeerIdentity {
    fn connect_info(stream: IncomingStream<'_, LocalListener>) -> Self {
        peer(&stream.io().pipe)
    }
}

/// Draining before close is required by Windows: closing a pipe discards unread bytes.
/// Tokio pipe shutdown itself is a no-op, so HTTP must await the native drain off-thread.
#[derive(Debug)]
pub struct Connection {
    pipe: NamedPipeServer,
    drain: Option<tokio::task::JoinHandle<io::Result<()>>>,
}
impl AsyncRead for Connection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_read(cx, buffer)
    }
}
impl AsyncWrite for Connection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.pipe).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.pipe).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.drain.is_none() {
            let handle = match self.pipe.as_handle().try_clone_to_owned() {
                Ok(handle) => handle,
                Err(error) => return Poll::Ready(Err(error)),
            };
            self.drain = match drain_pipe(handle) {
                Ok(drain) => Some(drain),
                Err(error) => return Poll::Ready(Err(error)),
            };
        }
        match Pin::new(self.drain.as_mut().expect("drain initialized")).poll(cx) {
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(error)) => Poll::Ready(Err(io::Error::other(error))),
            Poll::Pending => Poll::Pending,
        }
    }
}

const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

fn drain_pipe(handle: OwnedHandle) -> io::Result<tokio::task::JoinHandle<io::Result<()>>> {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A blocked native flush must not keep Tokio's runtime teardown waiting.
    let worker = std::thread::Builder::new()
        .name("local-pipe-drain".into())
        .spawn(move || {
            if worker_cancelled.load(Ordering::Acquire) {
                return;
            }
            let result = if unsafe {
                windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(handle.as_raw_handle())
            } != 0
            {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                if matches!(
                    error.raw_os_error().map(|code| code as u32),
                    Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)
                ) {
                    Ok(())
                } else {
                    Err(error)
                }
            };
            let _ = sender.send(result);
        })?;
    Ok(tokio::spawn(async move {
        match tokio::time::timeout(DRAIN_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(io::Error::other(error)),
            Err(_) => {
                cancelled.store(true, Ordering::Release);
                unsafe {
                    windows_sys::Win32::System::IO::CancelSynchronousIo(worker.as_raw_handle());
                }
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "local endpoint response drain timed out",
                ))
            }
        }
    }))
}

#[derive(Debug)]
pub struct Stream {
    handle: OwnedHandle,
    read_timeout: std::cell::Cell<Option<Duration>>,
    write_timeout: std::cell::Cell<Option<Duration>>,
}
impl Stream {
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            handle: self.handle.try_clone()?,
            read_timeout: self.read_timeout.clone(),
            write_timeout: self.write_timeout.clone(),
        })
    }
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_timeout.set(timeout);
        Ok(())
    }
    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.write_timeout.set(timeout);
        Ok(())
    }
    fn transfer(&self, buffer: *mut u8, length: usize, write: bool) -> io::Result<usize> {
        if length == 0 {
            return Ok(0);
        }
        let event = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle();
        let length = u32::try_from(length).unwrap_or(u32::MAX);
        let started = unsafe {
            if write {
                WriteFile(
                    self.handle.as_raw_handle(),
                    buffer,
                    length,
                    null_mut(),
                    &mut overlapped,
                )
            } else {
                ReadFile(
                    self.handle.as_raw_handle(),
                    buffer,
                    length,
                    null_mut(),
                    &mut overlapped,
                )
            }
        };
        let error = io::Error::last_os_error();
        if started == 0 && error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            if !write
                && matches!(
                    error.raw_os_error().map(|v| v as u32),
                    Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)
                )
            {
                return Ok(0);
            }
            return Err(error);
        }
        let timeout = if write {
            self.write_timeout.get()
        } else {
            self.read_timeout.get()
        };
        let wait = unsafe {
            WaitForSingleObject(
                event.as_raw_handle(),
                timeout.map_or(u32::MAX, |timeout| {
                    timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32
                }),
            )
        };
        if wait != WAIT_OBJECT_0 {
            unsafe {
                CancelIoEx(self.handle.as_raw_handle(), &overlapped);
                WaitForSingleObject(event.as_raw_handle(), u32::MAX);
            }
            return Err(if wait == WAIT_TIMEOUT {
                io::Error::new(io::ErrorKind::TimedOut, "local endpoint I/O timed out")
            } else {
                io::Error::last_os_error()
            });
        }
        let mut transferred = 0;
        if unsafe {
            GetOverlappedResult(
                self.handle.as_raw_handle(),
                &overlapped,
                &mut transferred,
                0,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if !write && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            return Err(error);
        }
        Ok(transferred as usize)
    }
}
impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.transfer(buffer.as_mut_ptr(), buffer.len(), false)
    }
}
impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.transfer(buffer.as_ptr().cast_mut(), buffer.len(), true)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn connect(endpoint: &Path, expected_pid: Option<u32>) -> io::Result<Stream> {
    let name = wide(endpoint)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let pipe = loop {
        match handle(unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        }) {
            Ok(pipe) => break pipe,
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error),
        }
    };
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0
        || expected_pid.is_some_and(|expected| expected != pid)
        || process_sid(Some(pid))? != process_sid(None)?
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "local endpoint server identity does not match its descriptor",
        ));
    }
    Ok(Stream {
        handle: pipe,
        read_timeout: std::cell::Cell::new(Some(Duration::from_secs(30))),
        write_timeout: std::cell::Cell::new(Some(Duration::from_secs(30))),
    })
}
pub fn new_core_endpoint(_socket: &Path) -> io::Result<String> {
    super::random_endpoint("nodex-core")
}
pub(super) fn platform_endpoint_valid(endpoint: &str, _socket: &Path) -> bool {
    super::valid_pipe_name(endpoint, "nodex-core")
}
/// Blocking counterpart for bounded rendezvous protocols and native test peers.
pub struct BlockingListener {
    endpoint: std::path::PathBuf,
    next: std::sync::Mutex<Stream>,
}
impl BlockingListener {
    pub fn bind(endpoint: impl AsRef<Path>) -> io::Result<Self> {
        let endpoint = endpoint.as_ref().to_path_buf();
        let next = blocking_instance(&endpoint, true)?;
        Ok(Self {
            endpoint,
            next: std::sync::Mutex::new(next),
        })
    }
    pub fn accept(&self) -> io::Result<(Stream, ())> {
        use windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
        use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
        let mut next = self
            .next
            .lock()
            .map_err(|_| io::Error::other("listener poisoned"))?;
        let event = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle();
        let result = unsafe { ConnectNamedPipe(next.handle.as_raw_handle(), &mut overlapped) };
        if result == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
                let wait = unsafe { WaitForSingleObject(event.as_raw_handle(), 30000) };
                if wait != WAIT_OBJECT_0 {
                    unsafe {
                        CancelIoEx(next.handle.as_raw_handle(), &overlapped);
                        WaitForSingleObject(event.as_raw_handle(), u32::MAX);
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "pipe accept timed out",
                    ));
                }
            } else if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                return Err(error);
            }
        }
        let replacement = blocking_instance(&self.endpoint, false)?;
        Ok((std::mem::replace(&mut *next, replacement), ()))
    }
}
fn blocking_instance(endpoint: &Path, first: bool) -> io::Result<Stream> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    let security = PrivateSecurity::new(false)?;
    let attributes = security.attributes();
    let pipe = handle(unsafe {
        CreateNamedPipeW(
            wide(endpoint)?.as_ptr(),
            PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_REJECT_REMOTE_CLIENTS | PIPE_TYPE_BYTE | PIPE_WAIT,
            255,
            65536,
            65536,
            0,
            &attributes,
        )
    })?;
    Ok(Stream {
        handle: pipe,
        read_timeout: std::cell::Cell::new(Some(Duration::from_secs(30))),
        write_timeout: std::cell::Cell::new(Some(Duration::from_secs(30))),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_drains_every_response_byte_before_closing_the_pipe() {
        use tokio::io::AsyncWriteExt;
        let endpoint = super::super::random_endpoint("nodex-core").unwrap();
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let server = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await;
            connection.write_all(&vec![42; 256 * 1024]).await.unwrap();
            connection.shutdown().await.unwrap();
        });
        let received = tokio::task::spawn_blocking(move || {
            let mut client = connect(Path::new(&endpoint), Some(std::process::id())).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            let mut bytes = Vec::new();
            client.read_to_end(&mut bytes).unwrap();
            bytes
        })
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(received, vec![42; 256 * 1024]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stalled_reader_cannot_hold_shutdown_open() {
        use tokio::io::AsyncWriteExt;
        let endpoint = super::super::random_endpoint("nodex-core").unwrap();
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let client = tokio::task::spawn_blocking(move || {
            let _client = connect(Path::new(&endpoint), Some(std::process::id())).unwrap();
            let _ = hold.recv_timeout(Duration::from_secs(10));
        });
        let (mut connection, _) = listener.accept().await;
        connection.write_all(b"unread response").await.unwrap();
        let error = connection.shutdown().await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        drop(release);
        client.await.unwrap();
    }

    #[tokio::test]
    async fn first_instance_and_server_identity_are_enforced() {
        let endpoint = super::super::random_endpoint("nodex-core").unwrap();
        let _listener = LocalListener::bind(&endpoint).unwrap();
        assert!(LocalListener::bind(&endpoint).is_err());
        assert!(connect(Path::new(&endpoint), Some(std::process::id() + 1)).is_err());
    }
    #[tokio::test]
    async fn anonymous_token_cannot_open_a_private_pipe() {
        let endpoint = super::super::random_endpoint("nodex-core").unwrap();
        let _listener = LocalListener::bind(&endpoint).unwrap();
        std::thread::spawn(move || {
            use windows_sys::Win32::Security::{ImpersonateAnonymousToken, RevertToSelf};
            use windows_sys::Win32::System::Threading::GetCurrentThread;
            assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
            let result = handle(unsafe {
                CreateFileW(
                    wide(&endpoint).unwrap().as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            });
            let reverted = unsafe { RevertToSelf() };
            assert_ne!(reverted, 0);
            assert!(result.is_err());
        })
        .join()
        .unwrap();
    }
}
