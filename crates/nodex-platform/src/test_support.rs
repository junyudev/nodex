//! Disposable Profiles use the same owner and ACL creation path as production.
use std::io;
use std::path::{Path, PathBuf};
#[derive(Debug)]
pub struct TempDir {
    _container: tempfile::TempDir,
    path: PathBuf,
}
impl TempDir {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
pub fn tempdir() -> io::Result<TempDir> {
    let container = tempfile::tempdir()?;
    let path = container.path().join("data");
    crate::private_fs::create_dir(&path)?;
    Ok(TempDir {
        _container: container,
        path,
    })
}
