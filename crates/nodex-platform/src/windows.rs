use std::ffi::{OsStr, c_void};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub(crate) fn wide(value: impl AsRef<OsStr>) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.as_ref().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    value.push(0);
    Ok(value)
}
pub(crate) fn handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the caller transfers a newly acquired kernel handle on success.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

pub(crate) fn process_sid(pid: Option<u32>) -> io::Result<String> {
    token_sid(pid, windows_sys::Win32::Security::TokenUser)
}
pub(crate) fn default_owner_sid() -> io::Result<String> {
    token_sid(None, windows_sys::Win32::Security::TokenOwner)
}
fn token_sid(
    pid: Option<u32>,
    information: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<String> {
    use std::os::windows::io::AsRawHandle;
    let process = pid
        .map(|pid| handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }))
        .transpose()?;
    let process = process.as_ref().map_or_else(
        || unsafe { GetCurrentProcess() },
        |handle| handle.as_raw_handle(),
    );
    let buffer = token_info(process, information)?;
    // SAFETY: the successful query initialized the requested token structure in aligned storage.
    let sid = if information == TokenUser {
        unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    } else {
        unsafe {
            (*(buffer
                .as_ptr()
                .cast::<windows_sys::Win32::Security::TOKEN_OWNER>()))
            .Owner
        }
    };
    sid_string(sid)
}

pub(crate) fn logon_sid(process: HANDLE) -> io::Result<String> {
    use windows_sys::Win32::Security::{TOKEN_GROUPS, TokenLogonSid};
    let buffer = token_info(process, TokenLogonSid)?;
    let groups = buffer.as_ptr().cast::<TOKEN_GROUPS>();
    // TokenLogonSid returns exactly the group that identifies the logon session.
    if unsafe { (*groups).GroupCount } != 1 {
        return Err(io::Error::other("process has no unique logon SID"));
    }
    let group = unsafe { (*groups).Groups[0] };
    if group.Attributes & 0xc000_0000 != 0xc000_0000 {
        return Err(io::Error::other("token group is not a logon SID"));
    }
    sid_string(group.Sid)
}

fn token_info(
    process: HANDLE,
    information: windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    use std::os::windows::io::AsRawHandle;
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = handle(token)?;
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            information,
            null_mut(),
            0,
            &mut length,
        );
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            information,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

pub(crate) fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(text.cast());
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    drop(allocation);
    Ok(result)
}

pub(crate) struct LocalAllocation(pub *mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub(crate) struct PrivateSecurity {
    descriptor: LocalAllocation,
}
impl PrivateSecurity {
    pub(crate) fn new(read_only: bool) -> io::Result<Self> {
        let sid = process_sid(None)?;
        // FILE_WRITE_ATTRIBUTES is required to atomically replace a sealed file.
        // It does not grant data writes, appends, child creation, or deletion.
        let access = if read_only { "0x001201a9" } else { "FA" };
        Self::from_sddl(&format!("O:{sid}D:P(A;OICI;{access};;;{sid})"))
    }
    pub(crate) fn logon_pipe() -> io::Result<Self> {
        let sid = logon_sid(unsafe { GetCurrentProcess() })?;
        // Suppress implicit owner rights for the same account in another logon.
        // The only allow ACE belongs to the actual logon SID.
        Self::from_sddl(&format!("D:P(D;;WD;;;OW)(A;;FRFW;;;{sid})"))
    }
    pub(crate) fn from_sddl(sddl: &str) -> io::Result<Self> {
        let sddl = wide(sddl)?;
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor: LocalAllocation(descriptor),
        })
    }
    pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
    pub(crate) fn descriptor(&self) -> *mut c_void {
        self.descriptor.0
    }
}
