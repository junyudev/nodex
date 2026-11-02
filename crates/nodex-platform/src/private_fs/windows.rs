use crate::windows::{LocalAllocation, PrivateSecurity, handle, process_sid, sid_string, wide};
use std::fs::{self, File, Metadata};
use std::io;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, GENERIC_ALL, GENERIC_READ,
    GENERIC_WRITE,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::*;

#[derive(Default)]
pub struct OpenOptions {
    read: bool,
    write: bool,
    append: bool,
    truncate: bool,
    create: bool,
    create_new: bool,
}
impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn read(&mut self, value: bool) -> &mut Self {
        self.read = value;
        self
    }
    pub fn write(&mut self, value: bool) -> &mut Self {
        self.write = value;
        self
    }
    pub fn append(&mut self, value: bool) -> &mut Self {
        self.append = value;
        self
    }
    pub fn truncate(&mut self, value: bool) -> &mut Self {
        self.truncate = value;
        self
    }
    pub fn create(&mut self, value: bool) -> &mut Self {
        self.create = value;
        self
    }
    pub fn create_new(&mut self, value: bool) -> &mut Self {
        self.create_new = value;
        self
    }
    pub fn mode(&mut self, _value: u32) -> &mut Self {
        self
    }
    pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        let path = wide(path.as_ref())?;
        let security = PrivateSecurity::new(false)?;
        let attributes = security.attributes();
        let access = READ_CONTROL
            | FILE_READ_ATTRIBUTES
            | if self.read { GENERIC_READ } else { 0 }
            | if self.append {
                FILE_APPEND_DATA
            } else if self.write {
                GENERIC_WRITE
            } else {
                0
            };
        let disposition = if self.create_new {
            CREATE_NEW
        } else if self.create {
            OPEN_ALWAYS
        } else {
            OPEN_EXISTING
        };
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &attributes,
                disposition,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        let owned = handle(raw)?;
        let file: File = owned.into();
        if is_reparse_point(&file.metadata()?) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reparse point refused",
            ));
        }
        if self.truncate {
            file.set_len(0)?;
        }
        Ok(file)
    }
}

fn open_metadata(path: &Path) -> io::Result<File> {
    let path = wide(path)?;
    let owned = handle(unsafe {
        CreateFileW(
            path.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    })?;
    Ok(owned.into())
}
pub fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}
pub fn is_socket(_metadata: &Metadata) -> bool {
    false
}

