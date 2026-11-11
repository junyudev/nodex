use super::files::{invalid, open_ntfs};
use crate::windows::wide;
use serde::Serialize;
use std::ffi::CStr;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Cryptography::*;
use windows_sys::Win32::Security::WinTrust::*;
use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
use x509_parser::asn1_rs::ToDer;
use x509_parser::x509::{AttributeTypeAndValue, X509Name};

#[derive(Serialize)]
pub struct CertificateIdentity {
    subject: String,
    issuer: String,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Authenticode {
    Verified {
        signature: &'static str,
        chain: Vec<CertificateIdentity>,
        code_signing_eku: bool,
        timestamp_present: bool,
        revocation: &'static str,
    },
    Rejected {
        signature: &'static str,
        trust_status: String,
    },
}

fn embedded_pe(file: &mut File) -> io::Result<bool> {
    let mut dos = [0; 64];
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Err(invalid("expected a PE file"));
    }
    file.seek(SeekFrom::Start(
        u32::from_le_bytes(dos[60..64].try_into().unwrap()).into(),
    ))?;
    let mut pe = [0; 26];
    file.read_exact(&mut pe)?;
    let offset = match (&pe[..4], u16::from_le_bytes([pe[24], pe[25]])) {
        (b"PE\0\0", 0x10b) => 128,
        (b"PE\0\0", 0x20b) => 144,
        _ => return Err(invalid("invalid PE header")),
    };
    let optional_length = u16::from_le_bytes([pe[20], pe[21]]);
    if optional_length < offset + 8 {
        return Ok(false);
    }
    file.seek(SeekFrom::Current(i64::from(offset) - 38))?;
    let mut directories = [0; 4];
    file.read_exact(&mut directories)?;
    file.seek(SeekFrom::Current(32))?;
    let mut certificate = [0; 8];
    file.read_exact(&mut certificate)?;
    file.rewind()?;
    Ok(u32::from_le_bytes(directories) >= 5
        && certificate[..4] != [0; 4]
        && certificate[4..] != [0; 4])
}

struct Trust(WINTRUST_DATA);
impl Drop for Trust {
    fn drop(&mut self) {
        if self.0.hWVTStateData.is_null() {
            return;
        }
        self.0.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            WinVerifyTrust(
                null_mut(),
                &mut WINTRUST_ACTION_GENERIC_VERIFY_V2.clone(),
                (&mut self.0 as *mut WINTRUST_DATA).cast(),
            );
        }
    }
}

pub fn verify_authenticode(path: &Path) -> io::Result<Authenticode> {
    inspect_signature(path, false)
}

pub(super) fn inspect_signature(path: &Path, require_revocation: bool) -> io::Result<Authenticode> {
    let (mut chain, reparse) = open_ntfs(path, GENERIC_READ | FILE_READ_ATTRIBUTES)?;
    let mut file = chain.pop().expect("checked path");
    if reparse {
        return Err(invalid("PE path is a reparse point"));
    }
    if !embedded_pe(&mut file)? {
        return Ok(rejected("none", TRUST_E_NOSIGNATURE));
    }
    let name = wide(path)?;
    let mut input = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: name.as_ptr(),
        hFile: file.as_raw_handle(),
        pgKnownSubject: null_mut(),
    };
    verify(&mut input, true, require_revocation)
}

fn rejected(signature: &'static str, status: i32) -> Authenticode {
    Authenticode::Rejected {
        signature,
        trust_status: format!("0x{:08X}", status as u32),
    }
}

fn verify(
    input: &mut WINTRUST_FILE_INFO,
    check_revocation: bool,
    require_revocation: bool,
) -> io::Result<Authenticode> {
    let mut signature = WINTRUST_SIGNATURE_SETTINGS {
        cbStruct: size_of::<WINTRUST_SIGNATURE_SETTINGS>() as u32,
        dwFlags: WSS_VERIFY_SPECIFIC,
        ..Default::default()
    };
    let mut trust = Trust(WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: input },
        dwStateAction: WTD_STATEACTION_VERIFY,
        pSignatureSettings: &mut signature,
        fdwRevocationChecks: WTD_REVOKE_NONE, // Provider flags below control chain revocation.
        dwProvFlags: if require_revocation {
            0
        } else {
            WTD_CACHE_ONLY_URL_RETRIEVAL
        } | WTD_DISABLE_MD2_MD4
            | if check_revocation {
                WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT
            } else {
                WTD_REVOCATION_CHECK_NONE
            },
        ..Default::default()
    });
    let status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut WINTRUST_ACTION_GENERIC_VERIFY_V2.clone(),
            (&mut trust.0 as *mut WINTRUST_DATA).cast(),
        )
    };
    let data = if trust.0.hWVTStateData.is_null() {
        null_mut()
    } else {
        unsafe { WTHelperProvDataFromStateData(trust.0.hWVTStateData) }
    };
    let signer = if data.is_null() {
        None
    } else {
        unsafe { WTHelperGetProvSignerFromChain(data, 0, 0, 0).as_ref() }
    };
    if status != 0 {
        // Retry only missing revocation evidence. A known revocation or any other
        // trust error remains fatal. The retry still verifies digest and chain.
        if check_revocation
            && !require_revocation
            && matches!(
                status,
                CRYPT_E_REVOCATION_OFFLINE
                    | CRYPT_E_NO_REVOCATION_CHECK
                    | CERT_E_REVOCATION_FAILURE
            )
            && signer.is_some_and(|signer| revocation_unavailable(signer))
        {
            drop(trust);
            return verify(input, false, false);
        }
        return Ok(rejected("embedded", status));
    }
    if signature.dwVerifiedSigIndex != 0 {
        return Err(io::Error::other(
            "WinVerifyTrust selected a different signature",
        ));
    }
    let signer = signer
        .filter(|signer| signer.csCertChain > 0 && !signer.pasCertChain.is_null())
        .ok_or_else(|| io::Error::other("WinVerifyTrust returned no signer chain"))?;
    let mut chain = Vec::new();
    for index in 0..signer.csCertChain {
        let cert = unsafe { (*signer.pasCertChain.add(index as usize)).pCert };
        if cert.is_null() {
            return Err(io::Error::other(
                "WinVerifyTrust returned an incomplete signer chain",
            ));
        }
        let encoded = unsafe {
            std::slice::from_raw_parts((*cert).pbCertEncoded, (*cert).cbCertEncoded as usize)
        };
        let (_, cert) = x509_parser::parse_x509_certificate(encoded).map_err(io::Error::other)?;
        chain.push(CertificateIdentity {
            subject: distinguished_name(cert.subject())?,
            issuer: distinguished_name(cert.issuer())?,
        });
    }
    let cert = unsafe { (*signer.pasCertChain).pCert };
    Ok(Authenticode::Verified {
        signature: "embedded",
        chain,
        code_signing_eku: has_code_signing_eku(cert)?,
        timestamp_present: signer.csCounterSigners > 0,
        revocation: if require_revocation {
            "onlineChecked"
        } else if check_revocation {
            "cacheChecked"
        } else {
            "cacheUnavailable"
        },
    })
}

