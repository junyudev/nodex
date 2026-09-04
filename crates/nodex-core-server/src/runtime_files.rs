use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nodex_core_protocol::{
    ClientIdentity, ClientKind, CoreArtifactIdentity, CoreClientRequirements,
    CoreCompatibilityManifest, CoreReplacementRequest, CoreSelectionPolicy, CoreSelectionReason,
    HandshakeRequest, HandshakeResponse, LauncherKind, RuntimeDescriptor,
    RuntimeGenerationIdentity, ShutdownRequest, ShutdownResponse, ShutdownStatus,
    TRANSPORT_PROTOCOL_MAX, canonical_manifest_digest, evaluate_compatibility,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const RUNTIME_DIRECTORY_MODE: u32 = 0o700;
pub(crate) const PRIVATE_FILE_MODE: u32 = 0o600;
const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
const MAX_AUTH_BYTES: u64 = 128;
const MAX_PROBE_RESPONSE_BYTES: usize = 64 * 1024;
// A fresh Store or migration can exceed the normal hot-start path under load.
// Contenders must keep waiting while the incumbent owns the startup lock.
const STARTUP_WAIT: Duration = Duration::from_secs(30);
const HANDOFF_EXIT_WAIT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_CORE_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ExistingCore {
    LockAcquired,
    Reuse(Box<RuntimeDescriptor>, CoreSelectionReason),
    HandoffAccepted(IncumbentDescriptor, CoreSelectionReason),
}

#[derive(Clone, Debug)]
pub(crate) struct CandidateRuntime {
    pub(crate) manifest: CoreCompatibilityManifest,
    pub(crate) manifest_digest: String,
    pub(crate) artifact: CoreArtifactIdentity,
    pub(crate) requirements: CoreClientRequirements,
    pub(crate) policy: CoreSelectionPolicy,
    pub(crate) launcher: LauncherKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum IncumbentDescriptor {
    Current(Box<RuntimeDescriptor>),
    Legacy(LegacyRuntimeDescriptor),
}

impl IncumbentDescriptor {
    fn start_nonce(&self) -> &str {
        match self {
            Self::Current(descriptor) => &descriptor.start_nonce,
            Self::Legacy(descriptor) => &descriptor.start_nonce,
        }
    }

    fn pid(&self) -> u32 {
        match self {
            Self::Current(descriptor) => descriptor.pid,
            Self::Legacy(descriptor) => descriptor.pid,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyRuntimeDescriptor {
    protocol_min: u32,
    protocol_max: u32,
    build_id: String,
    pid: u32,
    start_nonce: String,
    socket_path: String,
    profile_id: String,
    store_epoch: String,
    readiness_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LegacyRuntimeGenerationIdentity {
    protocol_min: u32,
    protocol_max: u32,
    build_id: String,
    pid: u32,
    start_nonce: String,
    profile_id: String,
    store_epoch: String,
    readiness_generation: u64,
}

impl From<&LegacyRuntimeDescriptor> for LegacyRuntimeGenerationIdentity {
    fn from(descriptor: &LegacyRuntimeDescriptor) -> Self {
        Self {
            protocol_min: descriptor.protocol_min,
            protocol_max: descriptor.protocol_max,
            build_id: descriptor.build_id.clone(),
            pid: descriptor.pid,
            start_nonce: descriptor.start_nonce.clone(),
            profile_id: descriptor.profile_id.clone(),
            store_epoch: descriptor.store_epoch.clone(),
            readiness_generation: descriptor.readiness_generation,
        }
    }
}

#[derive(Serialize)]
struct LegacyVersionHandoffRequest {
    protocol_min: u32,
    protocol_max: u32,
    build_id: String,
    expected: LegacyRuntimeGenerationIdentity,
}

#[derive(Serialize)]
struct LegacyShutdownRequest {
    version_handoff: Option<LegacyVersionHandoffRequest>,
}

#[derive(Deserialize)]
struct LegacyShutdownResponse {
    status: LegacyShutdownStatus,
    runtime: Option<LegacyRuntimeGenerationIdentity>,
    retry_after_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyShutdownStatus {
    Draining,
    Busy,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimePaths {
    pub(crate) directory: PathBuf,
    pub(crate) lock: PathBuf,
    pub(crate) socket: PathBuf,
    pub(crate) descriptor: PathBuf,
    pub(crate) auth: PathBuf,
    pub(crate) lifecycle: PathBuf,
}

impl RuntimePaths {
    pub(crate) fn prepare(home: &Path) -> io::Result<Self> {
        validate_home(home)?;
        let run = home.join("run");
        prepare_owned_directory(&run, None)?;
        let directory = run.join("core");
        prepare_owned_directory(&directory, Some(RUNTIME_DIRECTORY_MODE))?;
        Ok(Self {
            lock: directory.join("core.lock"),
            socket: directory.join("core.sock"),
            descriptor: directory.join("core.json"),
            auth: directory.join("core.auth"),
            lifecycle: directory.join("lifecycle.json"),
            directory,
        })
    }

    pub(crate) fn owner_uid(&self) -> io::Result<u32> {
        Ok(checked_metadata(
            &self.directory,
            EntryKind::Directory,
            Some(RUNTIME_DIRECTORY_MODE),
        )?
        .uid())
    }

    pub(crate) fn open_lock(&self) -> io::Result<File> {
        match OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(PRIVATE_FILE_MODE)
            .open(&self.lock)
        {
            Ok(lock) => {
                fs::set_permissions(&self.lock, fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
                Ok(lock)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                checked_owned_entry(
                    &self.lock,
                    self.owner_uid()?,
                    EntryKind::File,
                    Some(PRIVATE_FILE_MODE),
                )?;
                OpenOptions::new().read(true).write(true).open(&self.lock)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn remove_stale_socket(&self) -> io::Result<()> {
        let Ok(_) = fs::symlink_metadata(&self.socket) else {
            return Ok(());
        };
        checked_owned_entry(
            &self.socket,
            self.owner_uid()?,
            EntryKind::Socket,
            Some(PRIVATE_FILE_MODE),
        )?;
        fs::remove_file(&self.socket)
    }

    pub(crate) fn atomic_write_private(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        if fs::symlink_metadata(path).is_ok() {
            checked_owned_entry(
                path,
                self.owner_uid()?,
                EntryKind::File,
                Some(PRIVATE_FILE_MODE),
            )?;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid runtime file"))?;
        let temporary = path.with_file_name(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            random_hex(8)?
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(PRIVATE_FILE_MODE)
            .open(&temporary)?;
        let write_result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)?;
            File::open(&self.directory)?.sync_all()
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result
    }

    pub(crate) fn read_private_bounded(
        &self,
        path: &Path,
        maximum_bytes: u64,
        label: &str,
    ) -> io::Result<Vec<u8>> {
        let metadata = checked_owned_entry(
            path,
            self.owner_uid()?,
            EntryKind::File,
            Some(PRIVATE_FILE_MODE),
        )?;
        if metadata.len() > maximum_bytes {
            return Err(invalid_data(&format!("{label} is oversized")));
        }
        fs::read(path)
    }

    pub(crate) fn read_descriptor(&self) -> io::Result<RuntimeDescriptor> {
        match self.read_incumbent_descriptor()? {
            IncumbentDescriptor::Current(descriptor) => Ok(*descriptor),
            IncumbentDescriptor::Legacy(_) => Err(invalid_data(
                "Core runtime descriptor uses a legacy transport",
            )),
        }
    }

    fn read_incumbent_descriptor(&self) -> io::Result<IncumbentDescriptor> {
        let metadata = checked_owned_entry(
            &self.descriptor,
            self.owner_uid()?,
            EntryKind::File,
            Some(PRIVATE_FILE_MODE),
        )?;
        if metadata.len() > MAX_DESCRIPTOR_BYTES {
            return Err(invalid_data("Core runtime descriptor is oversized"));
        }
        let bytes = fs::read(&self.descriptor)?;
        if let Ok(descriptor) = serde_json::from_slice::<RuntimeDescriptor>(&bytes) {
            validate_descriptor(&descriptor, &self.socket)?;
            return Ok(IncumbentDescriptor::Current(Box::new(descriptor)));
        }
        let descriptor = serde_json::from_slice::<LegacyRuntimeDescriptor>(&bytes)
            .map_err(|_| invalid_data("Core runtime descriptor is invalid"))?;
        validate_legacy_descriptor(&descriptor, &self.socket)?;
        Ok(IncumbentDescriptor::Legacy(descriptor))
    }

    fn read_auth(&self) -> io::Result<String> {
        let metadata = checked_owned_entry(
            &self.auth,
            self.owner_uid()?,
            EntryKind::File,
            Some(PRIVATE_FILE_MODE),
        )?;
        if metadata.len() > MAX_AUTH_BYTES {
            return Err(invalid_data("Core auth capability is oversized"));
        }
        let auth = fs::read_to_string(&self.auth)?;
        let auth = auth.trim();
        if auth.len() != 64 || !auth.bytes().all(is_lower_hex) {
            return Err(invalid_data("Core auth capability is invalid"));
        }
        Ok(auth.to_owned())
    }

    pub(crate) fn wait_for_running_core(
        &self,
        lock: &File,
        candidate: &CandidateRuntime,
    ) -> io::Result<ExistingCore> {
        let deadline = Instant::now() + STARTUP_WAIT;
        loop {
            match fs2::FileExt::try_lock_exclusive(lock) {
                Ok(()) => return Ok(ExistingCore::LockAcquired),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            let error = match self
                .read_incumbent_descriptor()
                .and_then(|descriptor| self.probe_or_handoff_running_core(descriptor, candidate))
            {
                Ok(existing) => return Ok(existing),
                Err(error) => error,
            };
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock
                    | io::ErrorKind::Unsupported
                    | io::ErrorKind::PermissionDenied
                    | io::ErrorKind::InvalidData
            ) {
                return Err(error);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("another Core holds the lock but did not prove readiness: {error}"),
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn probe_or_handoff_running_core(
        &self,
        descriptor: IncumbentDescriptor,
        candidate: &CandidateRuntime,
    ) -> io::Result<ExistingCore> {
        let IncumbentDescriptor::Current(descriptor) = descriptor else {
            return self.request_legacy_handoff(descriptor, candidate);
        };
        let compatible = evaluate_compatibility(
            &candidate.requirements,
            &descriptor.manifest,
            &descriptor.actual_store_format,
        )
        .is_ok();
        let artifact_matches = descriptor.artifact.sha256 == candidate.artifact.sha256;
        if !compatible
            || (matches!(candidate.policy, CoreSelectionPolicy::PreferCurrentArtifact)
                && !artifact_matches)
        {
            let reason = if compatible {
                CoreSelectionReason::ReplacedArtifact
            } else {
                CoreSelectionReason::ReplacedContract
            };
            return self.request_replacement(*descriptor, candidate, reason);
        }
        checked_owned_entry(
            &self.socket,
            self.owner_uid()?,
            EntryKind::Socket,
            Some(PRIVATE_FILE_MODE),
        )?;
        let auth = self.read_auth()?;
        let connection_id = format!("startup-probe:{}", random_hex(16)?);
        let request = HandshakeRequest {
            requirements: candidate.requirements.clone(),
            client: ClientIdentity {
                kind: ClientKind::Test,
                build_id: option_env!("NODEX_RELEASE_VERSION")
                    .unwrap_or(env!("CARGO_PKG_VERSION"))
                    .to_owned(),
            },
            connection_id,
            expected_generation: RuntimeGenerationIdentity::from(descriptor.as_ref()),
        };
        let response = request_json::<_, HandshakeResponse>(
            &self.socket,
            &auth,
            "/core/v1/handshake",
            &request,
        )?;
        if response.selected_transport_version != TRANSPORT_PROTOCOL_MAX
            || response.generation != RuntimeGenerationIdentity::from(descriptor.as_ref())
            || response.manifest_digest != descriptor.manifest_digest
            || response.artifact != descriptor.artifact
            || response.actual_store_format != descriptor.actual_store_format
            || response.store_epoch != descriptor.store_epoch
            || response.schema_version == 0
        {
            return Err(invalid_data(
                "running Core handshake does not match its runtime descriptor",
            ));
        }
        Ok(ExistingCore::Reuse(
            descriptor,
            CoreSelectionReason::ReusedCompatible,
        ))
    }

    fn request_replacement(
        &self,
        descriptor: RuntimeDescriptor,
        candidate: &CandidateRuntime,
        reason: CoreSelectionReason,
    ) -> io::Result<ExistingCore> {
        checked_owned_entry(
            &self.socket,
            self.owner_uid()?,
            EntryKind::Socket,
            Some(PRIVATE_FILE_MODE),
        )?;
        let auth = self.read_auth()?;
        let expected = RuntimeGenerationIdentity::from(&descriptor);
        let response = request_json::<_, ShutdownResponse>(
            &self.socket,
            &auth,
            "/core/v1/admin/shutdown",
            &ShutdownRequest::Replacement(Box::new(CoreReplacementRequest {
                candidate_manifest: candidate.manifest.clone(),
                candidate_manifest_digest: candidate.manifest_digest.clone(),
                candidate_artifact: candidate.artifact.clone(),
                policy: candidate.policy,
                launcher: candidate.launcher,
                expected: expected.clone(),
            })),
        )?;
        if response.runtime.as_ref() != Some(&expected) {
            return Err(invalid_data(
                "running Core handoff response does not match its runtime descriptor",
            ));
        }
        match response.status {
            ShutdownStatus::Draining => Ok(ExistingCore::HandoffAccepted(
                IncumbentDescriptor::Current(Box::new(descriptor)),
                reason,
            )),
            ShutdownStatus::Busy => {
                let retry_after_ms = response.retry_after_ms.unwrap_or(250).clamp(10, 60_000);
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!(
                        "running Core is busy and cannot hand off this Profile; retry after {retry_after_ms} ms"
                    ),
                ))
            }
            ShutdownStatus::Incompatible => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "running Core rejected a forward replacement",
            )),
        }
    }

    fn request_legacy_handoff(
        &self,
        descriptor: IncumbentDescriptor,
        candidate: &CandidateRuntime,
    ) -> io::Result<ExistingCore> {
        let IncumbentDescriptor::Legacy(descriptor) = descriptor else {
            return Err(invalid_data("expected a legacy runtime descriptor"));
        };
        if descriptor.protocol_min <= TRANSPORT_PROTOCOL_MAX
            && descriptor.protocol_max >= TRANSPORT_PROTOCOL_MAX
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "legacy descriptor claims the current transport without a compatibility manifest",
            ));
        }
        checked_owned_entry(
            &self.socket,
            self.owner_uid()?,
            EntryKind::Socket,
            Some(PRIVATE_FILE_MODE),
        )?;
        let auth = self.read_auth()?;
        let expected = LegacyRuntimeGenerationIdentity::from(&descriptor);
        let response = request_json::<_, LegacyShutdownResponse>(
            &self.socket,
            &auth,
            "/core/v1/admin/shutdown",
            &LegacyShutdownRequest {
                version_handoff: Some(LegacyVersionHandoffRequest {
                    protocol_min: candidate.manifest.transport.min,
                    protocol_max: candidate.manifest.transport.max,
                    build_id: candidate.artifact.build_id.clone(),
                    expected: expected.clone(),
                }),
            },
        )?;
        if response.runtime.as_ref() != Some(&expected) {
            return Err(invalid_data(
                "legacy Core handoff response does not match its runtime descriptor",
            ));
        }
        match response.status {
            LegacyShutdownStatus::Draining => Ok(ExistingCore::HandoffAccepted(
                IncumbentDescriptor::Legacy(descriptor),
                CoreSelectionReason::ReplacedContract,
            )),
            LegacyShutdownStatus::Busy => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "legacy Core is busy; retry after {} ms",
                    response.retry_after_ms.unwrap_or(250).clamp(10, 60_000)
                ),
            )),
        }
    }

    pub(crate) fn wait_for_handoff_completion(
        &self,
        lock: &File,
        incumbent: &IncumbentDescriptor,
        candidate: &CandidateRuntime,
    ) -> io::Result<ExistingCore> {
        let deadline = Instant::now() + HANDOFF_EXIT_WAIT;
        loop {
            match fs2::FileExt::try_lock_exclusive(lock) {
                Ok(()) => return Ok(ExistingCore::LockAcquired),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            match self.read_incumbent_descriptor() {
                Ok(descriptor) if descriptor.start_nonce() != incumbent.start_nonce() => {
                    return self.probe_or_handoff_running_core(descriptor, candidate);
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "Core {} accepted version handoff but did not release the Profile lock",
                        incumbent.pid()
                    ),
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(crate) fn cleanup(&self, start_nonce: &str) {
        let Ok(descriptor) = self.read_descriptor() else {
            return;
        };
        if descriptor.start_nonce != start_nonce {
            return;
        }
        let Ok(owner_uid) = self.owner_uid() else {
            return;
        };
        let entries = [
            (&self.socket, EntryKind::Socket),
            (&self.auth, EntryKind::File),
            (&self.descriptor, EntryKind::File),
        ];
        if entries.iter().any(|(path, kind)| {
            checked_owned_entry(path, owner_uid, *kind, Some(PRIVATE_FILE_MODE)).is_err()
        }) {
            return;
        }
        for (path, _) in entries {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Clone, Copy)]
enum EntryKind {
    Directory,
    File,
    Socket,
}

fn validate_home(home: &Path) -> io::Result<()> {
    if !home.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Core home must be absolute",
        ));
    }
    let metadata = checked_metadata(home, EntryKind::Directory, None)?;
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Core home is not owned by the current user",
        ));
    }
    Ok(())
}

fn prepare_owned_directory(path: &Path, expected_mode: Option<u32>) -> io::Result<()> {
    let creation_mode = expected_mode.unwrap_or(RUNTIME_DIRECTORY_MODE);
    let mut builder = fs::DirBuilder::new();
    builder.mode(creation_mode);
    match builder.create(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(creation_mode))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    checked_owned_entry(
        path,
        rustix::process::geteuid().as_raw(),
        EntryKind::Directory,
        expected_mode,
    )?;
    Ok(())
}

fn checked_metadata(path: &Path, kind: EntryKind, mode: Option<u32>) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    let valid_kind = match kind {
        EntryKind::Directory => metadata.is_dir(),
        EntryKind::File => metadata.is_file(),
        EntryKind::Socket => metadata.file_type().is_socket(),
    };
    if metadata.file_type().is_symlink() || !valid_kind {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} has an invalid filesystem type", path.display()),
        ));
    }
    if let Some(expected) = mode {
        let actual = metadata.permissions().mode() & 0o777;
        if actual != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} has mode {actual:o}; expected {expected:o}",
                    path.display()
                ),
            ));
        }
    }
    Ok(metadata)
}

