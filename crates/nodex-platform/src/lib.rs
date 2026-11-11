//! Operating-system boundary for Profile storage, process lifetime and local IPC.
//! Win32 unsafe calls are confined here; callers consume checked, owned resources.
#[cfg(windows)]
pub mod desktop_tools;
pub mod local_endpoint;
pub mod private_fs;
pub mod process;
#[cfg(windows)]
mod windows;

#[cfg(feature = "test-support")]
pub mod test_support;
