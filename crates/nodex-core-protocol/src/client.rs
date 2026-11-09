#[path = "client_remote.rs"]
mod remote;
pub use remote::RemoteConnection;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};

use nodex_platform::{
    local_endpoint,
    private_fs::{self, EntryKind},
    process::{self},
};
use std::net::{SocketAddr, TcpStream};
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
// publish its runtime descriptor, which can exceed ten seconds on slower hosts.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

const CONNECTION_HEADER: &str = "x-nodex-connection-id";
const CONNECTION_BINDING_HEADER: &str = "x-nodex-connection-binding";
const PROJECT_HEADER: &str = "x-nodex-project-id";

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("Core runtime is invalid: {0}")]
    InvalidRuntime(String),
    #[error("Core protocol is incompatible: {0}")]
    ProtocolIncompatible(String),
    #[error("Core returned HTTP {status}: {message}")]
    Http {
        status: u16,
        message: String,
        failure: Option<Box<nodex_core_contracts::document::RecoveryPackageFailure>>,
    },
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
    socket: CoreEndpoint,
    auth: String,
    connection_id: String,
    connection_binding: String,
    agent_attribution: Option<String>,
    pub descriptor: RuntimeDescriptor,
    pub handshake: HandshakeResponse,
}

#[derive(Clone, Debug)]
enum CoreEndpoint {
    Local(PathBuf),
    Agent(SocketAddr),
    Remote(remote::RemoteEndpoint),
}

trait HttpStream: Read + Write {}
impl<T: Read + Write> HttpStream for T {}

