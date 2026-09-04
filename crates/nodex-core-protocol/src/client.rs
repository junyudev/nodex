use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use nodex_core_contracts::VersionedModuleContract;
use nodex_core_contracts::administration::{StoreAdministrationIntent, StoreAdministrationRead};
use nodex_core_contracts::automation::{AutomationIntent, AutomationRead};
use nodex_core_contracts::database::{DatabaseIntent, DatabaseRead};
use nodex_core_contracts::document::{OwnedDocumentIntent, OwnedDocumentRead};
use nodex_core_contracts::library::{LibraryIntent, LibraryRead};
use nodex_core_contracts::workspace::{ProjectWorkspaceIntent, ProjectWorkspaceRead};
use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::{
    AutomationApplyRequest, AutomationApplyResponse, AutomationReadRequest, AutomationReadResponse,
    ClientIdentity, ClientKind, CoreSelectionDisposition, CoreSelectionResult,
    DatabaseApplyRequest, DatabaseApplyResponse, DatabaseReadRequest, DatabaseReadResponse,
    HandshakeRequest, HandshakeResponse, HealthResponse, LibraryApplyRequest, LibraryApplyResponse,
    LibraryReadRequest, LibraryReadResponse, MAX_DOCUMENT_JSON_REQUEST_BYTES,
    MAX_DOCUMENT_RESPONSE_BYTES, MAX_FILE_BLOB_BYTES, MAX_ORDINARY_JSON_REQUEST_BYTES,
    MAX_ORDINARY_JSON_RESPONSE_BYTES, OwnedDocumentApplyRequest, OwnedDocumentApplyResponse,
    OwnedDocumentReadRequest, OwnedDocumentReadResponse, ProjectWorkspaceApplyRequest,
    ProjectWorkspaceApplyResponse, ProjectWorkspaceReadRequest, ProjectWorkspaceReadResponse,
    RuntimeDescriptor, RuntimeGenerationIdentity, ShutdownRequest, ShutdownResponse,
    StoreAdministrationApplyRequest, StoreAdministrationApplyResponse,
    StoreAdministrationReadRequest, StoreAdministrationReadResponse, TRANSPORT_PROTOCOL_MAX,
    TRANSPORT_PROTOCOL_MIN, canonical_manifest_digest, core_client_requirements,
    evaluate_compatibility,
};

const PRIVATE_MODE: u32 = 0o600;
const RUNTIME_DIRECTORY_MODE: u32 = 0o700;
const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
const MAX_AUTH_BYTES: u64 = 128;
const MAX_HTTP_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Store Administration includes whole-Profile backup and restore operations.
// Their bounded maintenance window is intentionally longer than ordinary API work.
const ADMINISTRATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const ADMINISTRATION_APPLY_PATH: &str = "/core/v1/modules/administration/apply";
// Cold selection includes one-time Store backup and migration before Core can
// publish its runtime descriptor, which can exceed ten seconds on Intel Macs.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

const CONNECTION_HEADER: &str = "x-nodex-connection-id";
const CONNECTION_BINDING_HEADER: &str = "x-nodex-connection-binding";
const PROJECT_HEADER: &str = "x-nodex-project-id";
const DATABASE_SCOPE_HEADER: &str = "x-nodex-database-scope";
const DOCUMENT_SCOPE_HEADER: &str = "x-nodex-document-scope";
const LIBRARY_SCOPE: &str = "library";

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("Core runtime is invalid: {0}")]
    InvalidRuntime(String),
    #[error("Core protocol is incompatible: {0}")]
    ProtocolIncompatible(String),
    #[error("Core returned HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("Core request exceeds {maximum} bytes ({actual} bytes)")]
    RequestTooLarge { maximum: usize, actual: usize },
    #[error("Core response exceeds {maximum} bytes (observed at least {observed_at_least} bytes)")]
    ResponseTooLarge {
        maximum: usize,
        observed_at_least: usize,
    },
    #[error("Core response could not be encoded or decoded: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Core process could not be located: {0}")]
    CoreExecutable(String),
    #[error("Core did not become ready: {0}")]
    Startup(String),
}