fn security(file: &File, private: bool, read_only: Option<bool>) -> io::Result<()> {
    if is_reparse_point(&file.metadata()?) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reparse point refused",
        ));
    }
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _allocation = LocalAllocation(descriptor);
    let mut owner = null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let user = process_sid(None)?;
    if sid_string(owner)? != user {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "entry is not owned by the current user",
        ));
    }
    if !private {
        return Ok(());
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut present = 0;
    let mut acl: *mut ACL = null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || acl.is_null() || control & SE_DACL_PROTECTED == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private entry requires a protected DACL",
        ));
    }
    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        GetAclInformation(
            acl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut allowed = 0;
    for index in 0..info.AceCount {
        let mut ace = null_mut();
        if unsafe { GetAce(acl, index, &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { &*ace.cast::<ACE_HEADER>() }.AceType != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private entry contains an unsupported access rule",
            ));
        }
        let ace = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
        if sid_string((&ace.SidStart as *const u32).cast_mut().cast())? != user {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private entry grants access outside the current user",
            ));
        }
        allowed |= ace.Mask;
    }
    let writable =
        allowed & (FILE_WRITE_DATA | FILE_APPEND_DATA | GENERIC_WRITE | GENERIC_ALL) != 0;
    if allowed == 0 || read_only.is_some_and(|expected| expected == writable) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private entry has unexpected write access",
        ));
    }
    Ok(())
}
pub fn require_owned(path: &Path, _metadata: &Metadata) -> io::Result<()> {
    security(&open_metadata(path)?, false, None)
}
pub fn is_private(path: &Path, _metadata: &Metadata) -> io::Result<bool> {
    Ok(security(&open_metadata(path)?, true, None).is_ok())
}
pub fn has_mode(path: &Path, _metadata: &Metadata, mode: u32) -> io::Result<bool> {
    Ok(security(&open_metadata(path)?, true, Some(mode & 0o200 == 0)).is_ok())
}
pub fn set_mode(path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
    let path = path.as_ref();
    let metadata = fs::symlink_metadata(path)?;
    require_owned(path, &metadata)?;
    let wide_path = wide(path)?;
    let owned = handle(unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            WRITE_DAC | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    })?;
    // Set the DOS bit while write-attribute access still exists; directory
    // immutability is enforced solely by the protected DACL.
    if metadata.is_file() && mode & 0o200 == 0 {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions)?;
    }
    let descriptor = PrivateSecurity::new(mode & 0o200 == 0)?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor.descriptor(),
            &mut present,
            &mut acl,
            &mut defaulted,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let status = unsafe {
        SetSecurityInfo(
            owned.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if metadata.is_file() && mode & 0o200 != 0 {
        let mut permissions = metadata.permissions();
        #[expect(
            clippy::permissions_set_readonly_false,
            reason = "Windows DOS attribute only; the user-only DACL is restored first"
        )]
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let security = PrivateSecurity::new(false)?;
    let attributes = security.attributes();
    if unsafe { CreateDirectoryW(wide(path)?.as_ptr(), &attributes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
/// Windows has no portable directory fsync; files are flushed before write-through rename.
pub fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}
/// Defender and indexers may transiently withhold delete sharing. Retry for at most 1 second.
pub fn atomic_replace(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    let source = source.as_ref();
    let target = target.as_ref();
    let sealed_target = match fs::symlink_metadata(target) {
        Ok(metadata) if is_reparse_point(&metadata) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "replacement target is a reparse point",
            ));
        }
        Ok(metadata) => metadata.is_file() && metadata.permissions().readonly(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let source_name = wide(source)?;
    let target_name = wide(target)?;
    for attempt in 0..11 {
        let mut phase = "rename";
        let result = if sealed_target {
            replace_sealed_file(&source_name, &target_name, &mut phase)
        } else if unsafe {
            MoveFileExW(
                source_name.as_ptr(),
                target_name.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } != 0
        {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
        let error = match result {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if attempt == 10
            || !matches!(
                error.raw_os_error().map(|code| code as u32),
                Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
            )
        {
            return Err(if sealed_target {
                io::Error::new(
                    error.kind(),
                    format!("Could not replace a sealed file during {phase}: {error}"),
                )
            } else {
                error
            });
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unreachable!()
}

// FileRenameInfoEx can replace a read-only target without briefly weakening its
// attributes or protected DACL. The flags are part of the Windows 11 rename contract.
fn replace_sealed_file(source: &[u16], target: &[u16], phase: &mut &'static str) -> io::Result<()> {
    const REPLACE_IF_EXISTS: u32 = 0x1;
    const POSIX_SEMANTICS: u32 = 0x2;
    const IGNORE_READONLY_ATTRIBUTE: u32 = 0x40;
    *phase = "opening the replacement";
    let file = handle(unsafe {
        CreateFileW(
            source.as_ptr(),
            DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            null_mut(),
        )
    })?;
    let file: File = file.into();
    *phase = "checking replacement privacy";
    security(&file, true, None)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "replacement source must be a private regular file",
        ));
    }
    let filename = &target[..target.len() - 1];
    let bytes =
        std::mem::offset_of!(FILE_RENAME_INFO, FileName) + (filename.len() + 1) * size_of::<u16>();
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: aligned zeroed storage holds the header plus the complete UTF-16 name.
    unsafe {
        (*information).Anonymous.Flags =
            REPLACE_IF_EXISTS | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE;
        (*information).FileNameLength = std::mem::size_of_val(filename) as u32;
        std::ptr::copy_nonoverlapping(
            filename.as_ptr(),
            (*information).FileName.as_mut_ptr(),
            filename.len(),
        );
        *phase = "publishing the replacement";
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            information.cast(),
            bytes as u32,
        ) != 0
        {
            return Ok(());
        }
    }
    Err(io::Error::last_os_error())
}

pub fn validate_private_handle(file: &File, mode: u32) -> io::Result<Metadata> {
    security(file, true, Some(mode & 0o200 == 0))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected regular file",
        ));
    }
    Ok(metadata)
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
    let file = open_metadata(path)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(FileIdentity {
        device: u64::from(info.dwVolumeSerialNumber),
        inode: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        modified: (basic.LastWriteTime, 0),
        changed: (basic.ChangeTime, 0),
    })
}
pub fn link_count(path: &Path) -> io::Result<u64> {
    let file = open_metadata(path)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(info.nNumberOfLinks))
}
/// Directory junctions do not require Developer Mode or symlink privileges.
pub fn directory_link(source: &Path, target: &Path) -> io::Result<()> {
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    let source = source.canonicalize()?;
    let print = source
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned();
    let substitute = wide(format!(r"\??\{print}"))?;
    let print = wide(print)?;
    let substitute_bytes = (substitute.len() * 2) as u16;
    let data_length = 8 + substitute_bytes + (print.len() * 2) as u16;
    let mut data = Vec::new();
    data.extend_from_slice(&0xA0000003u32.to_le_bytes());
    data.extend_from_slice(&data_length.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&(substitute_bytes - 2).to_le_bytes());
    data.extend_from_slice(&substitute_bytes.to_le_bytes());
    data.extend_from_slice(&((print.len() * 2 - 2) as u16).to_le_bytes());
    for code in substitute.into_iter().chain(print) {
        data.extend_from_slice(&code.to_le_bytes());
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| io::Error::other(format!("junction randomness unavailable: {error:?}")))?;
    let temporary = target.with_file_name(format!(".nodex-link-{}.tmp", hex::encode(random)));
    create_dir(&temporary)?;
    let result = (|| {
        let path = wide(&temporary)?;
        let directory = handle(unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        })?;
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                directory.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                data.as_ptr().cast(),
                data.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    // Publish only the completed reparse point; competing installers never see
    // an ordinary staging directory at the managed target.
    let result = result.and_then(|()| {
        if unsafe {
            MoveFileExW(
                wide(&temporary)?.as_ptr(),
                wide(target)?.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } != 0
        {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if fs::symlink_metadata(target).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "directory link target already exists",
            ));
        }
        Err(error)
    });
    if result.is_err() {
        let _ = fs::remove_dir(&temporary);
    }
    result
}
pub fn remove_directory_link(path: &Path) -> io::Result<()> {
    fs::remove_dir(path)
}
pub fn symlink(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    if source.as_ref().is_dir() {
        return directory_link(source.as_ref(), target.as_ref());
    }
    std::os::windows::fs::symlink_file(source, target)
}
/// Projects the platform's private writable/read-only access contract for diagnostics.
pub fn effective_mode(path: impl AsRef<Path>) -> io::Result<u32> {
    let path = path.as_ref();
    let metadata = fs::symlink_metadata(path)?;
    let writable = if metadata.is_dir() { 0o700 } else { 0o600 };
    if has_mode(path, &metadata, writable)? {
        return Ok(writable);
    }
    if has_mode(path, &metadata, writable & !0o200)? {
        return Ok(writable & !0o200);
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "entry does not satisfy private access",
    ))
}
pub fn lock_is_contended(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32)
}
pub fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.sync_all()
}
/// Secure the Profile before SQLite or Desktop can create inheriting artifacts.
pub fn prepare_profile_root(path: &Path) -> io::Result<()> {
    super::prepare_private_path(path, super::EntryKind::Directory)
}

