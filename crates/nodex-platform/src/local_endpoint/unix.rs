use super::PeerIdentity;
use crate::process::ProcessInstance;
use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use std::io;
pub use std::os::unix::net::UnixStream as Stream;
use std::path::Path;
pub struct LocalListener(tokio::net::UnixListener);
impl LocalListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let listener = tokio::net::UnixListener::bind(endpoint)?;
        crate::private_fs::set_mode(endpoint, 0o600)?;
        Ok(Self(listener))
    }
}
impl Listener for LocalListener {
    type Io = tokio::net::UnixStream;
    type Addr = tokio::net::unix::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        Listener::accept(&mut self.0).await
    }
    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.0.local_addr()
    }
}
impl Connected<IncomingStream<'_, LocalListener>> for PeerIdentity {
    fn connect_info(stream: IncomingStream<'_, LocalListener>) -> Self {
        match stream.io().peer_cred() {
            Ok(credential) => Self {
                user: Some(credential.uid()),
                process: credential
                    .pid()
                    .and_then(|pid| u32::try_from(pid).ok())
                    .and_then(|pid| ProcessInstance::of(pid).ok()),
            },
            Err(_) => Self::unavailable(),
        }
    }
}
pub fn connect(endpoint: &Path, _expected_pid: Option<u32>) -> io::Result<Stream> {
    Stream::connect(endpoint)
}
pub fn new_core_endpoint(socket: &Path) -> io::Result<String> {
    Ok(socket.to_string_lossy().into_owned())
}
pub(super) fn platform_endpoint_valid(endpoint: &str, socket: &Path) -> bool {
    Path::new(endpoint) == socket
}
pub use std::os::unix::net::UnixListener as BlockingListener;