#[derive(Clone, Debug)]
pub struct CoreClient {
    socket: PathBuf,
    auth: String,
    connection_id: String,
    connection_binding: String,
    pub descriptor: RuntimeDescriptor,
    pub handshake: HandshakeResponse,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileBlobResponse {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub etag: String,
}

impl CoreClient {
    pub fn connect(home: &Path, build_id: &str) -> Result<Self, ClientError> {
        let runtime = RuntimeFiles::read(home)?;
        let requirements = core_client_requirements();
        evaluate_compatibility(
            &requirements,
            &runtime.descriptor.manifest,
            &runtime.descriptor.actual_store_format,
        )
        .map_err(|mismatches| ClientError::ProtocolIncompatible(format!("{mismatches:?}")))?;
        let connection_id = format!("native-cli:{}", random_hex(16)?);
        let handshake = request_json::<_, HandshakeResponse>(
            &runtime.socket,
            &runtime.auth,
            "/core/v1/handshake",
            &HandshakeRequest {
                requirements,
                client: ClientIdentity {
                    kind: ClientKind::NativeCli,
                    build_id: build_id.to_owned(),
                },
                connection_id: connection_id.clone(),
                expected_generation: RuntimeGenerationIdentity::from(&runtime.descriptor),
            },
            &[],
        )?;
        validate_handshake(&runtime.descriptor, &handshake)?;
        Ok(Self {
            socket: runtime.socket,
            auth: runtime.auth,
            connection_id,
            connection_binding: handshake.connection_binding.clone(),
            descriptor: runtime.descriptor,
            handshake,
        })
    }

    pub fn health(&self) -> Result<HealthResponse, ClientError> {
        request_without_body(&self.socket, &self.auth, "/core/v1/health", &[])
    }