fn checked_owned_entry(
    path: &Path,
    owner_uid: u32,
    kind: EntryKind,
    mode: Option<u32>,
) -> io::Result<fs::Metadata> {
    let metadata = checked_metadata(path, kind, mode)?;
    if metadata.uid() != owner_uid || owner_uid != rustix::process::geteuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not owned by the current user", path.display()),
        ));
    }
    Ok(metadata)
}

fn validate_descriptor(descriptor: &RuntimeDescriptor, expected_socket: &Path) -> io::Result<()> {
    let manifest_digest = canonical_manifest_digest(&descriptor.manifest)
        .map_err(|_| invalid_data("Core compatibility manifest is invalid"))?;
    let valid = manifest_digest == descriptor.manifest_digest
        && descriptor.manifest_digest.len() == 64
        && descriptor.artifact.sha256.len() == 64
        && descriptor.artifact.sha256.bytes().all(is_lower_hex)
        && !descriptor.artifact.build_id.is_empty()
        && descriptor.artifact.build_id.len() <= 128
        && descriptor.actual_store_format == descriptor.manifest.store.current
        && descriptor.pid > 0
        && descriptor.start_nonce.len() == 32
        && descriptor.start_nonce.bytes().all(is_lower_hex)
        && Path::new(&descriptor.socket_path) == expected_socket
        && !descriptor.profile_id.is_empty()
        && descriptor.profile_id.len() <= 512
        && !descriptor.store_epoch.is_empty()
        && descriptor.store_epoch.len() <= 512
        && descriptor.readiness_generation >= 1;
    if !valid {
        return Err(invalid_data("Core runtime descriptor fields are invalid"));
    }
    Ok(())
}

