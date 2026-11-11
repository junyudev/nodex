use super::files::invalid;
use crate::windows::{handle, process_sid, wide};
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE, NTSTATUS, RtlNtStatusToDosError,
};
use windows_sys::Win32::Storage::FileSystem::{CommitTransaction, CreateTransaction, DELETE};
use windows_sys::Win32::System::Registry::*;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Browser {
    Chrome,
    Edge,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RegistryView {
    X86,
    X64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostKey {
    pub browser: Browser,
    pub view: RegistryView,
    pub host: String,
}

impl HostKey {
    fn path(&self) -> io::Result<Vec<u16>> {
        let valid = !self.host.is_empty()
            && self.host.len() <= 255
            && self.host.split('.').all(|label| {
                !label.is_empty()
                    && label
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
            });
        if !valid {
            return Err(invalid("invalid native messaging host name"));
        }
        let browser = match self.browser {
            Browser::Chrome => r"Google\Chrome",
            Browser::Edge => r"Microsoft\Edge",
        };
        wide(format!(
            r"Software\{browser}\NativeMessagingHosts\{}",
            self.host
        ))
    }
    fn view(&self) -> u32 {
        match self.view {
            RegistryView::X86 => KEY_WOW64_32KEY,
            RegistryView::X64 => KEY_WOW64_64KEY,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryValue {
    pub kind: u32,
    pub data_hex: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub key: HostKey,
    pub installed: RegistryValue,
    pub previous: Option<RegistryValue>,
    pub created_key: bool,
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryKey(
        key: HKEY,
        information_class: u32,
        output: *mut c_void,
        capacity: u32,
        written: *mut u32,
    ) -> NTSTATUS;
    fn NtDeleteKey(key: HKEY) -> NTSTATUS;
}

/// HKCU is the only entry point. Check the physical hive as well, since a
/// registry symbolic link can redirect a name into another hive.
fn require_current_host_key(key: &Key, path: &[u16]) -> io::Result<()> {
    let mut data = [0u32; 1024];
    let mut written = 0;
    let result = unsafe {
        NtQueryKey(
            key.0,
            3,
            data.as_mut_ptr().cast(),
            size_of_val(&data) as u32,
            &mut written,
        )
    }; // KeyNameInformation
    if result < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    let length = data[0];
    if length % 2 != 0
        || length > written.saturating_sub(4)
        || written as usize > size_of_val(&data)
    {
        return Err(invalid("invalid registry key name"));
    }
    let name = String::from_utf16(unsafe {
        std::slice::from_raw_parts(data.as_ptr().add(1).cast::<u16>(), length as usize / 2)
    })
    .map_err(io::Error::other)?;
    let sid = process_sid(None)?;
    let path = String::from_utf16(&path[..path.len() - 1]).map_err(io::Error::other)?;
    if !name.eq_ignore_ascii_case(&format!(r"\REGISTRY\USER\{sid}\{path}")) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "registry key resolves outside the selected user host key",
        ));
    }
    Ok(())
}

const MAX_VALUE_BYTES: u32 = 65536;

fn status(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

fn open(key: &HostKey, access: u32, transaction: HANDLE) -> io::Result<Option<Key>> {
    let path = key.path()?;
    let access = access | key.view();
    let mut raw = null_mut();
    let code = unsafe {
        if transaction.is_null() {
            RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut raw)
        } else {
            RegOpenKeyTransactedW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                access,
                &mut raw,
                transaction,
                null(),
            )
        }
    };
    if matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    status(code)?;
    let key = Key(raw);
    require_current_host_key(&key, &path)?;
    Ok(Some(key))
}

fn value(key: Option<&Key>) -> io::Result<Option<RegistryValue>> {
    let Some(key) = key else {
        return Ok(None);
    };
    let mut data = vec![0; MAX_VALUE_BYTES as usize];
    let mut length = MAX_VALUE_BYTES;
    let mut kind = 0;
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            null(),
            null(),
            &mut kind,
            data.as_mut_ptr(),
            &mut length,
        )
    };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    status(code)?;
    Ok(Some(RegistryValue {
        kind,
        data_hex: hex::encode(&data[..length as usize]),
    }))
}

