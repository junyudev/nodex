use crate::windows::{LocalAllocation, handle, process_sid, sid_string, wide};
use serde::Serialize;
use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
use std::path::{Component, Path, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    GENERIC_ALL, GENERIC_WRITE, HANDLE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: HANDLE,
    name: *const UNICODE_STRING,
    flags: u32,
    security_descriptor: *const c_void,
    security_qos: *const c_void,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file: *mut HANDLE,
        access: u32,
        attributes: *const ObjectAttributes,
        status: *mut IO_STATUS_BLOCK,
        size: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_len: u32,
    ) -> NTSTATUS;
}

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn open_component(parent: &File, name: &std::ffi::OsStr, access: u32) -> io::Result<File> {
    let mut text = wide(name)?;
    if text[..text.len() - 1]
        .iter()
        .any(|&ch| matches!(ch, 47 | 58 | 92))
    {
        return Err(invalid(
            "expected a single NTFS component without a stream name",
        ));
    }
    let length = u16::try_from((text.len() - 1) * 2).map_err(|_| invalid("component too long"))?;
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: text.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root: parent.as_raw_handle(),
        name: &name,
        flags: 0x40, // OBJ_CASE_INSENSITIVE
        security_descriptor: null(),
        security_qos: null(),
    };
    let mut raw = null_mut();
    // FILE_OPEN, FILE_OPEN_REPARSE_POINT and FILE_SYNCHRONOUS_IO_NONALERT. Only
    // one component is resolved, from the checked parent handle.
    let status = unsafe {
        NtCreateFile(
            &mut raw,
            access | SYNCHRONIZE,
            &attributes,
            &mut IO_STATUS_BLOCK::default(),
            null(),
            0,
            FILE_SHARE_READ,
            1,
            0x0020_0020,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    Ok(handle(raw)?.into())
}

fn reparse(file: &File) -> io::Result<bool> {
    Ok(file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

/// Holds the checked ancestors while the caller inspects or verifies the final handle.
pub(super) fn open_ntfs(path: &Path, access: u32) -> io::Result<(Vec<File>, bool)> {
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive as char,
            _ => return Err(invalid("expected a local drive path")),
        },
        _ => return Err(invalid("expected an absolute Windows path")),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(invalid("expected an absolute drive path"));
    }
    let drive_name = wide(format!("{drive}:"))?;
    let mut device = [0; 1024];
    if unsafe {
        QueryDosDeviceW(
            drive_name.as_ptr(),
            device.as_mut_ptr(),
            device.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let end = device
        .iter()
        .position(|&ch| ch == 0)
        .ok_or_else(|| invalid("invalid volume device"))?;
    let device = String::from_utf16(&device[..end]).map_err(io::Error::other)?;
    if !device
        .strip_prefix(r"\Device\HarddiskVolume")
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|digit| digit.is_ascii_digit())
        })
    {
        return Err(invalid(
            "expected a local volume drive, without redirection",
        ));
    }
    // Resolve the validated volume directly. A substituted drive can otherwise
    // hide reparse points ahead of the first component we inspect.
    let root = wide(format!(r"\\?\GLOBALROOT{device}\"))?;
    let mut components = components.peekable();
    let root_access = if components.peek().is_none() {
        access
    } else {
        FILE_READ_ATTRIBUTES | FILE_TRAVERSE
    };
    let root: File = handle(unsafe {
        CreateFileW(
            root.as_ptr(),
            root_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    })?
    .into();
    let mut fs = [0; 16];
    if unsafe {
        GetVolumeInformationByHandleW(
            root.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            fs.as_mut_ptr(),
            fs.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if fs[..5] != [b'N' as u16, b'T' as u16, b'F' as u16, b'S' as u16, 0] {
        return Err(invalid("expected NTFS"));
    }
    let mut chain = vec![root];
    while let Some(component) = components.next() {
        let parent = chain.last().expect("drive root");
        if reparse(parent)? {
            return Err(invalid("ancestor is a reparse point"));
        }
        let Component::Normal(name) = component else {
            return Err(invalid("expected a normalized NTFS path"));
        };
        let access = if components.peek().is_none() {
            access
        } else {
            FILE_READ_ATTRIBUTES | FILE_TRAVERSE
        };
        chain.push(open_component(parent, name, access)?);
    }
    let final_is_reparse = reparse(chain.last().expect("drive root"))?;
    Ok((chain, final_is_reparse))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSecurity {
    pub reparse_point: bool,
    pub owner_sid: String,
    pub current_user_sid: String,
    pub grants_foreign_write: bool,
}

/// Conservative DACL inspection. Deny ACEs cannot turn an unsafe/unknown allow
/// rule into a safe one, since evaluating effective access would require tokens
/// for every principal and potentially callback/object-specific policy.
pub fn inspect_path(path: &Path) -> io::Result<PathSecurity> {
    let (chain, reparse_point) = open_ntfs(path, READ_CONTROL | FILE_READ_ATTRIBUTES)?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            chain.last().expect("checked path").as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _descriptor = LocalAllocation(descriptor);
    let current_user_sid = process_sid(None)?;
    Ok(PathSecurity {
        reparse_point,
        owner_sid: sid_string(owner)?,
        grants_foreign_write: foreign_write(acl, &current_user_sid)?,
        current_user_sid,
    })
}

fn foreign_write(acl: *mut ACL, current_user: &str) -> io::Result<bool> {
    if acl.is_null() {
        return Ok(true); // Absent or NULL DACL grants everyone full access.
    }
    let mask = GENERIC_WRITE
        | GENERIC_ALL
        | FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | FILE_DELETE_CHILD
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER;
    for index in 0..u32::from(unsafe { (*acl).AceCount }) {
        let mut raw = null_mut();
        if unsafe { GetAce(acl, index, &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }
        match header.AceType {
            1 | 6 | 10 | 12 => continue, // Deny, object deny, callback deny, callback object deny.
            0 => {
                let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
                if ace.Mask & mask != 0 {
                    let sid = sid_string((&raw const ace.SidStart).cast_mut().cast())?;
                    if ![current_user, "S-1-5-18", "S-1-5-32-544"].contains(&sid.as_str()) {
                        return Ok(true);
                    }
                }
            }
            _ => return Ok(true),
        }
    }
    Ok(false)
}