fn validate_legacy_descriptor(
    descriptor: &LegacyRuntimeDescriptor,
    expected_socket: &Path,
) -> io::Result<()> {
    let valid = descriptor.protocol_min >= 1
        && descriptor.protocol_min <= descriptor.protocol_max
        && !descriptor.build_id.is_empty()
        && descriptor.build_id.len() <= 128
        && descriptor.pid > 0
        && descriptor.start_nonce.len() == 32
        && descriptor.start_nonce.bytes().all(is_lower_hex)
        && Path::new(&descriptor.socket_path) == expected_socket
        && !descriptor.profile_id.is_empty()
        && descriptor.profile_id.len() <= 512
        && !descriptor.store_epoch.is_empty()
        && descriptor.store_epoch.len() <= 512
        && descriptor.readiness_generation >= 1;
    if !valid {
        return Err(invalid_data(
            "legacy Core runtime descriptor fields are invalid",
        ));
    }
    Ok(())
}

fn request_json<Request: serde::Serialize, Response: serde::de::DeserializeOwned>(
    socket: &Path,
    auth: &str,
    path: &str,
    body: &Request,
) -> io::Result<Response> {
    let body = serde_json::to_vec(body).map_err(io::Error::other)?;
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(PROBE_TIMEOUT))?;
    stream.set_write_timeout(Some(PROBE_TIMEOUT))?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)?;
    let mut response = Vec::new();
    stream
        .take(u64::try_from(MAX_PROBE_RESPONSE_BYTES + 1).expect("bounded response length"))
        .read_to_end(&mut response)?;
    if response.len() > MAX_PROBE_RESPONSE_BYTES {
        return Err(invalid_data("Core startup probe response is oversized"));
    }
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| invalid_data("Core startup probe response is malformed"))?;
    let headers = std::str::from_utf8(&response[..split])
        .map_err(|_| invalid_data("Core startup probe headers are invalid"))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| invalid_data("Core startup probe status is invalid"))?;
    if status != 200 {
        let kind = match status {
            401 | 403 => io::ErrorKind::PermissionDenied,
            404 | 405 => io::ErrorKind::Unsupported,
            409 => io::ErrorKind::InvalidData,
            _ => io::ErrorKind::ConnectionRefused,
        };
        return Err(io::Error::new(
            kind,
            format!("Core startup probe was rejected with HTTP {status}"),
        ));
    }
    serde_json::from_slice(&response[split + 4..])
        .map_err(|_| invalid_data("Core startup probe response is invalid"))
}