pub fn read_registration(key: &HostKey) -> io::Result<Option<RegistryValue>> {
    value(open(key, KEY_QUERY_VALUE, null_mut())?.as_ref())
}

fn transaction<T>(apply: impl FnOnce(HANDLE) -> io::Result<T>) -> io::Result<T> {
    let transaction =
        handle(unsafe { CreateTransaction(null_mut(), null_mut(), 0, 0, 0, 5000, null()) })?;
    let raw = transaction.as_raw_handle();
    let result = apply(raw)?;
    if unsafe { CommitTransaction(raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result)
}

fn set(key: &Key, value: &RegistryValue) -> io::Result<()> {
    if value.data_hex.len() > MAX_VALUE_BYTES as usize * 2 {
        return Err(invalid("registry value too large"));
    }
    let data = hex::decode(&value.data_hex).map_err(io::Error::other)?;
    status(unsafe {
        RegSetValueExW(
            key.0,
            null(),
            0,
            value.kind,
            data.as_ptr(),
            data.len() as u32,
        )
    })
}

/// Compare against the value the caller observed before asking to take ownership.
/// Transactional registry operations keep external writers from being overwritten
/// between the comparison and the write.
pub fn write_registration(
    key: &HostKey,
    expected: Option<RegistryValue>,
    manifest: &Path,
) -> io::Result<Registration> {
    if !manifest.is_absolute() {
        return Err(invalid("manifest path must be absolute"));
    }
    let path = key.path()?;
    let installed = RegistryValue {
        kind: REG_SZ,
        data_hex: hex::encode(
            wide(manifest)?
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        ),
    };
    transaction(|transaction| {
        let mut raw = null_mut();
        let mut disposition = 0;
        status(unsafe {
            RegCreateKeyTransactedW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE | key.view(),
                null(),
                &mut raw,
                &mut disposition,
                transaction,
                null(),
            )
        })?;
        let opened = Key(raw);
        require_current_host_key(&opened, &path)?;
        let previous = value(Some(&opened))?;
        if previous != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "native messaging registration changed",
            ));
        }
        set(&opened, &installed)?;
        Ok(Registration {
            key: key.clone(),
            installed,
            previous,
            created_key: disposition == REG_CREATED_NEW_KEY,
        })
    })
}

pub fn restore_registration(key: &HostKey, receipt: &Registration) -> io::Result<bool> {
    if *key != receipt.key {
        return Err(invalid(
            "registration receipt belongs to a different host key",
        ));
    }
    transaction(|transaction| {
        let Some(opened) = open(
            key,
            KEY_QUERY_VALUE | KEY_SET_VALUE | if receipt.created_key { DELETE } else { 0 },
            transaction,
        )?
        else {
            return Ok(false);
        };
        if value(Some(&opened))?.as_ref() != Some(&receipt.installed) {
            return Ok(false);
        }
        if let Some(previous) = &receipt.previous {
            set(&opened, previous)?;
        } else {
            status(unsafe { RegDeleteValueW(opened.0, null()) })?;
            if receipt.created_key && empty(&opened)? {
                // Delete the validated transaction-bound handle, without
                // re-resolving an HKCU path that could be renamed or redirected.
                let result = unsafe { NtDeleteKey(opened.0) };
                if result < 0 {
                    return Err(io::Error::from_raw_os_error(
                        unsafe { RtlNtStatusToDosError(result) } as i32,
                    ));
                }
            }
        }
        Ok(true)
    })
}

fn empty(key: &Key) -> io::Result<bool> {
    let mut subkeys = 0;
    let mut values = 0;
    status(unsafe {
        RegQueryInfoKeyW(
            key.0,
            null_mut(),
            null_mut(),
            null(),
            &mut subkeys,
            null_mut(),
            null_mut(),
            &mut values,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    })?;
    Ok(subkeys == 0 && values == 0)
}