fn revocation_unavailable(signer: &CRYPT_PROVIDER_SGNR) -> bool {
    let Some(chain) = (unsafe { signer.pChainContext.as_ref() }) else {
        return false;
    };
    let mask = chain.TrustStatus.dwErrorStatus;
    mask & CERT_TRUST_IS_REVOKED == 0
        && mask & (CERT_TRUST_REVOCATION_STATUS_UNKNOWN | CERT_TRUST_IS_OFFLINE_REVOCATION) != 0
        && (0..signer.csCounterSigners).all(|index| {
            let timestamp = unsafe { &*signer.pasCounterSigners.add(index as usize) };
            unsafe { timestamp.pChainContext.as_ref() }
                .is_some_and(|chain| chain.TrustStatus.dwErrorStatus & CERT_TRUST_IS_REVOKED == 0)
        })
}

// The lock uses RFC 2253. CryptoAPI display strings use different RDN order,
// whitespace, and quoting, so format the same certificate's DER directly.
fn distinguished_name(name: &X509Name<'_>) -> io::Result<String> {
    let rdns = name.iter_rdn().collect::<Vec<_>>();
    let mut result = Vec::with_capacity(rdns.len());
    for rdn in rdns.into_iter().rev() {
        let attributes = rdn
            .iter()
            .map(distinguished_attribute)
            .collect::<io::Result<Vec<_>>>()?;
        result.push(attributes.join("+"));
    }
    Ok(result.join(","))
}

fn distinguished_attribute(attribute: &AttributeTypeAndValue<'_>) -> io::Result<String> {
    let oid = attribute.attr_type().to_id_string();
    let key = match oid.as_str() {
        "2.5.4.3" => "CN",
        "2.5.4.6" => "C",
        "2.5.4.7" => "L",
        "2.5.4.8" => "ST",
        "2.5.4.9" => "STREET",
        "2.5.4.10" => "O",
        "2.5.4.11" => "OU",
        "0.9.2342.19200300.100.1.25" => "DC",
        "0.9.2342.19200300.100.1.1" => "UID",
        _ => {
            return Ok(format!(
                "{oid}=#{}",
                hex::encode_upper(
                    attribute
                        .attr_value()
                        .to_der_vec()
                        .map_err(io::Error::other)?
                )
            ));
        }
    };
    let value = attribute.as_str().map_err(io::Error::other)?;
    let mut result = format!("{key}=");
    for (index, byte) in value.bytes().enumerate() {
        match byte {
            0..=31 | 127..=255 => write!(result, "\\{byte:02X}").expect("write to String"),
            b',' | b'+' | b'"' | b'\\' | b'<' | b'>' | b';' => {
                result.push('\\');
                result.push(char::from(byte));
            }
            b' ' if index == 0 || index + 1 == value.len() => result.push_str("\\ "),
            b'#' if index == 0 => result.push_str("\\#"),
            _ => result.push(char::from(byte)),
        }
    }
    Ok(result)
}

fn has_code_signing_eku(cert: *const CERT_CONTEXT) -> io::Result<bool> {
    let mut length = 0;
    let flags = CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG;
    if unsafe { CertGetEnhancedKeyUsage(cert, flags, null_mut(), &mut length) } == 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(CRYPT_E_NOT_FOUND) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    let usage = buffer.as_mut_ptr().cast::<CTL_USAGE>();
    if unsafe { CertGetEnhancedKeyUsage(cert, flags, usage, &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(
        (0..unsafe { (*usage).cUsageIdentifier }).any(|index| unsafe {
            CStr::from_ptr((*(*usage).rgpszUsageIdentifier.add(index as usize)).cast()).to_bytes()
                == b"1.3.6.1.5.5.7.3.3"
        }),
    )
}
