//! Authenticated, local-only byte streams. HTTP and bearer capabilities belong to callers.
use crate::process::UserIdentity;
use std::io;
use std::path::Path;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerIdentity {
    pub user: Option<UserIdentity>,
    pub pid: Option<u32>,
}
impl PeerIdentity {
    pub fn unavailable() -> Self {
        Self {
            user: None,
            pid: None,
        }
    }
    pub fn is_authenticated_owner(&self, owner: &UserIdentity) -> bool {
        self.user.as_ref() == Some(owner) && self.pid.is_some_and(|pid| pid > 0)
    }
}

pub fn random_endpoint(prefix: &str) -> io::Result<String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| io::Error::other(format!("endpoint randomness unavailable: {error:?}")))?;
    Ok(format!(r"\\.\pipe\{prefix}-{}", hex::encode(random)))
}
pub fn valid_pipe_name(endpoint: &str, prefix: &str) -> bool {
    endpoint
        .strip_prefix(&format!(r"\\.\pipe\{prefix}-"))
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}
pub fn validate_endpoint(endpoint: &str, expected_socket: &Path) -> bool {
    platform_endpoint_valid(endpoint, expected_socket)
}