impl CoreEndpoint {
    fn open(
        &self,
        timeout: Duration,
        expected_pid: Option<u32>,
    ) -> io::Result<Box<dyn HttpStream>> {
        match self {
            Self::Local(path) => {
                let stream = local_endpoint::connect(path, expected_pid)?;
                stream.set_read_timeout(Some(timeout))?;
                stream.set_write_timeout(Some(timeout))?;
                Ok(Box::new(stream))
            }
            Self::Remote(endpoint) => Ok(Box::new(endpoint.open(timeout)?)),
            Self::Agent(address) => {
                let stream = TcpStream::connect_timeout(address, timeout)?;
                stream.set_read_timeout(Some(timeout))?;
                stream.set_write_timeout(Some(timeout))?;
                Ok(Box::new(stream))
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileBlobResponse {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub etag: String,
}

impl CoreClient {
    pub fn connect_remote(input: &RemoteConnection, build_id: &str) -> Result<Self, ClientError> {
        let socket = CoreEndpoint::Remote(remote::RemoteEndpoint::new(input)?);
        let session: nodex_core_contracts::team::SessionResponse = request_json(
            &socket,
            "",
            "/session",
            &nodex_core_contracts::team::SessionRequest {
                device_credential: input.device_credential.clone(),
            },
            &[],
        )?;
        let auth = session.session_token;
        let info: crate::RemoteCoreInfo =
            request_without_body(&socket, &auth, "/core/v1/remote-info", &[])?;
        if info.library_id != input.space_id || session.principal.space_id != input.space_id {
            return Err(ClientError::InvalidRuntime(
                "Remote Space identity changed".into(),
            ));
        }
        let connection_id = format!("remote-cli:{}", random_hex(16)?);
        let handshake: HandshakeResponse = request_json(
            &socket,
            &auth,
            "/core/v1/handshake",
            &HandshakeRequest {
                requirements: core_client_requirements(),
                client: ClientIdentity {
                    kind: ClientKind::RemoteMember,
                    build_id: build_id.into(),
                },
                connection_id: connection_id.clone(),
                expected_generation: info.generation.clone(),
            },
            &[],
        )?;
        let g = info.generation;
        let descriptor = RuntimeDescriptor {
            manifest: info.manifest,
            manifest_digest: g.manifest_digest,
            artifact: handshake.artifact.clone(),
            actual_store_format: info.actual_store_format,
            pid: g.pid,
            start_nonce: g.start_nonce,
            endpoint: input.url.clone(),
            profile_id: g.profile_id,
            store_epoch: g.store_epoch,
            readiness_generation: g.readiness_generation,
        };
        validate_handshake(&descriptor, &handshake)?;
        Ok(Self {
            socket,
            auth,
            connection_id,
            connection_binding: handshake.connection_binding.clone(),
            agent_attribution: None,
            descriptor,
            handshake,
        })
    }
    pub fn connect(home: &Path, build_id: &str) -> Result<Self, ClientError> {
        let runtime = RuntimeFiles::read(home)?;
        let requirements = core_client_requirements();
        evaluate_compatibility(
            &requirements,
            &runtime.descriptor.manifest,
            &runtime.descriptor.actual_store_format,
        )
        .map_err(|mismatches| ClientError::ProtocolIncompatible(format!("{mismatches:?}")))?;
        let socket = CoreEndpoint::Local(runtime.socket);
        let connection_id = format!("native-cli:{}", random_hex(16)?);
        let handshake = request_json::<_, HandshakeResponse>(
            &socket,
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
            socket,
            auth: runtime.auth,
            connection_id,
            connection_binding: handshake.connection_binding.clone(),
            agent_attribution: None,
            descriptor: runtime.descriptor,
            handshake,
        })
    }

    /// A Host-owned content audience supplies a bound Native CLI connection. No private
    /// Profile path, Core bearer, administration route or local-launch fallback is needed.
    pub fn connect_agent(endpoint: &str, credential: &str) -> Result<Self, ClientError> {
        let address: SocketAddr = endpoint
            .strip_prefix("http://")
            .and_then(|address| address.parse().ok())
            .filter(|address: &SocketAddr| address.ip().is_loopback() && address.port() != 0)
            .ok_or_else(|| {
                ClientError::InvalidRuntime("Agent endpoint must be numeric loopback HTTP".into())
            })?;
        if credential.is_empty() || credential.len() > 1024 || !valid_header(credential) {
            return Err(ClientError::InvalidRuntime(
                "Invalid Agent Turn credential".into(),
            ));
        }
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct AgentContext {
            descriptor: RuntimeDescriptor,
            handshake: HandshakeResponse,
        }
        let socket = CoreEndpoint::Agent(address);
        let context: AgentContext =
            request_without_body(&socket, credential, "/agent/context", &[])?;
        evaluate_compatibility(
            &core_client_requirements(),
            &context.descriptor.manifest,
            &context.descriptor.actual_store_format,
        )
        .map_err(|mismatches| ClientError::ProtocolIncompatible(format!("{mismatches:?}")))?;
        validate_handshake(&context.descriptor, &context.handshake)?;
        Ok(Self {
            socket,
            auth: credential.to_owned(),
            connection_id: "scoped-agent-cli".into(),
            connection_binding: context.handshake.connection_binding.clone(),
            agent_attribution: None,
            descriptor: context.descriptor,
            handshake: context.handshake,
        })
    }

    pub fn is_scoped_agent(&self) -> bool {
        matches!(self.socket, CoreEndpoint::Agent(_))
    }

    /// Presents a Core-issued Agent attribution credential on content requests, so Core
    /// names that Agent's Session as their author. An invalid credential refuses admission.
    pub fn attribute_to_agent(&mut self, credential: String) -> Result<(), ClientError> {
        if !valid_header(&credential) {
            return Err(ClientError::InvalidRuntime(
                "Agent attribution credential is invalid".to_owned(),
            ));
        }
        self.agent_attribution = Some(credential);
        Ok(())
    }

    pub fn space_remote_access(
        &self,
    ) -> Result<nodex_core_contracts::team::RemoteAccessState, ClientError> {
        request_without_body(
            &self.socket,
            &self.auth,
            "/core/v1/admin/space/remote-access",
            &[],
        )
    }
    pub fn space_stop_listener(
        &self,
    ) -> Result<nodex_core_contracts::team::RemoteAccessState, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/stop-listener",
            &serde_json::json!({}),
            ContextHeaders::default(),
        )
    }
    pub fn space_link_device(
        &self,
    ) -> Result<nodex_core_contracts::team::DeviceLinkOffer, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/link-device",
            &serde_json::json!({}),
            ContextHeaders::default(),
        )
    }
    pub fn space_members(&self) -> Result<Vec<nodex_core_contracts::library::Member>, ClientError> {
        request_without_body(
            &self.socket,
            &self.auth,
            "/core/v1/admin/space/members",
            &[],
        )
    }
    pub fn space_listen(
        &self,
        request: nodex_core_contracts::team::ListenRequest,
    ) -> Result<nodex_core_contracts::team::ListenerInfo, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/listen",
            &request,
            ContextHeaders::default(),
        )
    }
    pub fn space_prepare(
        &self,
        request: nodex_core_contracts::team::ListenRequest,
    ) -> Result<nodex_core_contracts::team::SpaceIdentity, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/prepare",
            &request,
            ContextHeaders::default(),
        )
    }
    pub fn space_rename(
        &self,
        name: String,
    ) -> Result<nodex_core_contracts::team::SpaceName, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/name",
            &nodex_core_contracts::team::RenameSpaceRequest { name },
            ContextHeaders::default(),
        )
    }
    /// The requesting Member chooses the name other Members see.
    pub fn space_rename_member(
        &self,
        name: String,
    ) -> Result<nodex_core_contracts::library::Member, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/member-name",
            &nodex_core_contracts::team::RenameMemberRequest { name },
            ContextHeaders::default(),
        )
    }
    pub fn space_invite(
        &self,
        request: nodex_core_contracts::team::InviteRequest,
    ) -> Result<nodex_core_contracts::team::InviteResponse, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/invite",
            &request,
            ContextHeaders::default(),
        )
    }
    pub fn space_devices(
        &self,
    ) -> Result<Vec<nodex_core_contracts::team::MemberDevice>, ClientError> {
        request_without_body(
            &self.socket,
            &self.auth,
            "/core/v1/admin/space/devices",
            &[],
        )
    }
    pub fn space_revoke(
        &self,
        request: nodex_core_contracts::team::RevokeDeviceRequest,
    ) -> Result<serde_json::Value, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/revoke",
            &request,
            ContextHeaders::default(),
        )
    }
    pub fn space_remove_member(
        &self,
        request: nodex_core_contracts::team::RemoveMemberRequest,
    ) -> Result<serde_json::Value, ClientError> {
        self.connected_request(
            "/core/v1/admin/space/remove-member",
            &request,
            ContextHeaders::default(),
        )
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            LibraryFileReadSource::StructuralClipboard { bundle } => vec![
                ("kind", "structural_clipboard"),
                ("bundle_id", bundle.bundle_id.as_str()),
                ("capability", bundle.capability.as_str()),
                ("manifest_hash", bundle.manifest_hash.as_str()),
                ("store_epoch", bundle.store_epoch.as_str()),
            ],
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
            ContextHeaders::project(project_id),
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

    pub fn query_read(
        &self,
        project_id: Option<&str>,
        read: nodex_core_contracts::query::QueryRead,
    ) -> Result<crate::QueryReadResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/query/read",
            &crate::QueryReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: nodex_core_contracts::QUERY_CONTRACT_VERSION,
                read,
            }),
            ContextHeaders::project(project_id),
        )
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
        )
    }

    pub fn document_read(
        &self,
        project_id: Option<&str>,
        read: OwnedDocumentRead,
    ) -> Result<OwnedDocumentReadResponse, ClientError> {
        if let OwnedDocumentRead::SyncYjs { document_id, .. }
        | OwnedDocumentRead::FetchUpdate { document_id, .. }
        | OwnedDocumentRead::RecoveryArtifact { document_id, .. } = &read
        {
            let document_id = document_id.clone();
            let bytes = crate::document_module_wire::encode_read(OwnedDocumentReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::document::OwnedDocumentContract as VersionedModuleContract>::VERSION, read,
            })).map_err(|error| ClientError::InvalidRuntime(error.message))?;
            let response = self.document_frame(
                "/core/v1/modules/document/read",
                &document_id,
                &bytes,
                ContextHeaders::project(project_id),
            )?;
            if response.header("content-type").is_some_and(|value| {
                value.starts_with("application/vnd.nodex.document-sync.v3+octet-stream")
            }) {
                return crate::document_module_wire::decode_read_response(&response.bytes)
                    .map_err(|error| ClientError::InvalidRuntime(error.message));
            }
            let decoded: OwnedDocumentReadResponse = serde_json::from_slice(&response.bytes)?;
            if matches!(decoded.0, crate::ResponseEnvelope::Error(_)) {
                return Ok(decoded);
            }
            return Err(ClientError::InvalidRuntime(
                "Document byte response requires binary transport".into(),
            ));
        }
        self.connected_request(
            "/core/v1/modules/document/read",
            &OwnedDocumentReadRequest(nodex_core_contracts::ModuleReadRequest {
                contract_version: <nodex_core_contracts::document::OwnedDocumentContract as VersionedModuleContract>::VERSION,
                read,
            }),
            ContextHeaders::project(project_id),
        )
    }

    pub fn document_apply(
        &self,
        project_id: Option<&str>,
        request: nodex_core_contracts::ModuleApplyRequest<OwnedDocumentIntent>,
    ) -> Result<OwnedDocumentApplyResponse, ClientError> {
        if let OwnedDocumentIntent::CaptureRecovery { capture } = &request.intent {
            let bytes =
                nodex_core_contracts::document::recovery_bundle::encode(capture, &capture.draft_id)
                    .map_err(|error| ClientError::InvalidRuntime(error.to_string()))?;
            let hash = nodex_core_contracts::document::recovery_bundle::payload_hash(&bytes);
            let version = request.contract_version.to_string();
            let mut headers = vec![
                (CONNECTION_HEADER, self.connection_id.as_str()),
                (CONNECTION_BINDING_HEADER, self.connection_binding.as_str()),
                (
                    "content-type",
                    "application/vnd.nodex.recovery-bundle.v1+octet-stream",
                ),
                ("x-nodex-operation-id", request.operation_id.as_str()),
                ("x-nodex-store-epoch", request.store_epoch.0.as_str()),
                ("x-nodex-contract-version", version.as_str()),
                ("x-nodex-payload-hash", hash.as_str()),
            ];
            headers.extend(ContextHeaders::project(project_id).values);
            return request_bytes(
                &self.socket,
                &self.auth,
                "POST",
                "/core/v1/modules/document/recovery/capture",
                &bytes,
                &headers,
            );
        }
        if let OwnedDocumentIntent::ApplyYjsUpdate { document_id, .. }
        | OwnedDocumentIntent::ApplyCanvasMutation { document_id, .. } = &request.intent
        {
            let document_id = document_id.clone();
            let bytes =
                crate::document_module_wire::encode_apply(OwnedDocumentApplyRequest(request))
                    .map_err(|error| ClientError::InvalidRuntime(error.message))?;
            let response = self.document_frame(
                "/core/v1/modules/document/apply",
                &document_id,
                &bytes,
                ContextHeaders::project(project_id),
            )?;
            if response.header("content-type").is_some_and(|value| {
                value.starts_with("application/vnd.nodex.document-sync.v3+octet-stream")
            }) {
                return crate::document_module_wire::decode_apply_response(&response.bytes)
                    .map_err(|error| ClientError::InvalidRuntime(error.message));
            }
            let decoded: OwnedDocumentApplyResponse = serde_json::from_slice(&response.bytes)?;
            if matches!(decoded.0, crate::ResponseEnvelope::Error(_)) {
                return Ok(decoded);
            }
            return Err(ClientError::InvalidRuntime(
                "Document byte response requires binary transport".into(),
            ));
        }
        self.connected_request(
            "/core/v1/modules/document/apply",
            &OwnedDocumentApplyRequest(request),
            ContextHeaders::project(project_id),
        )
    }

    pub fn document_export_recovery(
        &self,
        project_id: Option<&str>,
        draft_id: &str,
    ) -> Result<Vec<u8>, ClientError> {
        let body = serde_json::to_vec(&nodex_core_contracts::document::RecoveryExportRequest {
            draft_id: draft_id.into(),
        })?;
        let mut headers = vec![
            (CONNECTION_HEADER, self.connection_id.as_str()),
            (CONNECTION_BINDING_HEADER, self.connection_binding.as_str()),
        ];
        headers.extend(ContextHeaders::project(project_id).values);
        let response = request_raw_bytes(
            &self.socket,
            &self.auth,
            "POST",
            "/core/v1/modules/document/recovery/export",
            &body,
            &headers,
        )?;
        if response.header("content-type").is_some_and(|value| {
            value.split(';').next() == Some("application/vnd.nodex.recovery-export.v1+octet-stream")
        }) {
            return Ok(response.bytes);
        }
        let failure: OwnedDocumentReadResponse = serde_json::from_slice(&response.bytes)?;
        match failure.0 {
            crate::ResponseEnvelope::Error(error) => {
                Err(ClientError::InvalidRuntime(error.message))
            }
            crate::ResponseEnvelope::Ok(_) => Err(ClientError::InvalidRuntime(
                "Unexpected recovery export response".into(),
            )),
        }
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::project(project_id),
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
            ContextHeaders::default(),
        )
    }

    pub fn administration_apply(
        &self,
        request: nodex_core_contracts::ModuleApplyRequest<StoreAdministrationIntent>,
    ) -> Result<StoreAdministrationApplyResponse, ClientError> {
        self.connected_request(
            "/core/v1/modules/administration/apply",
            &StoreAdministrationApplyRequest(request),
            ContextHeaders::default(),
        )
    }

    pub fn shutdown(&self) -> Result<ShutdownResponse, ClientError> {
        self.connected_request(
            "/core/v1/admin/shutdown",
            &ShutdownRequest::default(),
            ContextHeaders::default(),
        )
    }

    fn document_frame(
        &self,
        path: &str,
        document_id: &str,
        bytes: &[u8],
        scope: ContextHeaders<'_>,
    ) -> Result<RawHttpResponse, ClientError> {
        let mut headers = vec![
            (CONNECTION_HEADER, self.connection_id.as_str()),
            (CONNECTION_BINDING_HEADER, self.connection_binding.as_str()),
            ("x-nodex-client-session-id", self.connection_id.as_str()),
            ("x-nodex-document-id", document_id),
            (
                "content-type",
                "application/vnd.nodex.document-sync.v3+octet-stream",
            ),
        ];
        headers.extend(scope.values);
        request_raw_bytes(&self.socket, &self.auth, "POST", path, bytes, &headers)
    }

    fn connected_request<Request: Serialize, Response: DeserializeOwned>(
        &self,
        path: &str,
        request: &Request,
        scope: ContextHeaders<'_>,
    ) -> Result<Response, ClientError> {
        let mut headers = vec![
            (CONNECTION_HEADER, self.connection_id.as_str()),
            (CONNECTION_BINDING_HEADER, self.connection_binding.as_str()),
        ];
        if let Some(credential) = &self.agent_attribution {
            headers.push((crate::AGENT_ATTRIBUTION_HEADER, credential.as_str()));
        }
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
    scope: ContextHeaders<'_>,
    maximum_response_bytes: usize,
) -> Result<RawHttpResponse, ClientError> {
    let mut stream = client
        .socket
        .open(REQUEST_TIMEOUT, Some(client.descriptor.pid))?;
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

    read_raw_response(&mut BufReader::new(stream), maximum_response_bytes)
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
    let mut child = process::spawn_detached(
        Command::new(&executable)
            .args([
                "--home",
                &home.to_string_lossy(),
                "--selection-policy",
                "compatible",
                "--launcher",
                "native-cli",
            ])
            .env("NODEX_LOG_CONSOLE", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
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
        .join(process::executable_name("nodex-core"));
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
            Ok(client) if client.descriptor == selection.descriptor => {
                if matches!(selection.disposition, CoreSelectionDisposition::Reused) {
                    wait_for_reused_launcher(child, deadline)?;
                }
                return Ok(client);
            }
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

// A reuse candidate has no daemon lifetime. Reap it before handing its caller
// ownership, so Windows can release the executable and no launcher is orphaned.
fn wait_for_reused_launcher(child: &mut Child, deadline: Instant) -> Result<(), ClientError> {
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                pipe.read_to_string(&mut stderr)?;
            }
            return Err(ClientError::Startup(format!(
                "Core reuse launcher exited with {status}: {}",
                stderr.trim()
            )));
        }
        if Instant::now() >= deadline {
            return Err(ClientError::Startup(
                "Core reuse launcher did not exit within the startup window".to_owned(),
            ));
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
struct ContextHeaders<'a> {
    values: Vec<(&'static str, &'a str)>,
}

impl<'a> ContextHeaders<'a> {
    fn project(project_id: Option<&'a str>) -> Self {
        Self {
            values: project_id
                .map(|project_id| vec![(PROJECT_HEADER, project_id)])
                .unwrap_or_default(),
        }
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

        let descriptor_path = directory.join("core.json");
        let descriptor_metadata = validate_entry(&descriptor_path, EntryKind::File, PRIVATE_MODE)?;
        if descriptor_metadata.len() > MAX_DESCRIPTOR_BYTES {
            return Err(ClientError::InvalidRuntime(
                "runtime descriptor is oversized".to_owned(),
            ));
        }
        let descriptor = serde_json::from_slice::<RuntimeDescriptor>(&fs::read(&descriptor_path)?)
            .map_err(|_| {
                ClientError::InvalidRuntime("runtime descriptor is invalid JSON".to_owned())
            })?;
        let expected_socket = directory.join("core.sock");
        if !local_endpoint::validate_endpoint(&descriptor.endpoint, &expected_socket) {
            return Err(ClientError::InvalidRuntime(
                "runtime descriptor socket does not match its managed path".to_owned(),
            ));
        }
        let socket = PathBuf::from(&descriptor.endpoint);
        if cfg!(unix) {
            validate_entry(&socket, EntryKind::Socket, PRIVATE_MODE)?;
        }
        drop(local_endpoint::connect(&socket, Some(descriptor.pid))?);
        let auth_path = directory.join("core.auth");
        let auth_metadata = validate_entry(&auth_path, EntryKind::File, PRIVATE_MODE)?;
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

fn validate_entry(path: &Path, kind: EntryKind, mode: u32) -> Result<fs::Metadata, ClientError> {
    Ok(private_fs::checked_metadata(path, kind, Some(mode))?)
}

fn ensure_home(home: &Path) -> Result<(), ClientError> {
    if !home.is_absolute() {
        return Err(ClientError::InvalidRuntime(
            "Nodex home must be absolute".into(),
        ));
    }
    private_fs::create_dir_all(home)?;
    private_fs::checked_metadata(home, EntryKind::Directory, None)?;
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
    socket: &CoreEndpoint,
    auth: &str,
    path: &str,
    request: &Request,
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    let body = serde_json::to_vec(request)?;
    request_bytes(socket, auth, "POST", path, &body, headers)
}

fn request_without_body<Response: DeserializeOwned>(
    socket: &CoreEndpoint,
    auth: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    request_bytes(socket, auth, "GET", path, &[], headers)
}

fn request_bytes<Response: DeserializeOwned>(
    socket: &CoreEndpoint,
    auth: &str,
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> Result<Response, ClientError> {
    let response = request_raw_bytes(socket, auth, method, path, body, headers)?;
    serde_json::from_slice(&response.bytes).map_err(ClientError::from)
}

fn request_raw_bytes(
    socket: &CoreEndpoint,
    auth: &str,
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> Result<RawHttpResponse, ClientError> {
    let document_route = path.starts_with("/core/v1/modules/document/");
    let maximum_request_bytes = if path == "/core/v1/modules/document/recovery/capture" {
        nodex_core_contracts::document::MAX_RECOVERY_BUNDLE_BYTES
    } else if document_route {
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
    let maximum_response_bytes = if path == "/core/v1/modules/document/recovery/export" {
        nodex_core_contracts::document::MAX_RECOVERY_EXPORT_BYTES
    } else if document_route {
        MAX_DOCUMENT_RESPONSE_BYTES
    } else {
        MAX_ORDINARY_JSON_RESPONSE_BYTES
    };
    let request_timeout = request_timeout(path);
    let mut stream = socket.open(request_timeout, None)?;
    let content_type = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| *value)
        .unwrap_or("application/json");
    if !valid_header(content_type) {
        return Err(ClientError::InvalidRuntime("Invalid content type".into()));
    }
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {auth}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )?;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        if !valid_header(name) || !valid_header(value) {
            return Err(ClientError::InvalidRuntime(
                "request header contains invalid bytes".to_owned(),
            ));
        }
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(body)?;

    read_raw_response(&mut BufReader::new(stream), maximum_response_bytes)
}

#[cfg(test)]
mod scoped_agent_tests {
    use super::*;

    #[test]
    fn agent_connections_refuse_remote_ambiguous_or_injected_endpoints_before_connecting() {
        for endpoint in [
            "http://192.0.2.1:443",
            "https://127.0.0.1:443",
            "http://localhost:443",
            "http://127.0.0.1:0",
            "http://127.0.0.1:443/path",
        ] {
            assert!(
                matches!(
                    CoreClient::connect_agent(endpoint, "turn"),
                    Err(ClientError::InvalidRuntime(_))
                ),
                "{endpoint}"
            );
        }
        for credential in ["", "turn\r\nAuthorization: Bearer host"] {
            assert!(matches!(
                CoreClient::connect_agent("http://127.0.0.1:1", credential),
                Err(ClientError::InvalidRuntime(_))
            ));
        }
    }
}

/// All native responses share framing checks, including chunked binary exports.
fn read_raw_response(
    reader: &mut impl BufRead,
    maximum: usize,
) -> Result<RawHttpResponse, ClientError> {
    let head = String::from_utf8(read_http_response_head(reader)?)
        .map_err(|_| ClientError::InvalidRuntime("Core returned non-UTF-8 HTTP headers".into()))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| ClientError::InvalidRuntime("Core HTTP status is invalid".into()))?;
    let mut lengths = Vec::new();
    let mut encodings = Vec::new();
    for line in head.lines().skip(1) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| ClientError::InvalidRuntime("Invalid Core HTTP header".into()))?;
        if name.eq_ignore_ascii_case("content-length") {
            lengths.push(
                value.trim().parse::<usize>().map_err(|_| {
                    ClientError::InvalidRuntime("Invalid Core Content-Length".into())
                })?,
            );
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            encodings.push(value.trim().to_ascii_lowercase());
        }
    }
    if lengths.len() > 1
        || encodings.len() > 1
        || (!lengths.is_empty() && !encodings.is_empty())
        || encodings
            .first()
            .is_some_and(|encoding| encoding != "chunked")
    {
        return Err(ClientError::InvalidRuntime(
            "Ambiguous Core HTTP body framing".into(),
        ));
    }
    let length = lengths.first().copied();
    if let Some(length) = length
        && length > maximum
    {
        return Err(ClientError::ResponseTooLarge {
            maximum,
            observed_at_least: length,
        });
    }
    let mut bytes = Vec::new();
    if !encodings.is_empty() {
        loop {
            let line = read_http_line(reader, 128)?;
            let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| ClientError::InvalidRuntime("Invalid Core chunk length".into()))?;
            if size > maximum - bytes.len() {
                return Err(ClientError::ResponseTooLarge {
                    maximum,
                    observed_at_least: bytes.len().saturating_add(size),
                });
            }
            if size == 0 {
                let mut trailer_bytes = 0;
                loop {
                    let trailer =
                        read_http_line(reader, MAX_HTTP_RESPONSE_HEADER_BYTES - trailer_bytes)?;
                    trailer_bytes += trailer.len() + 2;
                    if trailer.is_empty() {
                        break;
                    }
                    if trailer_bytes >= MAX_HTTP_RESPONSE_HEADER_BYTES {
                        return Err(ClientError::InvalidRuntime(
                            "Core trailers exceed their bound".into(),
                        ));
                    }
                }
                break;
            }
            let offset = bytes.len();
            bytes.resize(offset + size, 0);
            reader.read_exact(&mut bytes[offset..])?;
            let mut boundary = [0; 2];
            reader.read_exact(&mut boundary)?;
            if boundary != *b"\r\n" {
                return Err(ClientError::InvalidRuntime(
                    "Invalid Core chunk boundary".into(),
                ));
            }
        }
    } else {
        reader.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > maximum {
            return Err(ClientError::ResponseTooLarge {
                maximum,
                observed_at_least: bytes.len(),
            });
        }
        if length.is_some_and(|length| length != bytes.len()) {
            return Err(ClientError::InvalidRuntime(
                "Core response length does not match Content-Length".into(),
            ));
        }
    }
    if !(200..300).contains(&status) {
        let error = serde_json::from_slice::<crate::HttpErrorResponse>(&bytes)
            .ok()
            .map(|crate::HttpErrorResponse::Error(error)| error);
        let message = error
            .as_ref()
            .map(|error| error.message.clone())
            .unwrap_or_else(|| format!("Core HTTP request failed ({status})"));
        let failure = error.and_then(|error| match error.recovery {
            nodex_core_contracts::CoreErrorRecovery::RecoveryPackage { failure } => Some(failure),
            _ => None,
        });
        return Err(ClientError::Http {
            status,
            message,
            failure,
        });
    }
    Ok(RawHttpResponse { head, bytes })
}

fn read_http_line(reader: &mut impl BufRead, maximum: usize) -> Result<String, ClientError> {
    let mut line = Vec::new();
    let mut byte = [0];
    while line.len() <= maximum {
        reader.read_exact(&mut byte)?;
        line.push(byte[0]);
        if line.ends_with(b"\r\n") {
            line.truncate(line.len() - 2);
            return String::from_utf8(line)
                .map_err(|_| ClientError::InvalidRuntime("Invalid Core HTTP line".into()));
        }
    }
    Err(ClientError::InvalidRuntime(
        "Core HTTP line exceeds its bound".into(),
    ))
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

#[cfg(test)]
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
    fn reused_launcher_completion_waits_for_the_native_process_to_exit() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c", "set /p finish="]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "read finish"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("native launcher fixture");
        let mut input = child.stdin.take().unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let waiter = thread::spawn(move || {
            let result =
                wait_for_reused_launcher(&mut child, Instant::now() + Duration::from_secs(10));
            sender.send(result).unwrap();
            child.wait().unwrap()
        });
        let early = receiver.recv_timeout(Duration::from_millis(50));
        let returned_early = early.is_ok();
        input.write_all(b"finished\n").unwrap();
        drop(input);
        let result = early.unwrap_or_else(|_| {
            receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("completed launcher")
        });
        assert!(waiter.join().unwrap().success());
        assert!(
            !returned_early,
            "reuse returned while its launcher was alive"
        );
        result.expect("successful reused launcher");
    }

    #[test]
    fn context_headers_carry_only_optional_project_routing() {
        assert_eq!(
            ContextHeaders::project(Some("project-1")).values,
            [(PROJECT_HEADER, "project-1")]
        );
        assert!(ContextHeaders::project(None).values.is_empty());
    }

    #[test]
    fn header_validation_rejects_transport_injection() {
        assert!(valid_header("project-1"));
        assert!(!valid_header("project-1\r\nx-forged: yes"));
        assert!(!valid_header(""));
    }

    #[test]
    fn http_rejections_preserve_core_messages_and_recovery() {
        let body = serde_json::json!({
            "status": "error",
            "payload": {
                "code": "invalid_input", "message": "request body exceeds its bound", "retryable": false,
                "recovery": { "kind": "recovery_package", "failure": {
                    "reason": "request_too_large", "effect": "not_applied", "actual": 65, "limit": 64
                }}
            }
        }).to_string();
        let response = format!(
            "HTTP/1.1 413 Payload Too Large\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let Err(ClientError::Http {
            status,
            message,
            failure,
        }) = read_raw_response(&mut io::Cursor::new(response), 4096)
        else {
            panic!("HTTP rejection")
        };
        assert_eq!(status, 413);
        assert_eq!(message, "request body exceeds its bound");
        let failure = failure.expect("recovery evidence");
        assert_eq!(failure.actual, Some(65));
        assert_eq!(failure.limit, Some(64));
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
    #[test]
    fn native_binary_response_checks_chunking_lengths_and_bounds() {
        let parse = |bytes: &[u8], maximum| read_raw_response(&mut io::Cursor::new(bytes), maximum);
        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n";
        assert_eq!(parse(chunked, 3).unwrap().bytes, b"abc");
        assert!(matches!(
            parse(chunked, 2),
            Err(ClientError::ResponseTooLarge { .. })
        ));
        assert!(parse(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc", 10).is_err());
        assert!(parse(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nabc", 10).is_err());
        assert!(
            parse(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab",
                10
            )
            .is_err()
        );
        assert!(
            parse(
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n",
                10
            )
            .is_err()
        );
    }
}