pub(crate) fn random_hex(bytes: usize) -> io::Result<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| io::Error::other(format!("getrandom failed: {error:?}")))?;
    Ok(hex::encode(value))
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(crate) fn current_artifact_identity() -> io::Result<CoreArtifactIdentity> {
    let executable = std::env::current_exe()?;
    if !executable.is_absolute() {
        return Err(invalid_data("Core executable path is not absolute"));
    }
    let metadata = checked_owned_entry(
        &executable,
        rustix::process::geteuid().as_raw(),
        EntryKind::File,
        None,
    )?;
    if metadata.len() == 0 || metadata.len() > MAX_CORE_EXECUTABLE_BYTES {
        return Err(invalid_data("Core executable size is invalid"));
    }
    let mut file = File::open(executable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(CoreArtifactIdentity {
        sha256: hex::encode(digest.finalize()),
        build_id: option_env!("NODEX_RELEASE_VERSION")
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::io::BufRead;
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn store_format_fingerprints_match_exact_core_schema_inventories() {
        assert_eq!(
            i64::from(nodex_core_protocol::CURRENT_STORE_VERSION),
            nodex_core::infrastructure::schema::CURRENT_STORE_REVISION,
            "Core protocol and storage current Store versions must match",
        );
        let manifest = nodex_core_protocol::core_compatibility_manifest();
        for format in manifest
            .store
            .migratable
            .iter()
            .chain(&manifest.store.readable)
        {
            let actual = nodex_core::infrastructure::migration::expected_store_schema_fingerprint(
                i64::from(format.version),
            )
            .expect("expected Store schema");
            assert_eq!(
                format.schema_fingerprint, actual,
                "Store v{}",
                format.version
            );
        }
    }

    #[test]
    fn runtime_directory_refuses_symlinked_parents_and_entries() {
        let directory = tempdir().expect("temporary Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let outside = tempdir().expect("outside directory");
        symlink(outside.path(), home.join("run")).expect("symlinked run directory");

        let error = RuntimePaths::prepare(&home).expect_err("symlink must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn stale_socket_cleanup_refuses_non_socket_and_symlink_targets() {
        let directory = tempdir().expect("temporary Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let paths = RuntimePaths::prepare(&home).expect("runtime paths");
        fs::write(&paths.socket, b"not a socket").expect("regular stale entry");
        fs::set_permissions(&paths.socket, fs::Permissions::from_mode(PRIVATE_FILE_MODE))
            .expect("private mode");
        assert!(paths.remove_stale_socket().is_err());
        fs::remove_file(&paths.socket).expect("remove regular entry");
        symlink(&paths.auth, &paths.socket).expect("symlink stale entry");
        assert!(paths.remove_stale_socket().is_err());
        assert!(fs::symlink_metadata(&paths.socket).is_ok());
    }

    #[test]
    fn descriptor_validation_rejects_pid_reuse_without_an_authenticated_server() {
        let directory = tempdir().expect("temporary Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let paths = RuntimePaths::prepare(&home).expect("runtime paths");
        let manifest = nodex_core_protocol::core_compatibility_manifest();
        let manifest_digest = canonical_manifest_digest(&manifest).expect("manifest digest");
        let artifact = CoreArtifactIdentity {
            sha256: "c".repeat(64),
            build_id: "test".to_owned(),
        };
        let descriptor = RuntimeDescriptor {
            manifest: manifest.clone(),
            manifest_digest: manifest_digest.clone(),
            artifact: artifact.clone(),
            actual_store_format: nodex_core_protocol::store_format(
                nodex_core_protocol::CURRENT_STORE_VERSION,
            )
            .expect("Store format"),
            pid: std::process::id(),
            start_nonce: "a".repeat(32),
            socket_path: paths.socket.to_string_lossy().into_owned(),
            profile_id: "profile:test".to_owned(),
            store_epoch: "epoch:test".to_owned(),
            readiness_generation: 1,
        };
        paths
            .atomic_write_private(
                &paths.descriptor,
                serde_json::to_string(&descriptor)
                    .expect("descriptor JSON")
                    .as_bytes(),
            )
            .expect("descriptor file");
        paths
            .atomic_write_private(&paths.auth, format!("{}\n", "b".repeat(64)).as_bytes())
            .expect("auth file");

        let error = paths
            .probe_or_handoff_running_core(
                IncumbentDescriptor::Current(Box::new(descriptor)),
                &CandidateRuntime {
                    manifest,
                    manifest_digest,
                    artifact,
                    requirements: nodex_core_protocol::core_client_requirements(),
                    policy: CoreSelectionPolicy::Compatible,
                    launcher: LauncherKind::Test,
                },
            )
            .expect_err("PID alone cannot prove a running Core");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
        ));
    }

    #[test]
    fn current_selector_uses_the_isolated_forward_handoff_for_transport_two() {
        let directory = tempdir().expect("temporary legacy Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let paths = RuntimePaths::prepare(&home).expect("runtime paths");
        let listener =
            std::os::unix::net::UnixListener::bind(&paths.socket).expect("legacy fixture socket");
        fs::set_permissions(&paths.socket, fs::Permissions::from_mode(PRIVATE_FILE_MODE))
            .expect("private legacy fixture socket");
        let auth = "a".repeat(64);
        paths
            .atomic_write_private(&paths.auth, format!("{auth}\n").as_bytes())
            .expect("legacy fixture auth");
        let legacy = LegacyRuntimeDescriptor {
            protocol_min: 2,
            protocol_max: 2,
            build_id: "legacy-core-test".to_owned(),
            pid: std::process::id(),
            start_nonce: "b".repeat(32),
            socket_path: paths.socket.to_string_lossy().into_owned(),
            profile_id: "profile:legacy".to_owned(),
            store_epoch: "epoch:legacy".to_owned(),
            readiness_generation: 1,
        };
        let expected = LegacyRuntimeGenerationIdentity::from(&legacy);
        let response_runtime = expected.clone();
        let fixture = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("legacy handoff request");
            let mut reader =
                std::io::BufReader::new(stream.try_clone().expect("clone legacy fixture stream"));
            let mut content_length = None;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("legacy request header");
                assert!(!line.is_empty(), "legacy request ended before its body");
                if let Some(value) = line
                    .strip_prefix("Content-Length: ")
                    .and_then(|value| value.trim().parse::<usize>().ok())
                {
                    content_length = Some(value);
                }
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0_u8; content_length.expect("legacy request length")];
            reader.read_exact(&mut body).expect("legacy request body");
            let response = serde_json::to_vec(&serde_json::json!({
                "status": "draining",
                "runtime": response_runtime,
                "retry_after_ms": null
            }))
            .expect("legacy response JSON");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .expect("legacy response head");
            stream.write_all(&response).expect("legacy response body");
            serde_json::from_slice::<serde_json::Value>(&body).expect("legacy handoff JSON")
        });

        let manifest = nodex_core_protocol::core_compatibility_manifest();
        let manifest_digest = canonical_manifest_digest(&manifest).expect("manifest digest");
        let selected = paths
            .request_legacy_handoff(
                IncumbentDescriptor::Legacy(legacy.clone()),
                &CandidateRuntime {
                    manifest,
                    manifest_digest,
                    artifact: CoreArtifactIdentity {
                        sha256: "c".repeat(64),
                        build_id: "current-core-test".to_owned(),
                    },
                    requirements: nodex_core_protocol::core_client_requirements(),
                    policy: CoreSelectionPolicy::Compatible,
                    launcher: LauncherKind::Test,
                },
            )
            .expect("transport 2 forward handoff");
        assert_eq!(
            selected,
            ExistingCore::HandoffAccepted(
                IncumbentDescriptor::Legacy(legacy),
                CoreSelectionReason::ReplacedContract
            )
        );
        let request = fixture.join().expect("join legacy fixture");
        assert_eq!(
            request["version_handoff"]["protocol_min"],
            nodex_core_protocol::TRANSPORT_PROTOCOL_MIN
        );
        assert_eq!(
            request["version_handoff"]["protocol_max"],
            nodex_core_protocol::TRANSPORT_PROTOCOL_MAX
        );
        assert_eq!(
            request["version_handoff"]["expected"],
            serde_json::to_value(expected).expect("legacy expected generation")
        );
    }
}