    pub fn library_read(
        &self,
        project_id: Option<&str>,
        read: LibraryRead,
    ) -> Result<LibraryReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/library/read",
            &LibraryReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                read,
            }),
            ScopeHeaders::project(project_id),
        )
    }

    pub fn library_apply(
        &self,
        project_id: Option<&str>,
        request: nodex_core_contracts::ModuleApplyRequest<LibraryIntent>,
    ) -> Result<LibraryApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/library/apply",
            &LibraryApplyRequest(request),
            ScopeHeaders::project(project_id),
        )
    }

    /// Streams exact File bytes to Core and receives an opaque receipt that can
    /// only be consumed by the matching durable File mutation.
    pub fn prepare_file_blob(
        &self,
        project_id: Option<&str>,
        operation_id: &str,
        store_epoch: &str,
        idempotency_slot: Option<&str>,
        source: &mut impl Read,
        byte_length: u64,
    ) -> Result<nodex_core_contracts::library::PreparedBlobReceipt, ClientError> {
        if byte_length > MAX_FILE_BLOB_BYTES as u64 {
            return Err(ClientError::RequestTooLarge {
                maximum: MAX_FILE_BLOB_BYTES,
                actual: usize::try_from(byte_length).unwrap_or(usize::MAX),
            });
        }
        let idempotency_slot = idempotency_slot
            .map(|slot| format!("&idempotency_slot={}", percent_encode(slot)))
            .unwrap_or_default();
        let path = format!(
            "/core/v1/files/blobs/prepare?operation_id={}&store_epoch={}{}",
            percent_encode(operation_id),
            percent_encode(store_epoch),
            idempotency_slot,
        );
        let body = connected_stream_request(
            self,
            "POST",
            &path,
            source,
            byte_length,
            ScopeHeaders::project(project_id),
            MAX_ORDINARY_JSON_RESPONSE_BYTES,
        )?;
        serde_json::from_slice(&body.bytes).map_err(ClientError::from)
    }

    /// Streams exact bytes to Core and receives an opaque receipt that can be
    /// consumed only by the matching durable content mutation.
    pub fn prepare_blob(
        &self,
        project_id: Option<&str>,
        operation_id: &str,
        store_epoch: &str,
        idempotency_slot: Option<&str>,
        source: &mut impl Read,
        byte_length: u64,
    ) -> Result<nodex_core_contracts::library::PreparedBlobReceipt, ClientError> {
        if byte_length > crate::MAX_MANAGED_BLOB_BYTES as u64 {
            return Err(ClientError::RequestTooLarge {
                maximum: crate::MAX_MANAGED_BLOB_BYTES,
                actual: usize::try_from(byte_length).unwrap_or(usize::MAX),
            });
        }
        let idempotency_slot = idempotency_slot
            .map(|slot| format!("&idempotency_slot={}", percent_encode(slot)))
            .unwrap_or_default();
        let path = format!(
            "/core/v1/blobs/prepare?operation_id={}&store_epoch={}{}",
            percent_encode(operation_id),
            percent_encode(store_epoch),
            idempotency_slot,
        );
        let body = connected_stream_request(
            self,
            "POST",
            &path,
            source,
            byte_length,
            ScopeHeaders::project(project_id),
            MAX_ORDINARY_JSON_RESPONSE_BYTES,
        )?;
        serde_json::from_slice(&body.bytes).map_err(ClientError::from)
    }

    /// Reads one authorized File version by semantic identity. Blob hashes and
    /// Profile filesystem locations never cross this boundary.
    pub fn read_file_blob(
        &self,
        project_id: Option<&str>,
        file_id: &str,
        source: &nodex_core_contracts::library::LibraryFileReadSource,
        version: Option<i64>,
    ) -> Result<FileBlobResponse, ClientError> {
        use nodex_core_contracts::library::LibraryFileReadSource;
        let fields = match source {
            LibraryFileReadSource::Direct => vec![("kind", "direct")],
            LibraryFileReadSource::Page { page_id } => {
                vec![("kind", "page"), ("page_id", page_id.as_str())]
            }
            LibraryFileReadSource::DocumentRevision {
                document_id,
                revision_id,
            } => vec![
                ("kind", "document_revision"),
                ("document_id", document_id.as_str()),
                ("revision_id", revision_id.as_str()),
            ],
            LibraryFileReadSource::Canvas {
                canvas_id,
                scene_file_id,
            } => vec![
                ("kind", "canvas"),
                ("canvas_id", canvas_id.as_str()),
                ("scene_file_id", scene_file_id.as_str()),
            ],
            LibraryFileReadSource::CanvasRevision {
                document_id,
                revision_id,
                scene_file_id,
            } => vec![
                ("kind", "canvas_revision"),
                ("document_id", document_id.as_str()),
                ("revision_id", revision_id.as_str()),
                ("scene_file_id", scene_file_id.as_str()),
            ],
            LibraryFileReadSource::CanvasRecovery {
                document_id,
                draft_id,
                scene_file_id,
            } => vec![
                ("kind", "canvas_recovery"),
                ("document_id", document_id.as_str()),
                ("draft_id", draft_id.as_str()),
                ("scene_file_id", scene_file_id.as_str()),
            ],
            LibraryFileReadSource::RecoveryDraft {
                document_id,
                draft_id,
            } => vec![
                ("kind", "recovery_draft"),
                ("document_id", document_id.as_str()),
                ("draft_id", draft_id.as_str()),
            ],
        };
        let query = fields
            .into_iter()
            .map(|(key, value)| format!("{key}={}", percent_encode(value)))
            .collect::<Vec<_>>()
            .join("&");
        let version = version
            .map(|version| format!("&version={version}"))
            .unwrap_or_default();
        let path = format!(
            "/core/v1/files/blobs/{}?{query}{version}",
            percent_encode(file_id)
        );
        self.read_file_blob_path(project_id, &path, MAX_FILE_BLOB_BYTES)
    }

    pub fn read_thread_asset_blob(
        &self,
        project_id: Option<&str>,
        thread_id: &str,
        content_hash: &str,
    ) -> Result<FileBlobResponse, ClientError> {
        self.read_file_blob_path(
            project_id,
            &format!(
                "/core/v1/threads/{}/blobs/{}",
                percent_encode(thread_id),
                percent_encode(content_hash)
            ),
            crate::MAX_MANAGED_BLOB_BYTES,
        )
    }

    fn read_file_blob_path(
        &self,
        project_id: Option<&str>,
        path: &str,
        maximum_bytes: usize,
    ) -> Result<FileBlobResponse, ClientError> {
        let mut empty = io::empty();
        let response = connected_stream_request(
            self,
            "GET",
            path,
            &mut empty,
            0,
            ScopeHeaders::project(project_id),
            maximum_bytes,
        )?;
        let mime_type = response
            .header("content-type")
            .unwrap_or("application/octet-stream")
            .to_owned();
        let etag = response
            .header("etag")
            .unwrap_or_default()
            .trim_matches('"')
            .to_owned();
        Ok(FileBlobResponse {
            bytes: response.bytes,
            mime_type,
            etag,
        })
    }

    pub fn database_read(
        &self,
        project_id: Option<&str>,
        read: DatabaseRead,
    ) -> Result<DatabaseReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/database/read",
            &DatabaseReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: nodex_core_contracts::database::DATABASE_CONTRACT_VERSION,
                read,
            }),
            ScopeHeaders::database(project_id),
        )
    }

    pub fn database_apply(
        &self,
        project_id: Option<&str>,
        request: nodex_core_contracts::ModuleApplyRequest<Vec<DatabaseIntent>>,
    ) -> Result<DatabaseApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/database/apply",
            &DatabaseApplyRequest(request),
            ScopeHeaders::database(project_id),
        )
    }

    pub fn document_read(
        &self,
        project_id: Option<&str>,
        library_scope: bool,
        read: OwnedDocumentRead,
    ) -> Result<OwnedDocumentReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/document/read",
            &OwnedDocumentReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::document::OwnedDocumentContract as VersionedModuleContract>::VERSION,
                read,
            }),
            ScopeHeaders::document(project_id, library_scope),
        )
    }

    pub fn document_apply(
        &self,
        project_id: Option<&str>,
        library_scope: bool,
        request: nodex_core_contracts::ModuleApplyRequest<OwnedDocumentIntent>,
    ) -> Result<OwnedDocumentApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/document/apply",
            &OwnedDocumentApplyRequest(request),
            ScopeHeaders::document(project_id, library_scope),
        )
    }

    pub fn workspace_read(
        &self,
        project_id: Option<&str>,
        read: ProjectWorkspaceRead,
    ) -> Result<ProjectWorkspaceReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/workspace/read",
            &ProjectWorkspaceReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::workspace::ProjectWorkspaceContract as VersionedModuleContract>::VERSION,
                read,
            }),
            ScopeHeaders::project(project_id),
        )
    }

    pub fn workspace_apply(
        &self,
        project_id: Option<&str>,
        request: nodex_core_contracts::ModuleApplyRequest<ProjectWorkspaceIntent>,
    ) -> Result<ProjectWorkspaceApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/workspace/apply",
            &ProjectWorkspaceApplyRequest(request),
            ScopeHeaders::project(project_id),
        )
    }

    pub fn automation_read(
        &self,
        project_id: Option<&str>,
        read: AutomationRead,
    ) -> Result<AutomationReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/automation/read",
            &AutomationReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::automation::AutomationContract as VersionedModuleContract>::VERSION,
                read,
            }),
            ScopeHeaders::project(project_id),
        )
    }

    pub fn automation_apply(
        &self,
        project_id: Option<&str>,
        request: nodex_core_contracts::ModuleApplyRequest<AutomationIntent>,
    ) -> Result<AutomationApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/automation/apply",
            &AutomationApplyRequest(request),
            ScopeHeaders::project(project_id),
        )
    }

    pub fn administration_read(
        &self,
        read: StoreAdministrationRead,
    ) -> Result<StoreAdministrationReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/administration/read",
            &StoreAdministrationReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::administration::StoreAdministrationContract as VersionedModuleContract>::VERSION,
                read,
            }),
            ScopeHeaders::default(),
        )
    }

    pub fn administration_apply(
        &self,
        request: nodex_core_contracts::ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/administration/apply",
            &StoreAdministrationApplyRequest(request),
            ScopeHeaders::default(),
        )
    }

    pub fn shutdown(&self) -> Result<ShutdownResponse, ClientError> {
        self.connected_request(
            "/core/v1/admin/shutdown",
            &ShutdownRequest::default(),
            ScopeHeaders::default(),
        )
    }

    fn connected_request<Request: Serialize, Response: DeserializeOwned>(
        &self,
        path: &str,
        request: &Request,
        scope: ScopeHeaders<'_>,
    ) -> Result<Response, ClientError> {
        let mut headers = vec![
            (CONNECTION_HEADER, self.connection_id.as_str()),
            (CONNECTION_BINDING_HEADER, self.connection_binding.as_str()),
        ];
        headers.extend(scope.values);
        request_json(&self.socket, &self.auth, path, request, &headers)
    }
}