pub(super) fn initialize_private_entry(
    path: &Path,
    kind: super::EntryKind,
    mode: u32,
) -> io::Result<()> {
    let metadata = super::entry_metadata(path, kind)?;
    if require_owned(path, &metadata).is_ok() {
        if has_mode(path, &metadata, mode)? {
            return Ok(());
        }
        return set_mode(path, mode);
    }
    // Elevated tokens can default newly created directories to the Administrators
    // owner. Initialization replaces only this token's default owner, before any
    // Profile content is read, then applies the strict current-user contract.
    let file = open_metadata(path)?;
    let mut descriptor = null_mut();
    let mut owner = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _allocation = LocalAllocation(descriptor);
    if sid_string(owner)? != crate::windows::default_owner_sid()? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Private filesystem entry belongs to another user",
        ));
    }
    let file = handle(unsafe {
        CreateFileW(
            wide(path)?.as_ptr(),
            WRITE_OWNER | WRITE_DAC | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    })?;
    let file: File = file.into();
    if is_reparse_point(&file.metadata()?) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Private filesystem entry must not be a reparse point",
        ));
    }
    let security = PrivateSecurity::new(false)?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(security.descriptor(), &mut owner, &mut defaulted) } == 0
        || unsafe {
            GetSecurityDescriptorDacl(
                security.descriptor(),
                &mut present,
                &mut acl,
                &mut defaulted,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            null_mut(),
            acl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    super::checked_metadata(path, kind, Some(mode)).map(|_| ())
}

/// A private readable handle may be sealed; cleanup owners restore write access later.
pub fn validate_private_read_handle(file: &File) -> io::Result<Metadata> {
    security(file, true, None)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected regular file",
        ));
    }
    Ok(metadata)
}

