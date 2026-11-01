use std::fs::{self, File, Metadata};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub struct OpenOptions(std::fs::OpenOptions);
impl Default for OpenOptions {
    fn default() -> Self {
        Self::new()
    }
}
impl OpenOptions {
    pub fn new() -> Self {
        Self(std::fs::OpenOptions::new())
    }
    pub fn read(&mut self, value: bool) -> &mut Self {
        self.0.read(value);
        self
    }
    pub fn write(&mut self, value: bool) -> &mut Self {
        self.0.write(value);
        self
    }
    pub fn append(&mut self, value: bool) -> &mut Self {
        self.0.append(value);
        self
    }
    pub fn truncate(&mut self, value: bool) -> &mut Self {
        self.0.truncate(value);
        self
    }
    pub fn create(&mut self, value: bool) -> &mut Self {
        self.0.create(value);
        self
    }
    pub fn create_new(&mut self, value: bool) -> &mut Self {
        self.0.create_new(value);
        self
    }
    pub fn mode(&mut self, value: u32) -> &mut Self {
        self.0.mode(value);
        self
    }
    pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        let mut options = self.0.clone();
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
        options.open(path)
    }
}

pub fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}
pub fn is_socket(metadata: &Metadata) -> bool {
    metadata.file_type().is_socket()
}
pub fn require_owned(path: &Path, metadata: &Metadata) -> io::Result<()> {
    if !is_reparse_point(metadata) && metadata.uid() == rustix::process::geteuid().as_raw() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("{} is not owned by the current user", path.display()),
    ))
}
pub fn has_mode(_path: &Path, metadata: &Metadata, mode: u32) -> io::Result<bool> {
    Ok(metadata.mode() & 0o7777 == mode)
}
pub fn is_private(_path: &Path, metadata: &Metadata) -> io::Result<bool> {
    Ok(metadata.mode() & 0o077 == 0)
}
pub fn set_mode(path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
    let path = path.as_ref();
    require_owned(path, &fs::symlink_metadata(path)?)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    fs::DirBuilder::new().mode(0o700).create(path)
}
pub fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}
pub fn atomic_replace(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    fs::rename(source, target)
}
pub fn validate_private_handle(file: &File, mode: u32) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    if metadata.is_file()
        && metadata.uid() == rustix::process::geteuid().as_raw()
        && metadata.mode() & 0o7777 == mode
    {
        return Ok(metadata);
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "unsafe private file handle",
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub modified: (i64, i64),
    pub changed: (i64, i64),
}
pub fn file_identity(path: impl AsRef<Path>) -> io::Result<FileIdentity> {
    let path = path.as_ref();
    let metadata = fs::symlink_metadata(path)?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        modified: (metadata.mtime(), metadata.mtime_nsec()),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    })
}
pub fn link_count(path: &Path) -> io::Result<u64> {
    Ok(fs::symlink_metadata(path)?.nlink())
}
pub fn directory_link(source: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}
pub fn remove_directory_link(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
}
pub fn symlink(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}
pub fn effective_mode(path: impl AsRef<Path>) -> io::Result<u32> {
    Ok(fs::symlink_metadata(path)?.mode() & 0o777)
}
pub fn lock_is_contended(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
}
pub fn sync_file(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}
pub fn prepare_profile_root(path: &Path) -> io::Result<()> {
    super::checked_metadata(path, super::EntryKind::Directory, None).map(|_| ())
}
/// A private readable handle may be sealed; cleanup owners restore write access later.
pub fn validate_private_read_handle(file: &File) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    if metadata.is_file()
        && metadata.uid() == rustix::process::geteuid().as_raw()
        && metadata.mode() & 0o077 == 0
        && metadata.mode() & 0o400 != 0
    {
        return Ok(metadata);
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "unsafe private readable file handle",
    ))
}
pub fn has_traversal(path: &Path) -> bool {
    path.as_os_str()
        .as_encoded_bytes()
        .split(|byte| *byte == b'/')
        .any(|part| part == b".." || part == b".")
}
pub fn normalize_path(path: &Path) -> std::borrow::Cow<'_, Path> {
    std::borrow::Cow::Borrowed(path)
}
pub fn path_key(path: &Path) -> io::Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path is not UTF-8"))
}

pub fn link_immutable_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)
}

pub fn remove_immutable_file(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
}