struct RawHttpResponse {
    head: String,
    bytes: Vec<u8>,
}

impl RawHttpResponse {
    fn header(&self, expected: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case(expected)
                .then_some(value.trim())
        })
    }
}

fn connected_stream_request(
    client: &CoreClient,
    method: &str,
    path: &str,
    source: &mut impl Read,
    byte_length: u64,
    scope: ScopeHeaders<'_>,
    maximum_response_bytes: usize,
) -> Result<RawHttpResponse, ClientError> {
    let mut stream = UnixStream::connect(&client.socket)?;
    stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    stream.set_write_timeout(Some(REQUEST_TIMEOUT))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/octet-stream\r\nContent-Length: {byte_length}\r\nConnection: close\r\n",
        client.auth,
    )?;
    for (name, value) in [
        (CONNECTION_HEADER, client.connection_id.as_str()),
        (
            CONNECTION_BINDING_HEADER,
            client.connection_binding.as_str(),
        ),
    ]
    .into_iter()
    .chain(scope.values)
    {
        if !valid_header(name) || !valid_header(value) {
            return Err(ClientError::InvalidRuntime(
                "request header contains invalid bytes".to_owned(),
            ));
        }
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    let copied = io::copy(&mut source.take(byte_length), &mut stream)?;
    if copied != byte_length {
        return Err(ClientError::Io(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("File source ended after {copied} of {byte_length} bytes"),
        )));
    }

    let mut reader = BufReader::new(stream);
    let head = String::from_utf8(read_http_response_head(&mut reader)?).map_err(|_| {
        ClientError::InvalidRuntime("Core returned non-UTF-8 HTTP headers".to_owned())
    })?;
    if response_content_length(&head).is_some_and(|length| length > maximum_response_bytes) {
        return Err(ClientError::ResponseTooLarge {
            maximum: maximum_response_bytes,
            observed_at_least: response_content_length(&head).expect("length checked"),
        });
    }
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| ClientError::InvalidRuntime("Core HTTP status is invalid".to_owned()))?;
    let mut bytes = Vec::new();
    reader
        .take(u64::try_from(maximum_response_bytes + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum_response_bytes {
        return Err(ClientError::ResponseTooLarge {
            maximum: maximum_response_bytes,
            observed_at_least: bytes.len(),
        });
    }
    if !(200..300).contains(&status) {
        let message = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value.get("message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_owned());
        return Err(ClientError::Http { status, message });
    }
    Ok(RawHttpResponse { head, bytes })
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
            continue;
        }
        encoded.push('%');
        encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
        encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
    }
    encoded
}