pub fn has_traversal(path: &Path) -> bool {
    path.as_os_str()
        .as_encoded_bytes()
        .split(|byte| matches!(byte, b'/' | b'\\'))
        .any(|part| part == b".." || part == b".")
}

pub fn normalize_path(path: &Path) -> std::borrow::Cow<'_, Path> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let units: Vec<_> = path
        .as_os_str()
        .encode_wide()
        .map(|unit| {
            if unit == u16::from(b'/') {
                u16::from(b'\\')
            } else {
                unit
            }
        })
        .collect();
    std::borrow::Cow::Owned(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &units,
    )))
}
pub fn path_key(path: &Path) -> io::Result<String> {
    let path = path
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path is not UTF-8"))?;
    Ok(path
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!("//{path}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned())
        .replace('\\', "/"))
}

// Sealed files cannot grant the mutation access required to create another NTFS link.
// Materialize a separately sealed private copy while preserving the immutable contract.
pub fn link_immutable_file(source: &Path, destination: &Path) -> io::Result<()> {
    super::copy(source, destination)?;
    set_mode(destination, 0o400)
}
/// Windows requires clearing the DOS read-only attribute before deleting a sealed file.
pub fn remove_immutable_file(path: &Path) -> io::Result<()> {
    set_mode(path, 0o600)?;
    fs::remove_file(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sealed_file_data_stays_read_only_when_its_dos_attribute_changes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sealed");
        super::super::write(&path, b"immutable").unwrap();
        set_mode(&path, 0o400).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[expect(
            clippy::permissions_set_readonly_false,
            reason = "prove the protected DACL seals data independently of the DOS attribute"
        )]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(
            OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        super::super::checked_metadata(&path, super::super::EntryKind::File, Some(0o400)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"immutable");
        remove_immutable_file(&path).unwrap();
    }

    #[test]
    fn profile_initialization_converts_the_token_default_owner_before_admission() {
        let directory = tempfile::tempdir().unwrap();
        prepare_profile_root(directory.path()).unwrap();
        super::super::checked_metadata(
            directory.path(),
            super::super::EntryKind::Directory,
            Some(0o700),
        )
        .unwrap();
    }

    #[test]
    fn private_validation_rejects_a_protected_acl_that_grants_everyone_read_access() {
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        drop(file);
        let sddl = wide(format!(
            "O:{}D:P(A;;FA;;;{})(A;;FR;;;WD)",
            process_sid(None).unwrap(),
            process_sid(None).unwrap()
        ))
        .unwrap();
        let mut descriptor = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            0
        );
        let _allocation = LocalAllocation(descriptor);
        let mut acl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
            },
            0
        );
        let file = handle(unsafe {
            CreateFileW(
                wide(&path).unwrap().as_ptr(),
                WRITE_DAC | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        })
        .unwrap();
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut(),
                )
            },
            0
        );
        assert!(
            super::super::checked_metadata(&path, super::super::EntryKind::File, Some(0o600))
                .is_err()
        );
    }
}
