use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use aes::Aes128;
use cbc::Decryptor;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
#[cfg(target_os = "macos")]
use pbkdf2::pbkdf2_hmac;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use sha1::Sha1;
use sha2::{Digest as _, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_RECORDS: usize = 20_000;
const MAX_SECRET_BYTES: usize = 1024 * 1024;
const CHROMIUM_EPOCH_OFFSET_SECONDS: f64 = 11_644_473_600.0;
#[cfg(target_os = "macos")]
const CHROMIUM_SALT: &[u8] = b"saltysalt";
#[cfg(target_os = "macos")]
const CHROMIUM_ITERATIONS: u32 = 1003;
const CHROMIUM_IV: [u8; 16] = [b' '; 16];

type Aes128CbcDecryptor = Decryptor<Aes128>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileReadRequest {
    schema_version: u8,
    operation: String,
    source: BrowserSource,
    profile_path: String,
    include_cookies: bool,
    include_passwords: bool,
    #[serde(default)]
    cookie_domain_allowlist: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BrowserSource {
    Atlas,
    Chrome,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileReadResponse {
    schema_version: u8,
    ok: bool,
    cookies: Vec<ImportedCookie>,
    credentials: Vec<ImportedCredential>,
    cookie_failures: usize,
    password_failures: usize,
    error_code: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCookie {
    domain: String,
    name: String,
    value: String,
    path: String,
    secure: bool,
    http_only: bool,
    expiration_date: Option<f64>,
    same_site: ImportedSameSite,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ImportedSameSite {
    Unspecified,
    NoRestriction,
    Lax,
    Strict,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCredential {
    origin: String,
    username: String,
    password: String,
}

#[derive(Debug, Error)]
enum HelperError {
    #[error("the helper request is invalid")]
    InvalidRequest,
    #[error("the requested profile path is unsafe")]
    UnsafeProfilePath,
    #[error("the source browser encryption key is unavailable")]
    KeyUnavailable,
    #[error("the source browser data is unavailable")]
    DataUnavailable,
    #[error("the source browser uses an unsupported encryption format")]
    UnsupportedEncryption,
    #[error("profile I/O failed")]
    Io(#[from] io::Error),
    #[error("profile database access failed")]
    Sqlite(#[from] rusqlite::Error),
}

fn main() {
    let response = match run() {
        Ok(response) => response,
        Err(error) => ProfileReadResponse {
            schema_version: SCHEMA_VERSION,
            ok: false,
            cookies: Vec::new(),
            credentials: Vec::new(),
            cookie_failures: 0,
            password_failures: 0,
            error_code: Some(error_code(&error)),
        },
    };
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    if serde_json::to_writer(&mut writer, &response).is_err() || writer.write_all(b"\n").is_err() {
        std::process::exit(2);
    }
}

fn run() -> Result<ProfileReadResponse, HelperError> {
    let request = read_request()?;
    if request.schema_version != SCHEMA_VERSION
        || request.operation != "read-profile"
        || (!request.include_cookies && !request.include_passwords)
    {
        return Err(HelperError::InvalidRequest);
    }
    let profile_path = validate_profile_path(&request.profile_path)?;
    let key = read_chromium_key(request.source)?;
    let allowlist = normalize_domain_allowlist(&request.cookie_domain_allowlist)?;

    let (cookies, cookie_failures) = if request.include_cookies {
        read_cookies(&profile_path, &key, &allowlist)?
    } else {
        (Vec::new(), 0)
    };
    let (credentials, password_failures) = if request.include_passwords {
        read_credentials(&profile_path, &key)?
    } else {
        (Vec::new(), 0)
    };

    Ok(ProfileReadResponse {
        schema_version: SCHEMA_VERSION,
        ok: true,
        cookies,
        credentials,
        cookie_failures,
        password_failures,
        error_code: None,
    })
}

fn read_request() -> Result<ProfileReadRequest, HelperError> {
    let stdin = io::stdin();
    let mut bytes = Vec::new();
    BufReader::new(stdin.lock())
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(HelperError::InvalidRequest);
    }
    serde_json::from_slice(&bytes).map_err(|_| HelperError::InvalidRequest)
}

fn validate_profile_path(value: &str) -> Result<PathBuf, HelperError> {
    let requested = Path::new(value);
    if !requested.is_absolute() {
        return Err(HelperError::UnsafeProfilePath);
    }
    let metadata = fs::symlink_metadata(requested).map_err(|_| HelperError::DataUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(HelperError::UnsafeProfilePath);
    }
    fs::canonicalize(requested).map_err(|_| HelperError::UnsafeProfilePath)
}

fn open_profile_database(profile_path: &Path, name: &str) -> Result<Connection, HelperError> {
    let database_path = profile_path.join(name);
    let metadata =
        fs::symlink_metadata(&database_path).map_err(|_| HelperError::DataUnavailable)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(HelperError::UnsafeProfilePath);
    }
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    connection.busy_timeout(std::time::Duration::from_millis(250))?;
    Ok(connection)
}

fn read_cookies(
    profile_path: &Path,
    key: &[u8; 16],
    allowlist: &[String],
) -> Result<(Vec<ImportedCookie>, usize), HelperError> {
    let connection = open_profile_database(profile_path, "Cookies")?;
    let mut statement = connection.prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
         is_secure, is_httponly, samesite FROM cookies ORDER BY last_access_utc DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([MAX_RECORDS as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    })?;

    let mut imported = Vec::new();
    let mut failures = 0;
    for row in rows {
        let (domain, name, value, encrypted, cookie_path, expires, secure, http_only, same_site) =
            match row {
                Ok(value) => value,
                Err(_) => {
                    failures += 1;
                    continue;
                }
            };
        if !domain_allowed(&domain, allowlist) {
            continue;
        }
        let decrypted = if !value.is_empty() {
            Ok(value)
        } else {
            decrypt_chromium_value(&encrypted, key, Some(&domain))
        };
        let Ok(value) = decrypted else {
            failures += 1;
            continue;
        };
        if value.len() > MAX_SECRET_BYTES {
            failures += 1;
            continue;
        }
        imported.push(ImportedCookie {
            domain,
            name,
            value,
            path: if cookie_path.is_empty() {
                "/".to_owned()
            } else {
                cookie_path
            },
            secure: secure != 0,
            http_only: http_only != 0,
            expiration_date: chromium_time_to_unix(expires),
            same_site: match same_site {
                0 => ImportedSameSite::NoRestriction,
                1 => ImportedSameSite::Lax,
                2 => ImportedSameSite::Strict,
                _ => ImportedSameSite::Unspecified,
            },
        });
    }
    Ok((imported, failures))
}

fn read_credentials(
    profile_path: &Path,
    key: &[u8; 16],
) -> Result<(Vec<ImportedCredential>, usize), HelperError> {
    let connection = open_profile_database(profile_path, "Login Data")?;
    let mut statement = connection.prepare(
        "SELECT origin_url, signon_realm, username_value, password_value \
         FROM logins WHERE blacklisted_by_user = 0 ORDER BY date_last_used DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([MAX_RECORDS as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;

    let mut imported = Vec::new();
    let mut failures = 0;
    for row in rows {
        let (origin_url, signon_realm, username, encrypted) = match row {
            Ok(value) => value,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let origin =
            canonical_http_origin(&origin_url).or_else(|| canonical_http_origin(&signon_realm));
        let Some(origin) = origin else {
            failures += 1;
            continue;
        };
        let Ok(password) = decrypt_chromium_value(&encrypted, key, None) else {
            failures += 1;
            continue;
        };
        if password.is_empty()
            || password.len() > MAX_SECRET_BYTES
            || username.len() > MAX_SECRET_BYTES
        {
            failures += 1;
            continue;
        }
        imported.push(ImportedCredential {
            origin,
            username,
            password,
        });
    }
    Ok((imported, failures))
}

fn decrypt_chromium_value(
    encrypted: &[u8],
    key: &[u8; 16],
    cookie_domain: Option<&str>,
) -> Result<String, HelperError> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    if encrypted.starts_with(b"v20") {
        return Err(HelperError::UnsupportedEncryption);
    }
    if !encrypted.starts_with(b"v10") && !encrypted.starts_with(b"v11") {
        return String::from_utf8(encrypted.to_vec())
            .map_err(|_| HelperError::UnsupportedEncryption);
    }
    let mut payload = encrypted[3..].to_vec();
    let plaintext = Aes128CbcDecryptor::new(key.into(), (&CHROMIUM_IV).into())
        .decrypt_padded::<Pkcs7>(&mut payload)
        .map_err(|_| HelperError::UnsupportedEncryption)?;
    let plaintext = strip_cookie_host_digest(plaintext, cookie_domain);
    String::from_utf8(plaintext.to_vec()).map_err(|_| HelperError::UnsupportedEncryption)
}

fn strip_cookie_host_digest<'a>(value: &'a [u8], cookie_domain: Option<&str>) -> &'a [u8] {
    let Some(domain) = cookie_domain else {
        return value;
    };
    if value.len() < 32 {
        return value;
    }
    let digest = Sha256::digest(domain.as_bytes());
    if value[..32] == digest[..] {
        return &value[32..];
    }
    value
}

fn chromium_time_to_unix(value: i64) -> Option<f64> {
    if value <= 0 {
        return None;
    }
    let seconds = value as f64 / 1_000_000.0 - CHROMIUM_EPOCH_OFFSET_SECONDS;
    if seconds.is_finite() && seconds > 0.0 {
        Some(seconds)
    } else {
        None
    }
}

fn canonical_http_origin(value: &str) -> Option<String> {
    let scheme_end = value.find("://")?;
    let scheme = value[..scheme_end].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let remainder = &value[scheme_end + 3..];
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("{scheme}://{}", authority.to_ascii_lowercase()))
}

fn normalize_domain_allowlist(values: &[String]) -> Result<Vec<String>, HelperError> {
    values
        .iter()
        .map(|value| {
            let value = value.trim().trim_start_matches('.').to_ascii_lowercase();
            if value.is_empty()
                || value.len() > 253
                || value.contains('/')
                || value.contains(':')
                || value.contains(char::is_whitespace)
            {
                return Err(HelperError::InvalidRequest);
            }
            Ok(value)
        })
        .collect()
}

fn domain_allowed(domain: &str, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    allowlist
        .iter()
        .any(|allowed| domain == *allowed || domain.ends_with(&format!(".{allowed}")))
}

fn error_code(error: &HelperError) -> &'static str {
    match error {
        HelperError::InvalidRequest => "invalid_request",
        HelperError::UnsafeProfilePath => "unsafe_profile_path",
        HelperError::KeyUnavailable => "key_unavailable",
        HelperError::DataUnavailable => "data_unavailable",
        HelperError::UnsupportedEncryption => "unsupported_encryption",
        HelperError::Io(_) => "io_error",
        HelperError::Sqlite(_) => "database_error",
    }
}

#[cfg(target_os = "macos")]
fn read_chromium_key(source: BrowserSource) -> Result<[u8; 16], HelperError> {
    use security_framework::passwords::get_generic_password;

    let candidates: &[(&str, &str)] = match source {
        BrowserSource::Chrome => &[("Chrome Safe Storage", "Chrome")],
        BrowserSource::Atlas => &[
            ("ChatGPT Atlas Safe Storage", "ChatGPT Atlas"),
            ("Atlas Safe Storage", "Atlas"),
            ("ChatGPT Safe Storage", "ChatGPT"),
            ("com.openai.atlas Safe Storage", "com.openai.atlas"),
        ],
    };
    for (service, account) in candidates {
        let Ok(password) = get_generic_password(service, account) else {
            continue;
        };
        if password.is_empty() {
            continue;
        }
        let mut key = [0_u8; 16];
        pbkdf2_hmac::<Sha1>(&password, CHROMIUM_SALT, CHROMIUM_ITERATIONS, &mut key);
        return Ok(key);
    }
    Err(HelperError::KeyUnavailable)
}

#[cfg(not(target_os = "macos"))]
fn read_chromium_key(_source: BrowserSource) -> Result<[u8; 16], HelperError> {
    Err(HelperError::KeyUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::Encryptor;
    use cbc::cipher::BlockModeEncrypt;

    type Aes128CbcEncryptor = Encryptor<Aes128>;

    fn encrypted_fixture(plaintext: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let mut buffer = vec![0_u8; plaintext.len() + 16];
        buffer[..plaintext.len()].copy_from_slice(plaintext);
        let encrypted = Aes128CbcEncryptor::new(key.into(), (&CHROMIUM_IV).into())
            .encrypt_padded::<Pkcs7>(&mut buffer, plaintext.len())
            .expect("fixture encryption");
        [b"v10".as_slice(), encrypted].concat()
    }

    #[test]
    fn decrypts_chromium_cbc_and_strips_cookie_host_digest() {
        let key = [7_u8; 16];
        let domain = ".example.com";
        let plaintext = [
            Sha256::digest(domain.as_bytes()).as_slice(),
            b"cookie-secret",
        ]
        .concat();
        let encrypted = encrypted_fixture(&plaintext, &key);

        assert_eq!(
            decrypt_chromium_value(&encrypted, &key, Some(domain)).unwrap(),
            "cookie-secret"
        );
    }

    #[test]
    fn rejects_v20_app_bound_ciphertext() {
        let error = decrypt_chromium_value(b"v20ciphertext", &[0_u8; 16], None)
            .expect_err("v20 is intentionally unsupported");
        assert!(matches!(error, HelperError::UnsupportedEncryption));
    }

    #[test]
    fn enforces_cookie_domain_allowlist_at_registrable_boundaries() {
        let allowlist = vec!["example.com".to_owned()];
        assert!(domain_allowed(".example.com", &allowlist));
        assert!(domain_allowed("login.example.com", &allowlist));
        assert!(!domain_allowed("notexample.com", &allowlist));
    }
}