pub fn connect_or_launch(
    home: &Path,
    build_id: &str,
    core_executable: Option<&Path>,
) -> Result<CoreClient, ClientError> {
    ensure_home(home)?;
    let executable = match core_executable {
        Some(path) => path.to_owned(),
        None => discover_core_executable()?,
    };
    let mut child = Command::new(&executable)
        .args([
            "--home",
            &home.to_string_lossy(),
            "--selection-policy",
            "compatible",
            "--launcher",
            "native-cli",
        ])
        .env("NODEX_LOG_CONSOLE", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            ClientError::Startup(format!("could not start {}: {error}", executable.display()))
        })?;
    let selection = wait_for_selection_result(&mut child)?;
    wait_for_core(home, build_id, &mut child, &selection)
}

pub fn discover_core_executable() -> Result<PathBuf, ClientError> {
    if let Some(path) = std::env::var_os("NODEX_CORE_BINARY") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(ClientError::CoreExecutable(format!(
            "NODEX_CORE_BINARY does not name a file: {}",
            path.display()
        )));
    }
    let current = fs::canonicalize(std::env::current_exe()?)?;
    let sibling = current
        .parent()
        .ok_or_else(|| ClientError::CoreExecutable("CLI executable has no parent".to_owned()))?
        .join("nodex-core");
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err(ClientError::CoreExecutable(format!(
        "expected a packaged nodex-core next to {} or NODEX_CORE_BINARY",
        current.display()
    )))
}

fn wait_for_core(
    home: &Path,
    build_id: &str,
    child: &mut Child,
    selection: &CoreSelectionResult,
) -> Result<CoreClient, ClientError> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        let error = match CoreClient::connect(home, build_id) {
            Ok(client) if client.descriptor == selection.descriptor => return Ok(client),
            Ok(_) => {
                ClientError::Startup("runtime generation changed after Core selection".to_owned())
            }
            Err(error) => error,
        };
        if let Some(status) = child.try_wait()? {
            if matches!(selection.disposition, CoreSelectionDisposition::Reused) && status.success()
            {
                if Instant::now() >= deadline {
                    return Err(ClientError::Startup(format!(
                        "selected reused Core did not accept a connection: {error}"
                    )));
                }
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            return Err(ClientError::Startup(format!(
                "Core exited with {status}: {}",
                stderr.trim()
            )));
        }
        if Instant::now() >= deadline {
            return Err(ClientError::Startup(format!(
                "readiness timed out: {error}"
            )));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_selection_result(child: &mut Child) -> Result<CoreSelectionResult, ClientError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ClientError::Startup("Core stdout is unavailable".to_owned()))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(STARTUP_TIMEOUT)
        .map_err(|_| ClientError::Startup("Core selection timed out".to_owned()))??;
    if line.len() > MAX_DESCRIPTOR_BYTES as usize {
        return Err(ClientError::Startup(
            "Core selection result is oversized".to_owned(),
        ));
    }
    let selection = serde_json::from_str::<CoreSelectionResult>(line.trim())?;
    if selection.selection_version != 1 {
        return Err(ClientError::Startup(
            "Core selection result version is unsupported".to_owned(),
        ));
    }
    Ok(selection)
}

#[derive(Default)]
struct ScopeHeaders<'a> {
    values: Vec<(&'static str, &'a str)>,
}

impl<'a> ScopeHeaders<'a> {
    fn project(project_id: Option<&'a str>) -> Self {
        Self {
            values: project_id
                .map(|project_id| vec![(PROJECT_HEADER, project_id)])
                .unwrap_or_default(),
        }
    }

    fn database(project_id: Option<&'a str>) -> Self {
        match project_id {
            Some(project_id) => Self::project(Some(project_id)),
            None => Self {
                values: vec![(DATABASE_SCOPE_HEADER, LIBRARY_SCOPE)],
            },
        }
    }

    fn document(project_id: Option<&'a str>, library_scope: bool) -> Self {
        if let Some(project_id) = project_id {
            return Self::project(Some(project_id));
        }
        if library_scope {
            return Self {
                values: vec![(DOCUMENT_SCOPE_HEADER, LIBRARY_SCOPE)],
            };
        }
        Self::default()
    }
}

struct RuntimeFiles {
    socket: PathBuf,
    auth: String,
    descriptor: RuntimeDescriptor,
}

impl RuntimeFiles {
    fn read(home: &Path) -> Result<Self, ClientError> {
        if !home.is_absolute() {
            return Err(ClientError::InvalidRuntime(
                "Nodex home must be absolute".to_owned(),
            ));
        }
        let directory = home.join("run/core");
        validate_entry(&directory, EntryKind::Directory, RUNTIME_DIRECTORY_MODE)?;
        let owner = fs::symlink_metadata(&directory)?.uid();
        let descriptor_path = directory.join("core.json");
        let descriptor_metadata =
            validate_owned_entry(&descriptor_path, owner, EntryKind::File, PRIVATE_MODE)?;
        if descriptor_metadata.len() > MAX_DESCRIPTOR_BYTES {
            return Err(ClientError::InvalidRuntime(
                "runtime descriptor is oversized".to_owned(),
            ));
        }
        let descriptor = serde_json::from_slice::<RuntimeDescriptor>(&fs::read(&descriptor_path)?)
            .map_err(|_| {
                ClientError::InvalidRuntime("runtime descriptor is invalid JSON".to_owned())
            })?;
        let socket = directory.join("core.sock");
        if Path::new(&descriptor.socket_path) != socket {
            return Err(ClientError::InvalidRuntime(
                "runtime descriptor socket does not match its managed path".to_owned(),
            ));
        }
        validate_owned_entry(&socket, owner, EntryKind::Socket, PRIVATE_MODE)?;
        let auth_path = directory.join("core.auth");
        let auth_metadata = validate_owned_entry(&auth_path, owner, EntryKind::File, PRIVATE_MODE)?;
        if auth_metadata.len() > MAX_AUTH_BYTES {
            return Err(ClientError::InvalidRuntime(
                "runtime capability is oversized".to_owned(),
            ));
        }
        let auth = fs::read_to_string(auth_path)?.trim().to_owned();
        if auth.len() != 64 || !auth.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ClientError::InvalidRuntime(
                "runtime capability is invalid".to_owned(),
            ));
        }
        Ok(Self {
            socket,
            auth,
            descriptor,
        })
    }
}

#[derive(Clone, Copy)]
enum EntryKind {
    Directory,
    File,
    Socket,
}

fn validate_entry(path: &Path, kind: EntryKind, mode: u32) -> Result<fs::Metadata, ClientError> {
    let metadata = fs::symlink_metadata(path)?;
    let file_type = metadata.file_type();
    let correct_kind = match kind {
        EntryKind::Directory => file_type.is_dir(),
        EntryKind::File => file_type.is_file(),
        EntryKind::Socket => file_type.is_socket(),
    };
    if !correct_kind || file_type.is_symlink() {
        return Err(ClientError::InvalidRuntime(format!(
            "{} has an unsafe entry type",
            path.display()
        )));
    }
    if metadata.permissions().mode() & 0o777 != mode {
        return Err(ClientError::InvalidRuntime(format!(
            "{} must have mode {mode:o}",
            path.display()
        )));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(ClientError::InvalidRuntime(format!(
            "{} is not owned by the current user",
            path.display()
        )));
    }
    Ok(metadata)
}

fn validate_owned_entry(
    path: &Path,
    owner: u32,
    kind: EntryKind,
    mode: u32,
) -> Result<fs::Metadata, ClientError> {
    let metadata = validate_entry(path, kind, mode)?;
    if metadata.uid() != owner {
        return Err(ClientError::InvalidRuntime(format!(
            "{} does not share the runtime owner",
            path.display()
        )));
    }
    Ok(metadata)
}

fn ensure_home(home: &Path) -> Result<(), ClientError> {
    if !home.is_absolute() {
        return Err(ClientError::InvalidRuntime(
            "Nodex home must be absolute".to_owned(),
        ));
    }
    if !home.exists() {
        fs::create_dir_all(home)?;
        fs::set_permissions(home, fs::Permissions::from_mode(RUNTIME_DIRECTORY_MODE))?;
    }
    let metadata = fs::symlink_metadata(home)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(ClientError::InvalidRuntime(
            "Nodex home must be a current-user-owned directory".to_owned(),
        ));
    }
    Ok(())
}

fn validate_handshake(
    descriptor: &RuntimeDescriptor,
    handshake: &HandshakeResponse,
) -> Result<(), ClientError> {
    let requirements = core_client_requirements();
    if handshake.selected_transport_version < TRANSPORT_PROTOCOL_MIN
        || handshake.selected_transport_version > TRANSPORT_PROTOCOL_MAX
    {
        return Err(ClientError::ProtocolIncompatible(format!(
            "Core selected transport {} outside {TRANSPORT_PROTOCOL_MIN}..={TRANSPORT_PROTOCOL_MAX}",
            handshake.selected_transport_version
        )));
    }
    if handshake.generation != RuntimeGenerationIdentity::from(descriptor)
        || handshake.selected_event_version != requirements.event_version
        || handshake.selected_module_versions != requirements.modules
        || handshake.manifest_digest != descriptor.manifest_digest
        || handshake.artifact != descriptor.artifact
        || handshake.actual_store_format != descriptor.actual_store_format
        || handshake.store_epoch != descriptor.store_epoch
        || handshake.schema_version != descriptor.actual_store_format.version
        || handshake.commit_head < 0
        || handshake.library_id.is_empty()
        || handshake.connection_binding.is_empty()
    {
        return Err(ClientError::InvalidRuntime(
            "handshake does not match the authenticated runtime descriptor".to_owned(),
        ));
    }
    let digest = canonical_manifest_digest(&descriptor.manifest)
        .map_err(|mismatch| ClientError::InvalidRuntime(format!("{mismatch:?}")))?;
    if digest != descriptor.manifest_digest {
        return Err(ClientError::InvalidRuntime(
            "runtime manifest digest does not match its canonical manifest".to_owned(),
        ));
    }
    Ok(())
}

fn request_json<Request: Serialize, Response: DeserializeOwned>(
    socket: &Path,
    auth: &str,
    path: &str,
    request: &Request,
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    let body = serde_json::to_vec(request)?;
    request_bytes(socket, auth, "POST", path, &body, headers)
}

fn request_without_body<Response: DeserializeOwned>(
    socket: &Path,
    auth: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    request_bytes(socket, auth, "GET", path, &[], headers)
}

fn request_bytes<Response: DeserializeOwned>(
    socket: &Path,
    auth: &str,
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    let document_route = path.starts_with("/core/v1/modules/document/");
    let maximum_request_bytes = if document_route {
        MAX_DOCUMENT_JSON_REQUEST_BYTES
    } else {
        MAX_ORDINARY_JSON_REQUEST_BYTES
    };
    if body.len() > maximum_request_bytes {
        return Err(ClientError::RequestTooLarge {
            maximum: maximum_request_bytes,
            actual: body.len(),
        });
    }
    let maximum_response_bytes = if document_route {
        MAX_DOCUMENT_RESPONSE_BYTES
    } else {
        MAX_ORDINARY_JSON_RESPONSE_BYTES
    };
    let request_timeout = request_timeout(path);
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(request_timeout))?;
    stream.set_write_timeout(Some(request_timeout))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )?;
    for (name, value) in headers {
        if !valid_header(name) || !valid_header(value) {
            return Err(ClientError::InvalidRuntime(
                "request header contains invalid bytes".to_owned(),
            ));
        }
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(body)?;

    let mut reader = BufReader::new(stream);
    let head = read_http_response_head(&mut reader)?;
    let head = std::str::from_utf8(&head).map_err(|_| {
        ClientError::InvalidRuntime("Core returned non-UTF-8 HTTP headers".to_owned())
    })?;
    if response_content_length(head).is_some_and(|length| length > maximum_response_bytes) {
        return Err(ClientError::ResponseTooLarge {
            maximum: maximum_response_bytes,
            observed_at_least: response_content_length(head)
                .expect("checked Content-Length is present"),
        });
    }
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| ClientError::InvalidRuntime("Core HTTP status is invalid".to_owned()))?;
    let mut body = Vec::new();
    reader
        .take(u64::try_from(maximum_response_bytes + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut body)?;
    if body.len() > maximum_response_bytes {
        return Err(ClientError::ResponseTooLarge {
            maximum: maximum_response_bytes,
            observed_at_least: body.len(),
        });
    }
    if !(200..300).contains(&status) {
        let message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| String::from_utf8_lossy(&body).trim().to_owned());
        return Err(ClientError::Http { status, message });
    }
    serde_json::from_slice(&body).map_err(ClientError::from)
}

fn request_timeout(path: &str) -> Duration {
    if path == ADMINISTRATION_APPLY_PATH {
        return ADMINISTRATION_REQUEST_TIMEOUT;
    }
    REQUEST_TIMEOUT
}

fn read_http_response_head(reader: &mut impl Read) -> Result<Vec<u8>, ClientError> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while head.len() <= MAX_HTTP_RESPONSE_HEADER_BYTES {
        if reader.read(&mut byte)? == 0 {
            return Err(ClientError::InvalidRuntime(
                "Core response has no HTTP header boundary".to_owned(),
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            head.truncate(head.len() - 4);
            return Ok(head);
        }
    }
    Err(ClientError::InvalidRuntime(
        "Core response headers exceed the transport limit".to_owned(),
    ))
}

fn response_content_length(head: &str) -> Option<usize> {
    head.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("content-length") {
            return None;
        }
        value.trim().parse::<usize>().ok()
    })
}

fn valid_header(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4_096
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'\r' | b'\n'))
}

fn random_hex(bytes: usize) -> Result<String, ClientError> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| io::Error::other(format!("randomness unavailable: {error}")))?;
    Ok(hex::encode(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_headers_never_mix_project_and_library_authority() {
        assert_eq!(
            ScopeHeaders::database(Some("project-1")).values,
            [(PROJECT_HEADER, "project-1")]
        );
        assert_eq!(
            ScopeHeaders::database(None).values,
            [(DATABASE_SCOPE_HEADER, LIBRARY_SCOPE)]
        );
        assert_eq!(
            ScopeHeaders::document(None, true).values,
            [(DOCUMENT_SCOPE_HEADER, LIBRARY_SCOPE)]
        );
    }

    #[test]
    fn header_validation_rejects_transport_injection() {
        assert!(valid_header("project-1"));
        assert!(!valid_header("project-1\r\nx-forged: yes"));
        assert!(!valid_header(""));
    }

    #[test]
    fn response_head_reader_stops_at_the_http_boundary() {
        let mut response =
            std::io::Cursor::new(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        let head = read_http_response_head(&mut response).expect("bounded response head");

        assert_eq!(
            String::from_utf8(head).expect("UTF-8 head"),
            "HTTP/1.1 200 OK\r\nContent-Length: 2"
        );
        assert_eq!(response.position(), 38);
    }

    #[test]
    fn response_content_length_is_case_insensitive_and_bounded_separately() {
        assert_eq!(
            response_content_length("HTTP/1.1 200 OK\r\ncontent-LENGTH: 16777216"),
            Some(MAX_ORDINARY_JSON_RESPONSE_BYTES)
        );
        assert_eq!(
            response_content_length("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked"),
            None
        );
    }

    #[test]
    fn whole_store_administration_uses_a_maintenance_request_window() {
        assert_eq!(
            request_timeout(ADMINISTRATION_APPLY_PATH),
            ADMINISTRATION_REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout("/core/v1/modules/administration/read"),
            REQUEST_TIMEOUT
        );
        assert_eq!(
            request_timeout("/core/v1/modules/library/apply"),
            REQUEST_TIMEOUT
        );
    }
}
