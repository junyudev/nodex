#![forbid(unsafe_code)]

mod connections;
mod document_live;
mod document_wire;
mod lifecycle;
mod lifecycle_summary;
mod logging;
mod metrics;
mod request_execution;
mod runtime_files;
mod transport_bounds;

use std::collections::HashSet;
use std::convert::Infallible;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{
    ConnectInfo, DefaultBodyLimit, Extension, OriginalUri, Path as AxumPath, Query, Request, State,
};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH,
};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use fs2::FileExt;
use http_body_util::BodyExt as _;
use nodex_core::ModuleWriterResult;
use nodex_core::administration::StoreAdministrationModule;
use nodex_core::automation::AutomationModule;
use nodex_core::database::DatabaseModule;
use nodex_core::document::{
    AwarenessPublication, DocumentRealtimeEvent, OwnedDocumentModule, OwnedDocumentRealtimeAdapter,
};
use nodex_core::infrastructure::event_log::{
    CoreAuthorizedEventReplay, CoreEventLog, DocumentLiveDelivery,
};
use nodex_core::infrastructure::metrics::DurationMetricSnapshot;
use nodex_core::infrastructure::migration::StorePreparationEvent;
use nodex_core::infrastructure::module_receipts::read_module_receipt;
use nodex_core::infrastructure::sqlite::{
    StoreError, StoreErrorCode, transaction_duration_metrics, with_immediate_transaction,
};
use nodex_core::infrastructure::store::{
    SqliteStoreKernel, persist_clean_shutdown_validation_receipt,
};
use nodex_core::infrastructure::writer::StoreRuntimePhase;
use nodex_core::library::LibraryModule;
use nodex_core::workspace::ProjectWorkspaceModule;
use nodex_core_contracts::administration::StoreAdministrationIntent;
use nodex_core_contracts::document::{
    DocumentLiveBarrier, DocumentLiveEngine, DocumentLiveRepair, DocumentLiveRepairReason,
    OwnedDocumentIntent, OwnedDocumentRead,
};
use nodex_core_contracts::events::DeliveryAuthorizationScope;
use nodex_core_contracts::{
    AdapterKind, ApplyResponse, AuthorizedDeliveryPacket, AuthorizedRecipientLease,
    BoundModuleContext, CommitIdentity, CoreError, CoreErrorCode, CoreErrorRecovery,
    DeliveryAddress, LibraryId, ModuleName, ProfileId, ProjectId, StoreEpoch, StoreObservation,
    StreamCheckpoint,
};
use nodex_core_protocol::{
    AutomationApplyRequest, AutomationApplyResponse, AutomationReadRequest, AutomationReadResponse,
    ClientKind, CoreHealthMetrics, CoreReadiness, CoreRequestCancelRequest,
    CoreRequestCancelResponse, CoreRequestClass as RequestClass, CoreSelectionDisposition,
    CoreSelectionPolicy, CoreSelectionReason, CoreSelectionResult, CoreStartupEvent,
    CoreStartupEventFrame, DatabaseApplyRequest, DatabaseApplyResponse, DatabaseReadRequest,
    DatabaseReadResponse, EventEnvelope, EventReplayRequired, HandshakeRequest, HandshakeResponse,
    HealthDurationMetric, HealthResponse, LauncherKind, LibraryApplyRequest, LibraryApplyResponse,
    LibraryReadRequest, LibraryReadResponse, LocalMutationResolveRequest,
    LocalMutationResolveResponse, MAX_FILE_BLOB_BYTES, OwnedDocumentApplyRequest,
    OwnedDocumentApplyResponse, OwnedDocumentReadRequest, OwnedDocumentReadResponse,
    PrepareFileBlobQuery, ProjectWorkspaceApplyRequest, ProjectWorkspaceApplyResponse,
    ProjectWorkspaceReadRequest, ProjectWorkspaceReadResponse, ResponseEnvelope, RuntimeDescriptor,
    RuntimeGenerationIdentity, ShutdownRequest, ShutdownResponse, ShutdownStatus,
    StoreAdministrationApplyRequest, StoreAdministrationApplyResponse,
    StoreAdministrationReadRequest, StoreAdministrationReadResponse, TRANSPORT_PROTOCOL_MAX,
    TRANSPORT_PROTOCOL_MIN, canonical_manifest_digest, core_client_requirements,
    core_compatibility_manifest, evaluate_compatibility, replacement_is_forward_safe, store_format,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::net::UnixListener;
use tokio::sync::broadcast;
use tracing::Instrument;

use connections::{
    BoundConnection, ConnectionActivity, ConnectionRegistry, ConnectionRegistryError,
    ConnectionRegistryErrorKind, EventSubscriptionKey, PeerIdentity,
};
use document_live::{
    DocumentLiveHub, DocumentLiveNotice, DocumentLivePublisher, DocumentLiveRepairKind,
};
use document_wire::{ApplyFrame, CONTENT_TYPE as DOCUMENT_CONTENT_TYPE, CanvasSyncKind, SyncFrame};
use lifecycle::{DrainReason, LifecycleCoordinator, configured_idle_timeout, monitor_idle};
use lifecycle_summary::LifecycleSummaryWriter;
use metrics::ServerMetrics;
use request_execution::RequestExecutor;
use runtime_files::{
    CandidateRuntime, ExistingCore, PRIVATE_FILE_MODE, RuntimePaths, current_artifact_identity,
    random_hex,
};
use transport_bounds::{MAX_DOCUMENT_REQUEST_BYTES, MAX_JSON_REQUEST_BYTES};

const EVENT_CHANNEL_CAPACITY: usize = 64;
const COMMIT_WAKE_SCAN_LIMIT: u32 = 1_024;
const PROJECT_HEADER: &str = "x-nodex-project-id";
const CONNECTION_HEADER: &str = "x-nodex-connection-id";
const CONNECTION_BINDING_HEADER: &str = "x-nodex-connection-binding";
const DOCUMENT_HEADER: &str = "x-nodex-document-id";
const CLIENT_SESSION_HEADER: &str = "x-nodex-client-session-id";
const EDITOR_HISTORY_OWNER_HEADER: &str = "x-nodex-editor-history-owner";
const DOCUMENT_SCOPE_HEADER: &str = "x-nodex-document-scope";
const LIBRARY_DOCUMENT_SCOPE: &str = "library";
const DATABASE_SCOPE_HEADER: &str = "x-nodex-database-scope";
const LIBRARY_DATABASE_SCOPE: &str = "library";
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
const INTERNAL_STARTUP_EVENTS_ENV: &str = "NODEX_INTERNAL_STARTUP_EVENTS_VERSION";
const INTERNAL_STARTUP_EVENTS_VERSION: u32 = 1;
const MIGRATION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PREPARED_FILE_BLOB_LIFETIME: Duration = Duration::from_secs(15 * 60);
const PAGE_FILE_BLOB_CHUNK_BYTES: usize = 64 * 1024;

fn report_internal_startup_event(event: CoreStartupEvent) {
    if std::env::var(INTERNAL_STARTUP_EVENTS_ENV).as_deref() != Ok("1") {
        return;
    }
    let Ok(line) = serde_json::to_string(&CoreStartupEventFrame {
        startup_event_version: INTERNAL_STARTUP_EVENTS_VERSION,
        event,
    }) else {
        return;
    };
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let _ = writeln!(writer, "{line}");
    let _ = writer.flush();
}

struct MigrationHeartbeat {
    active: Arc<AtomicBool>,
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl MigrationHeartbeat {
    fn start() -> Self {
        let active = Arc::new(AtomicBool::new(false));
        if std::env::var(INTERNAL_STARTUP_EVENTS_ENV).as_deref() != Ok("1") {
            return Self {
                active,
                stop: None,
                worker: None,
            };
        }
        let (stop, receiver) = mpsc::channel();
        let worker_active = Arc::clone(&active);
        let worker = thread::spawn(move || {
            loop {
                match receiver.recv_timeout(MIGRATION_HEARTBEAT_INTERVAL) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if worker_active.load(Ordering::Acquire) {
                            report_internal_startup_event(CoreStartupEvent::MigrationHeartbeat);
                        }
                    }
                }
            }
        });
        Self {
            active,
            stop: Some(stop),
            worker: Some(worker),
        }
    }

    fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }
}

impl Drop for MigrationHeartbeat {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn duration_millis(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

struct ServerState {
    auth_header: String,
    owner_uid: u32,
    connections: ConnectionRegistry,
    lifecycle: LifecycleCoordinator,
    descriptor: Arc<Mutex<RuntimeDescriptor>>,
    profile_id: String,
    schema_version: u32,
    library_id: String,
    library: LibraryModule,
    database: DatabaseModule,
    workspace: ProjectWorkspaceModule,
    automation: AutomationModule,
    administration: StoreAdministrationModule,
    document: OwnedDocumentModule,
    document_realtime: OwnedDocumentRealtimeAdapter,
    store: SqliteStoreKernel,
    event_log: CoreEventLog,
    commit_wake_scanner: CommitWakeScanner,
    event_sender: broadcast::Sender<CommitWake>,
    document_live: DocumentLiveHub,
    document_live_publisher: DocumentLivePublisher,
    metrics: ServerMetrics,
    request_executor: RequestExecutor,
    logging: logging::LoggingHandle,
}

/// A deliberately opaque notification that durable LocalCommit state may
/// have advanced. It contains no sequence that a consumer could mistake for
/// an ordered queue cursor.
#[derive(Clone, Copy, Debug)]
struct CommitWake;

#[derive(Clone)]
struct CommitWakeScanner {
    event_log: CoreEventLog,
    scan_limit: u32,
}

#[derive(Clone)]
enum CommitRecipientResolver {
    BoundScope {
        generation: String,
        context: BoundModuleContext,
    },
    ProjectionBroker {
        generation: String,
        host_context: BoundModuleContext,
        scopes: Vec<DeliveryAuthorizationScope>,
    },
}

impl CommitRecipientResolver {
    fn bound_scope(generation: String, context: BoundModuleContext) -> Self {
        Self::BoundScope {
            generation,
            context,
        }
    }

    fn projection_broker(
        generation: String,
        host_context: BoundModuleContext,
        scopes: Vec<DeliveryAuthorizationScope>,
    ) -> Self {
        Self::ProjectionBroker {
            generation,
            host_context,
            scopes,
        }
    }
}

impl CommitWakeScanner {
    fn new(event_log: CoreEventLog, scan_limit: u32) -> Self {
        Self {
            event_log,
            scan_limit,
        }
    }

    async fn barrier(&self) -> Result<(StoreEpoch, i64), StoreError> {
        let event_log = self.event_log.clone();
        tokio::task::spawn_blocking(move || event_log.stream_barrier())
            .await
            .map_err(blocking_event_delivery_error)?
    }

    async fn scan(
        &self,
        durable_cursor: i64,
        resolver: CommitRecipientResolver,
    ) -> Result<CoreAuthorizedEventReplay, StoreError> {
        let event_log = self.event_log.clone();
        let scan_limit = self.scan_limit;
        tokio::task::spawn_blocking(move || match resolver {
            CommitRecipientResolver::BoundScope {
                generation,
                context,
            } => event_log.scan_authorized(
                durable_cursor,
                Some(scan_limit),
                &generation,
                &context,
                None,
            ),
            CommitRecipientResolver::ProjectionBroker {
                generation,
                host_context,
                scopes,
            } => event_log.scan_authorized_projection_live(
                durable_cursor,
                Some(scan_limit),
                &generation,
                &host_context,
                &scopes,
            ),
        })
        .await
        .map_err(blocking_event_delivery_error)?
    }
}

#[cfg(test)]
mod commit_wake_tests {
    use super::*;

    #[tokio::test]
    async fn lagged_wakes_expose_no_cursor_and_leave_the_receiver_live() {
        assert_eq!(std::mem::size_of::<CommitWake>(), 0);
        let (sender, _) = broadcast::channel(1);
        let mut receiver = sender.subscribe();

        sender.send(CommitWake).expect("first wake");
        sender.send(CommitWake).expect("second wake");
        assert!(matches!(
            receiver.recv().await,
            Err(broadcast::error::RecvError::Lagged(1))
        ));

        assert!(matches!(receiver.recv().await, Ok(CommitWake)));
        sender.send(CommitWake).expect("post-lag wake");
        assert!(matches!(receiver.recv().await, Ok(CommitWake)));
    }
}

fn descriptor_snapshot(state: &ServerState) -> RuntimeDescriptor {
    state
        .descriptor
        .lock()
        .expect("runtime descriptor mutex poisoned")
        .clone()
}

#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: i64,
}

#[derive(Deserialize)]
struct ProjectionLiveQuery {
    scopes: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ProjectionLiveRequestedScope {
    Library,
    Project { project_id: String },
}

#[derive(Serialize)]
struct ProjectionLiveBarrier {
    store_epoch: StoreEpoch,
    core_generation: String,
    commit_head: i64,
    recipient_leases: Vec<AuthorizedRecipientLease>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ProjectionLiveRepairReason {
    PayloadUnavailable,
    IdentityChanged,
}

#[derive(Serialize)]
struct ProjectionLiveRepair {
    store_epoch: StoreEpoch,
    commit_head: i64,
    reason: ProjectionLiveRepairReason,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: &self.message,
            }),
        )
            .into_response()
    }
}

async fn authenticate(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<PeerIdentity>,
    request: Request,
    next: Next,
) -> Response {
    let supplied = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !peer.is_authenticated_owner(state.owner_uid)
        || !constant_time_equal(supplied.as_bytes(), state.auth_header.as_bytes())
    {
        return ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(request).await
}

async fn trace_request(request: Request, next: Next) -> Response {
    let request_id = format!(
        "core:{}:{}",
        std::process::id(),
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        _ => "OTHER",
    };
    let (path, module) = route_observability(request.uri().path());
    let span = tracing::info_span!(
        "core_request",
        requestId = %request_id,
        method = %method,
        path = %path,
        module,
        connectionId = tracing::field::Empty,
        adapter = tracing::field::Empty,
        operationId = tracing::field::Empty,
        receiptKey = tracing::field::Empty,
    );
    async move {
        let started_at = Instant::now();
        let response = next.run(request).await;
        let status = response.status().as_u16();
        let duration_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        if status >= 500 {
            tracing::error!(status, durationMs = duration_ms, "Core request completed");
        } else if status >= 400 {
            tracing::warn!(status, durationMs = duration_ms, "Core request completed");
        } else if duration_ms >= 1_000 {
            tracing::info!(status, durationMs = duration_ms, "Core request completed");
        } else {
            tracing::debug!(status, durationMs = duration_ms, "Core request completed");
        }
        response
    }
    .instrument(span)
    .await
}

fn route_observability(path: &str) -> (&'static str, &'static str) {
    match path {
        "/core/v1/health" => ("/core/v1/health", "health"),
        "/core/v1/handshake" => ("/core/v1/handshake", "lifecycle"),
        "/core/v1/admin/shutdown" => ("/core/v1/admin/shutdown", "lifecycle"),
        "/core/v1/events" => ("/core/v1/events", "lifecycle"),
        "/core/v1/local-mutations/resolve" => {
            ("/core/v1/local-mutations/resolve", "local_mutation")
        }
        "/core/v1/modules/library/read" => ("/core/v1/modules/library/read", "library"),
        "/core/v1/modules/library/apply" => ("/core/v1/modules/library/apply", "library"),
        "/core/v1/modules/database/read" => ("/core/v1/modules/database/read", "database"),
        "/core/v1/modules/database/apply" => ("/core/v1/modules/database/apply", "database"),
        "/core/v1/modules/workspace/read" => {
            ("/core/v1/modules/workspace/read", "project_workspace")
        }
        "/core/v1/modules/workspace/apply" => {
            ("/core/v1/modules/workspace/apply", "project_workspace")
        }
        "/core/v1/modules/automation/read" => ("/core/v1/modules/automation/read", "automation"),
        "/core/v1/modules/automation/apply" => ("/core/v1/modules/automation/apply", "automation"),
        "/core/v1/modules/administration/read" => (
            "/core/v1/modules/administration/read",
            "store_administration",
        ),
        "/core/v1/modules/administration/apply" => (
            "/core/v1/modules/administration/apply",
            "store_administration",
        ),
        "/core/v1/modules/document/read" => ("/core/v1/modules/document/read", "owned_document"),
        "/core/v1/modules/document/apply" => ("/core/v1/modules/document/apply", "owned_document"),
        _ => ("unmatched", "unmatched"),
    }
}

async fn bind_connection(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<PeerIdentity>,
    mut request: Request,
    next: Next,
) -> Response {
    if state.lifecycle.is_draining() {
        return ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Core is draining").into_response();
    }
    let bound = match bind_authenticated_connection(&state, request.headers(), &peer) {
        Ok(bound) => bound,
        Err(error) => return error.into_response(),
    };
    if !state.lifecycle.record_activity() {
        return ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Core is draining").into_response();
    }
    let connection_id = log_identity(&bound.id);
    tracing::Span::current().record("connectionId", connection_id.as_str());
    tracing::Span::current().record("adapter", adapter_name(&bound.adapter));
    request.extensions_mut().insert(bound);
    next.run(request).await
}

fn adapter_name(adapter: &AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::ElectronHost => "electron_host",
        AdapterKind::LoopbackHttp => "loopback_http",
        AdapterKind::NativeCli => "native_cli",
        AdapterKind::Agent => "agent",
        AdapterKind::Test => "test",
    }
}

fn bind_authenticated_connection(
    state: &ServerState,
    headers: &HeaderMap,
    peer: &PeerIdentity,
) -> Result<BoundConnection, ApiError> {
    let connection_id =
        required_header(headers, CONNECTION_HEADER, "Connection").map_err(api_core_error)?;
    let binding = required_header(headers, CONNECTION_BINDING_HEADER, "Connection binding")
        .map_err(api_core_error)?;
    state
        .connections
        .bind(&connection_id, &binding, peer)
        .map_err(connection_registry_error)
}

async fn health(State(state): State<Arc<ServerState>>) -> Json<HealthResponse> {
    let descriptor = descriptor_snapshot(&state);
    let (status, metrics) = health_metrics(&state);
    Json(HealthResponse {
        status,
        pid: descriptor.pid,
        start_nonce: descriptor.start_nonce,
        metrics,
    })
}

fn health_metrics(state: &ServerState) -> (CoreReadiness, CoreHealthMetrics) {
    let store_activity = state.store.activity();
    let mut status = match store_activity.phase {
        StoreRuntimePhase::Running => CoreReadiness::Ready,
        StoreRuntimePhase::Maintenance => CoreReadiness::Maintenance,
        StoreRuntimePhase::Closed => CoreReadiness::Failed,
    };
    if state.lifecycle.is_draining() {
        status = CoreReadiness::Draining;
    }
    let connections = state.connections.activity().ok();
    let realtime = state.document_realtime.activity().ok();
    let cache = state.document.cache_metrics().ok();
    let prepared_operations = state
        .document
        .prepared_agent_operation_count()
        .and_then(|document| {
            state
                .library
                .prepared_agent_operation_count()
                .map(|library| document.saturating_add(library))
        })
        .ok();
    let commit_head = state.event_log.head().ok();
    let wal_size_bytes = wal_size_bytes(state.store.database_path()).ok();
    if connections.is_none()
        || realtime.is_none()
        || cache.is_none()
        || prepared_operations.is_none()
        || commit_head.is_none()
        || wal_size_bytes.is_none()
    {
        status = CoreReadiness::Failed;
    }
    let connections = connections.unwrap_or(ConnectionActivity {
        clients: 0,
        event_subscriptions: 0,
    });
    let realtime = realtime.unwrap_or_default();
    let cache = cache.unwrap_or_default();
    let cache_total = cache.hits.saturating_add(cache.misses);
    let cache_hit_rate_ppm = if cache_total == 0 {
        0
    } else {
        u32::try_from((u128::from(cache.hits) * 1_000_000_u128) / u128::from(cache_total))
            .unwrap_or(1_000_000)
    };
    let (event_replay_lag, event_replay_lag_max) = state.metrics.event_replay_lag();
    let (
        canvas_sync_initial_snapshots,
        canvas_sync_repair_snapshots,
        canvas_sync_up_to_date,
        canvas_sync_snapshot_bytes,
    ) = state.metrics.canvas_sync();
    let store_metrics = state.store.metrics();
    let block_transfer_metrics = state.library.block_transfer_metrics();
    let request_metrics = state.request_executor.snapshot();
    (
        status,
        CoreHealthMetrics {
            active_requests: request_metrics.active,
            queued_requests: request_metrics.queued,
            request_admission_wait: health_duration(request_metrics.admission_wait),
            request_execution_duration: health_duration(request_metrics.execution_duration),
            request_deadline_exceeded: request_metrics.deadline_exceeded,
            request_cancelled: request_metrics.cancelled,
            request_overloaded: request_metrics.overloaded,
            writer_queue_depth: usize_to_u64(store_activity.queued_writes),
            active_writer_commands: usize_to_u64(store_activity.active_writes),
            active_read_commands: usize_to_u64(store_activity.active_reads),
            command_latency: health_duration(store_metrics.command_latency),
            writer_queue_wait: health_duration(store_metrics.writer_queue_wait),
            writer_execution: health_duration(store_metrics.writer_execution),
            transaction_duration: health_duration(transaction_duration_metrics()),
            document_cache_entries: usize_to_u64(cache.entries),
            document_cache_state_bytes: usize_to_u64(cache.state_bytes),
            document_cache_hits: cache.hits,
            document_cache_misses: cache.misses,
            document_cache_hit_rate_ppm: cache_hit_rate_ppm,
            document_reconstruction_duration: health_duration(
                state.document.reconstruction_metrics(),
            ),
            block_transfer_prepare_duration: health_duration(
                block_transfer_metrics.page_parent_prepare,
            ),
            block_transfer_reconstruct_duration: health_duration(
                block_transfer_metrics.page_parent_reconstruct,
            ),
            block_transfer_decode_duration: health_duration(
                block_transfer_metrics.page_parent_decode,
            ),
            block_transfer_transform_duration: health_duration(
                block_transfer_metrics.page_parent_transform,
            ),
            block_transfer_encode_duration: health_duration(
                block_transfer_metrics.page_parent_encode,
            ),
            block_transfer_apply_duration: health_duration(
                block_transfer_metrics.page_parent_apply,
            ),
            local_commit_publication_duration: health_duration(
                state.metrics.local_commit_publication_duration(),
            ),
            commit_head: commit_head.unwrap_or_default(),
            event_replay_lag,
            event_replay_lag_max,
            wal_size_bytes: wal_size_bytes.unwrap_or_default(),
            backup_duration: health_duration(state.metrics.backup_duration()),
            canvas_sync_initial_snapshots,
            canvas_sync_repair_snapshots,
            canvas_sync_up_to_date,
            canvas_sync_snapshot_bytes,
            active_clients: usize_to_u64(connections.clients),
            active_event_subscriptions: usize_to_u64(connections.event_subscriptions),
            active_document_subscriptions: usize_to_u64(realtime.subscriptions),
            active_awareness_clients: usize_to_u64(realtime.awareness_clients),
            active_prepared_agent_operations: usize_to_u64(prepared_operations.unwrap_or_default()),
            dropped_log_records: state.logging.dropped_records(),
        },
    )
}

fn health_duration(metric: DurationMetricSnapshot) -> HealthDurationMetric {
    HealthDurationMetric {
        count: metric.count,
        total_micros: metric.total_micros,
        last_micros: metric.last_micros,
        max_micros: metric.max_micros,
    }
}

fn wal_size_bytes(database_path: &Path) -> io::Result<u64> {
    let mut wal_path = database_path.as_os_str().to_os_string();
    wal_path.push("-wal");
    match fs::metadata(PathBuf::from(wal_path)) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

async fn handshake(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<PeerIdentity>,
    Json(request): Json<HandshakeRequest>,
) -> Result<Json<HandshakeResponse>, ApiError> {
    if state.lifecycle.is_draining() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Core is draining",
        ));
    }
    let descriptor = descriptor_snapshot(&state);
    let generation = RuntimeGenerationIdentity::from(&descriptor);
    let compatibility = evaluate_compatibility(
        &request.requirements,
        &descriptor.manifest,
        &descriptor.actual_store_format,
    );
    if request.expected_generation != generation || compatibility.is_err() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "Core compatibility or generation mismatch: {:?}",
                compatibility.err().unwrap_or_default()
            ),
        ));
    }
    if !valid_binding(&request.connection_id)
        || request.client.build_id.is_empty()
        || request.client.build_id.len() > 128
        || request.client.build_id.trim() != request.client.build_id
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "client or connection identity is invalid",
        ));
    }
    let adapter = match request.client.kind {
        ClientKind::ElectronHost => AdapterKind::ElectronHost,
        ClientKind::NativeCli => AdapterKind::NativeCli,
        ClientKind::Test => AdapterKind::Test,
    };
    let connection_binding = connection_binding(
        &state,
        &request.connection_id,
        &adapter,
        &peer,
        &request.client.build_id,
    );
    state
        .connections
        .register(
            &request.connection_id,
            connection_binding.clone(),
            adapter.clone(),
            &peer,
            &request.client.build_id,
            TRANSPORT_PROTOCOL_MAX,
        )
        .map_err(connection_registry_error)?;
    let connection_id = log_identity(&request.connection_id);
    tracing::Span::current().record("connectionId", connection_id.as_str());
    tracing::Span::current().record("adapter", adapter_name(&adapter));
    if !state.lifecycle.record_activity() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Core is draining",
        ));
    }

    let commit_head = state.event_log.head().map_err(|error| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Core event head is unavailable: {}", error.message),
        )
    })?;
    Ok(Json(HandshakeResponse {
        selected_transport_version: TRANSPORT_PROTOCOL_MAX,
        selected_event_version: request.requirements.event_version,
        selected_module_versions: request.requirements.modules,
        manifest_digest: descriptor.manifest_digest,
        artifact: descriptor.artifact,
        actual_store_format: descriptor.actual_store_format,
        generation,
        library_id: state.library_id.clone(),
        connection_binding,
        store_epoch: descriptor.store_epoch,
        schema_version: state.schema_version,
        commit_head,
    }))
}

async fn library_read(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(LibraryReadRequest(request)): Json<LibraryReadRequest>,
) -> Json<LibraryReadResponse> {
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(LibraryReadResponse(response_envelope(Err(error))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.library.read(&context, request)
        })
        .await;
    Json(LibraryReadResponse(response_envelope(response)))
}

async fn prepare_blob(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    Query(query): Query<PrepareFileBlobQuery>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<nodex_core_contracts::library::PreparedBlobReceipt>, ApiError> {
    let limit = if uri.path() == "/core/v1/blobs/prepare" {
        nodex_core_protocol::MAX_MANAGED_BLOB_BYTES
    } else {
        MAX_FILE_BLOB_BYTES
    };
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    if context.project_id.is_none()
        && !matches!(
            context.adapter,
            nodex_core_contracts::AdapterKind::ElectronHost
                | nodex_core_contracts::AdapterKind::NativeCli
                | nodex_core_contracts::AdapterKind::Test
        )
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Prepared Blobs require a Project or trusted local Library authority",
        ));
    }
    if headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Blob exceeds its byte bound",
        ));
    }
    let gc_state = Arc::clone(&state);
    state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Background, move || {
            gc_state.library.collect_unreachable_file_blobs(100)
        })
        .await
        .map_err(api_core_error)?;
    let assets_root = state.library.file_blob_root().map_err(api_core_error)?;
    let published = publish_blob(assets_root, request.into_body(), limit as u64).await?;
    let receipt_id = match query.idempotency_slot.as_deref() {
        Some(slot) => {
            if slot.is_empty() || slot.len() > 512 {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Prepared Blob idempotency slot must contain 1 to 512 bytes",
                ));
            }
            let identity =
                serde_json::to_vec(&(query.operation_id.as_str(), slot)).map_err(|_| {
                    ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Prepared Blob identity could not be encoded",
                    )
                })?;
            format!(
                "prepared-blob:stable:{}",
                hex::encode(Sha256::digest(identity))
            )
        }
        None => format!(
            "prepared-blob:{}",
            random_hex(24).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Prepared Blob identity failed: {error}"),
                )
            })?
        ),
    };
    let expires_at_unix_ms = SystemTime::now()
        .checked_add(PREPARED_FILE_BLOB_LIFETIME)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Prepared Blob expiry is unavailable",
            )
        })?;
    let request_state = Arc::clone(&state);
    let operation_id = query.operation_id;
    let expected_store_epoch = query.store_epoch;
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.library.register_prepared_file_blob(
                &context,
                &expected_store_epoch,
                &operation_id,
                &receipt_id,
                &published.content_hash,
                &published.physical_asset_name,
                published.byte_length,
                expires_at_unix_ms,
            )
        })
        .await
        .map_err(api_core_error)?;
    Ok(Json(response))
}

async fn read_file_blob(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    AxumPath(file_id): AxumPath<String>,
    Query(query): Query<nodex_core_protocol::ReadFileBlobQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    let request_state = Arc::clone(&state);
    let descriptor = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.library.resolve_file_blob(
                &context,
                &file_id,
                &query.source,
                query.version,
            )
        })
        .await
        .map_err(api_core_error)?;
    stream_file_blob(
        headers,
        descriptor.file,
        descriptor.mime_type,
        descriptor.byte_length,
        descriptor.blob_etag,
    )
    .await
}

async fn read_thread_asset_blob(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    AxumPath((thread_id, content_hash)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    let request_state = Arc::clone(&state);
    let descriptor = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state
                .workspace
                .resolve_thread_asset_blob(&context, &thread_id, &content_hash)
        })
        .await
        .map_err(api_core_error)?;
    stream_file_blob(
        headers,
        descriptor.file,
        "application/octet-stream".to_owned(),
        descriptor.byte_length,
        descriptor.content_hash,
    )
    .await
}

async fn stream_file_blob(
    headers: HeaderMap,
    file: fs::File,
    mime_type: String,
    byte_length: u64,
    blob_etag: String,
) -> Result<Response, ApiError> {
    let etag = format!("\"{blob_etag}\"");
    if headers
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|candidate| candidate.trim() == etag))
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(ETAG, etag)
            .header(CACHE_CONTROL, "private, no-cache")
            .body(Body::empty())
            .map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("File Blob response failed: {error}"),
                )
            });
    }
    let mut file = tokio::fs::File::from_std(file);
    let stream = async_stream::stream! {
        let mut buffer = vec![0_u8; PAGE_FILE_BLOB_CHUNK_BYTES];
        loop {
            match file.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => yield Ok::<Bytes, io::Error>(Bytes::copy_from_slice(&buffer[..read])),
                Err(error) => {
                    yield Err::<Bytes, io::Error>(error);
                    break;
                }
            }
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime_type)
        .header(CONTENT_LENGTH, byte_length.to_string())
        .header(ETAG, etag)
        .header(CACHE_CONTROL, "private, no-cache")
        .header(transport_bounds::BOUNDED_STREAM_HEADER, "file-blob")
        .body(Body::from_stream(stream))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("File Blob response failed: {error}"),
            )
        })
}

async fn publish_blob(
    assets_root: PathBuf,
    mut body: Body,
    limit: u64,
) -> Result<nodex_core::infrastructure::managed_blobs::PublishedBlob, ApiError> {
    use nodex_core::infrastructure::managed_blobs::BlobWriter;
    let mut writer = tokio::task::spawn_blocking(move || BlobWriter::new(&assets_root, limit))
        .await
        .map_err(blob_task_error)?
        .map_err(blob_store_error)?;
    while let Some(frame) = body.frame().await {
        let frame = frame
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "File Blob body is invalid"))?;
        let Ok(bytes) = frame.into_data() else {
            continue;
        };
        writer = tokio::task::spawn_blocking(move || {
            writer.write_chunk(&bytes)?;
            Ok::<_, nodex_core::infrastructure::sqlite::StoreError>(writer)
        })
        .await
        .map_err(blob_task_error)?
        .map_err(blob_store_error)?;
    }
    tokio::task::spawn_blocking(move || writer.finish())
        .await
        .map_err(blob_task_error)?
        .map_err(blob_store_error)
}

fn blob_task_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Blob storage task failed: {error}"),
    )
}

fn blob_store_error(error: nodex_core::infrastructure::sqlite::StoreError) -> ApiError {
    use nodex_core::infrastructure::sqlite::StoreErrorCode;
    let status = match error.code {
        StoreErrorCode::ResourceExhausted => StatusCode::PAYLOAD_TOO_LARGE,
        StoreErrorCode::StoreCorrupt => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError::new(status, error.message)
}

async fn cancel_request(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    Json(request): Json<CoreRequestCancelRequest>,
) -> Json<CoreRequestCancelResponse> {
    Json(CoreRequestCancelResponse {
        cancelled: state
            .request_executor
            .cancel(&bound.id, &request.request_id),
    })
}

fn module_storage_name(module: ModuleName) -> &'static str {
    match module {
        ModuleName::Library => "library",
        ModuleName::Database => "database",
        ModuleName::OwnedDocument => "owned_document",
        ModuleName::ProjectWorkspace => "project_workspace",
        ModuleName::Automation => "automation",
        ModuleName::StoreAdministration => "store_administration",
    }
}

/// Apply responses are capabilities for the command's bound authorization
/// scope. The Electron Host receives its broader, multiplexed broker view on
/// the live/durable delivery interfaces; that authority must never ride an IPC
/// response into the initiating renderer.
fn authorized_apply_packet(
    state: &ServerState,
    commit_seq: i64,
    context: &BoundModuleContext,
) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
    state
        .event_log
        .authorized_packet(commit_seq, context, None, true)
}

fn build_authorized_apply_response<T, R>(
    state: &ServerState,
    module: ModuleName,
    operation_id: &str,
    context: &BoundModuleContext,
    duplicate: bool,
    committed: ModuleWriterResult<T, R>,
) -> Result<ApplyResponse<T, R>, CoreError> {
    let stored = state
        .store
        .readers()
        .read_default(|connection| {
            read_module_receipt(connection, module_storage_name(module), operation_id)
        })
        .map_err(apply_response_store_error)?
        .ok_or_else(|| apply_response_corrupt("Committed command receipt is unavailable"))?;
    let ModuleWriterResult {
        value: outcome,
        receipt,
        commit_seq: observed_commit_seq,
        store_epoch,
        ..
    } = committed;
    let Some(commit_seq) = stored.local_commit_seq else {
        let response = ApplyResponse::NoOp {
            outcome,
            receipt,
            observed: StoreObservation {
                store_epoch,
                commit_head: observed_commit_seq,
            },
        };
        record_apply_response(&response, duplicate);
        return Ok(response);
    };
    let commit_retained = !stored.detached;
    let commit = if commit_retained {
        state
            .event_log
            .commit_identity(commit_seq)
            .map_err(apply_response_store_error)?
    } else {
        CommitIdentity {
            store_epoch: StoreEpoch(stored.store_epoch.clone()),
            commit_seq,
            manifest_hash: stored.commit_manifest_hash.clone().ok_or_else(|| {
                apply_response_corrupt("Detached command receipt has no manifest identity")
            })?,
        }
    };
    if commit.commit_seq != observed_commit_seq || commit.store_epoch != store_epoch {
        return Err(apply_response_corrupt(
            "Committed command result diverges from its manifest identity",
        ));
    }

    // Publication is an at-least-once wake for already-durable authority, not
    // a consequence of successfully reconstructing the caller's optional
    // delivery. Republish exact retries as well: scanners and resource
    // dispatchers deduplicate by commit/resource identity, while a retry may
    // be the first observable wake after a post-commit response failure.
    let delivery = if commit_retained {
        publish_local_commit(state, commit_seq, commit.store_epoch.0.clone());
        authorized_apply_packet(state, commit_seq, context).map_err(apply_response_store_error)?
    } else {
        None
    };
    let response = ApplyResponse::Committed {
        outcome,
        receipt,
        commit,
        delivery: delivery.map(Box::new),
    };
    record_apply_response(&response, duplicate);
    Ok(response)
}

fn apply_response_store_error(error: StoreError) -> CoreError {
    let code = match error.code {
        StoreErrorCode::DeadlineExceeded => CoreErrorCode::DeadlineExceeded,
        StoreErrorCode::QueryCancelled => CoreErrorCode::Cancelled,
        StoreErrorCode::WriterQueueFull | StoreErrorCode::ReaderPoolTimeout => {
            CoreErrorCode::Overloaded
        }
        StoreErrorCode::StoreCorrupt => CoreErrorCode::StoreCorrupt,
        _ => CoreErrorCode::CoreUnavailable,
    };
    CoreError {
        code,
        message: error.message,
        retryable: error.retryable,
        recovery: CoreErrorRecovery::None,
    }
}

fn apply_response_corrupt(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::StoreCorrupt,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

async fn resolve_local_mutation(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(request): Json<LocalMutationResolveRequest>,
) -> Result<Json<LocalMutationResolveResponse>, ApiError> {
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    if request.operation_id.is_empty()
        || request.operation_id.len() > 512
        || request.operation_id.trim() != request.operation_id
        || request.intent_hash.len() != 64
        || !request
            .intent_hash
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Local mutation resolve identity is invalid",
        ));
    }
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let current_epoch = descriptor_snapshot(&request_state).store_epoch;
            if request.store_epoch.0 != current_epoch {
                return Ok(LocalMutationResolveResponse::EpochMismatch {
                    requested_store_epoch: request.store_epoch,
                    current_store_epoch: StoreEpoch(current_epoch),
                });
            }
            let module_name = module_storage_name(request.module);
            let stored = request_state
                .store
                .readers()
                .read_default(|connection| {
                    read_module_receipt(connection, module_name, &request.operation_id)
                })
                .map_err(apply_response_store_error)?;
            let Some(stored) = stored else {
                return Ok(LocalMutationResolveResponse::NotCommitted {
                    module: request.module,
                    operation_id: request.operation_id,
                });
            };
            if stored.profile_id != context.profile_id.0
                || stored.project_id != context.project_id.as_ref().map(|id| id.0.clone())
            {
                return Ok(LocalMutationResolveResponse::NotCommitted {
                    module: request.module,
                    operation_id: request.operation_id,
                });
            }
            if stored.store_epoch != request.store_epoch.0 {
                return Ok(LocalMutationResolveResponse::EpochMismatch {
                    requested_store_epoch: request.store_epoch,
                    current_store_epoch: StoreEpoch(stored.store_epoch),
                });
            }
            if stored.request_hash != request.intent_hash {
                return Ok(LocalMutationResolveResponse::IntentConflict {
                    module: request.module,
                    operation_id: request.operation_id,
                    expected_hash: request.intent_hash,
                    observed_hash: stored.request_hash,
                });
            }
            let delivery = stored
                .local_commit_seq
                .map(|commit_seq| authorized_apply_packet(&request_state, commit_seq, &context))
                .transpose()
                .map_err(apply_response_store_error)?;
            Ok(LocalMutationResolveResponse::Committed {
                module: request.module,
                operation_id: request.operation_id,
                request_hash: stored.request_hash,
                result: stored.result,
                delivery: delivery.flatten().map(Box::new),
            })
        })
        .await
        .map_err(api_core_error)?;
    Ok(Json(response))
}

async fn library_apply(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(LibraryApplyRequest(request)): Json<LibraryApplyRequest>,
) -> Json<LibraryApplyResponse> {
    record_operation("library", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => return Json(LibraryApplyResponse(response_envelope(Err(error)))),
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let outcome = request_state.library.apply(&context, request)?;
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            build_authorized_apply_response(
                &request_state,
                ModuleName::Library,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    Json(LibraryApplyResponse(response_envelope(response)))
}

async fn database_read(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(DatabaseReadRequest(request)): Json<DatabaseReadRequest>,
) -> Json<DatabaseReadResponse> {
    let context = match database_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(DatabaseReadResponse(response_envelope(Err(error))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.database.read(&context, request)
        })
        .await;
    Json(DatabaseReadResponse(response_envelope(response)))
}

async fn database_apply(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(DatabaseApplyRequest(request)): Json<DatabaseApplyRequest>,
) -> Json<DatabaseApplyResponse> {
    record_operation("database", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let context = match database_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => return Json(DatabaseApplyResponse(response_envelope(Err(error)))),
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let outcome = request_state.database.apply(&context, request)?;
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            build_authorized_apply_response(
                &request_state,
                ModuleName::Database,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    Json(DatabaseApplyResponse(response_envelope(response)))
}

async fn workspace_read(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(ProjectWorkspaceReadRequest(request)): Json<ProjectWorkspaceReadRequest>,
) -> Json<ProjectWorkspaceReadResponse> {
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(ProjectWorkspaceReadResponse(response_envelope(Err(error))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.workspace.read(&context, request)
        })
        .await;
    Json(ProjectWorkspaceReadResponse(response_envelope(response)))
}

async fn workspace_apply(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(ProjectWorkspaceApplyRequest(request)): Json<ProjectWorkspaceApplyRequest>,
) -> Json<ProjectWorkspaceApplyResponse> {
    record_operation("project_workspace", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(ProjectWorkspaceApplyResponse(response_envelope(Err(error))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let outcome = request_state.workspace.apply(&context, request)?;
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            build_authorized_apply_response(
                &request_state,
                ModuleName::ProjectWorkspace,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    Json(ProjectWorkspaceApplyResponse(response_envelope(response)))
}

async fn automation_read(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(AutomationReadRequest(request)): Json<AutomationReadRequest>,
) -> Json<AutomationReadResponse> {
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(AutomationReadResponse(response_envelope(Err(error))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            request_state.automation.read(&context, request)
        })
        .await;
    Json(AutomationReadResponse(response_envelope(response)))
}

async fn automation_apply(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(AutomationApplyRequest(request)): Json<AutomationApplyRequest>,
) -> Json<AutomationApplyResponse> {
    record_operation("automation", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => return Json(AutomationApplyResponse(response_envelope(Err(error)))),
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let outcome = request_state.automation.apply(&context, request)?;
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            build_authorized_apply_response(
                &request_state,
                ModuleName::Automation,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    Json(AutomationApplyResponse(response_envelope(response)))
}

async fn administration_read(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(StoreAdministrationReadRequest(request)): Json<StoreAdministrationReadRequest>,
) -> Json<StoreAdministrationReadResponse> {
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(StoreAdministrationReadResponse(response_envelope(Err(
                error,
            ))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Background, move || {
            request_state.administration.read(&context, request)
        })
        .await;
    Json(StoreAdministrationReadResponse(response_envelope(response)))
}

async fn administration_apply(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Json(StoreAdministrationApplyRequest(request)): Json<StoreAdministrationApplyRequest>,
) -> Json<StoreAdministrationApplyResponse> {
    record_operation("store_administration", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let backup_started_at = matches!(
        &request.intent,
        StoreAdministrationIntent::CreateBackup { .. }
    )
    .then(std::time::Instant::now);
    let context = match module_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(StoreAdministrationApplyResponse(response_envelope(Err(
                error,
            ))));
        }
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Maintenance, move || {
            let outcome = request_state.administration.apply(&context, request)?;
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            if outcome.durability
                == nodex_core::administration::StoreAdministrationOutcomeDurability::Transient
            {
                let response = ApplyResponse::NoOp {
                    outcome: committed.value,
                    receipt: committed.receipt,
                    observed: StoreObservation {
                        store_epoch: committed.store_epoch,
                        commit_head: committed.commit_seq,
                    },
                };
                record_apply_response(&response, duplicate);
                return Ok(response);
            }
            build_authorized_apply_response(
                &request_state,
                ModuleName::StoreAdministration,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    if let Some(started_at) = backup_started_at {
        state.metrics.record_backup_duration(started_at.elapsed());
    }
    Json(StoreAdministrationApplyResponse(response_envelope(
        response,
    )))
}

async fn document_read(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let headers = parts.headers;
    let bound = parts
        .extensions
        .get::<BoundConnection>()
        .cloned()
        .expect("connection middleware binds Document requests");
    let bytes = match to_bytes(body, MAX_DOCUMENT_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return json_document_read_error(invalid("Document read body exceeds its bound")),
    };
    if is_document_binary(&headers) {
        let request_state = Arc::clone(&state);
        let request_headers = headers.clone();
        let request_bound = bound.clone();
        return match state
            .request_executor
            .execute(&bound.id, &headers, RequestClass::Interactive, move || {
                Ok(binary_document_read(
                    &request_state,
                    &request_headers,
                    &request_bound,
                    &bytes,
                ))
            })
            .await
        {
            Ok(response) => response,
            Err(error) => json_document_read_error(error),
        };
    }
    let OwnedDocumentReadRequest(request) = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => return json_document_read_error(invalid("Document read request is invalid")),
    };
    if let OwnedDocumentRead::PrepareAgentSemanticMutation { operation_id, .. } = &request.read {
        record_operation("owned_document", operation_id);
    }
    let context = match document_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(OwnedDocumentReadResponse(response_envelope(Err(error)))).into_response();
        }
    };
    let client_session_id = if matches!(&request.read, OwnedDocumentRead::SyncYjs { .. }) {
        match required_header(&headers, CLIENT_SESSION_HEADER, "Document client session") {
            Ok(value) => Some(value),
            Err(error) => {
                return Json(OwnedDocumentReadResponse(response_envelope(Err(error))))
                    .into_response();
            }
        }
    } else {
        None
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(
            &bound.id,
            &headers,
            RequestClass::Interactive,
            move || match request.read {
                OwnedDocumentRead::SyncYjs {
                    document_id,
                    state_vector,
                    history_after_head_seq,
                } => request_state.document_realtime.sync_yjs(
                    &context,
                    client_session_id.as_deref().expect("validated session"),
                    document_id,
                    state_vector,
                    history_after_head_seq,
                ),
                read => request_state.document.read(
                    &context,
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: request.contract_version,
                        read,
                    },
                ),
            },
        )
        .await;
    Json(OwnedDocumentReadResponse(response_envelope(response))).into_response()
}

async fn document_apply(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let headers = parts.headers;
    let bound = parts
        .extensions
        .get::<BoundConnection>()
        .cloned()
        .expect("connection middleware binds Document requests");
    let bytes = match to_bytes(body, MAX_DOCUMENT_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return json_document_apply_error(invalid("Document apply body exceeds its bound"));
        }
    };
    if is_document_binary(&headers) {
        let request_state = Arc::clone(&state);
        let request_headers = headers.clone();
        let request_bound = bound.clone();
        return match state
            .request_executor
            .execute(&bound.id, &headers, RequestClass::Interactive, move || {
                Ok(binary_document_apply(
                    &request_state,
                    &request_headers,
                    &request_bound,
                    &bytes,
                ))
            })
            .await
        {
            Ok(response) => response,
            Err(error) => json_document_apply_error(error),
        };
    }
    let OwnedDocumentApplyRequest(request) = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => return json_document_apply_error(invalid("Document apply request is invalid")),
    };
    record_operation("owned_document", &request.operation_id);
    let operation_id = request.operation_id.clone();
    let context = match document_context(&state, &headers, &bound) {
        Ok(context) => context,
        Err(error) => {
            return Json(OwnedDocumentApplyResponse(response_envelope(Err(error)))).into_response();
        }
    };
    let realtime_bound = matches!(
        &request.intent,
        OwnedDocumentIntent::ApplyYjsUpdate { .. }
            | OwnedDocumentIntent::ApplyCanvasMutation { .. }
    );
    let client_session_id = if realtime_bound {
        match required_header(&headers, CLIENT_SESSION_HEADER, "Document client session") {
            Ok(value) => Some(value),
            Err(error) => {
                return Json(OwnedDocumentApplyResponse(response_envelope(Err(error))))
                    .into_response();
            }
        }
    } else {
        None
    };
    let request_state = Arc::clone(&state);
    let response = state
        .request_executor
        .execute(&bound.id, &headers, RequestClass::Interactive, move || {
            let outcome = if realtime_bound {
                request_state.document_realtime.apply(
                    &context,
                    client_session_id.as_deref().expect("validated session"),
                    request,
                )?
            } else {
                request_state.document.apply(&context, request)?
            };
            let committed = outcome.committed;
            let duplicate = committed.receipt.mutation.duplicate;
            build_authorized_apply_response(
                &request_state,
                ModuleName::OwnedDocument,
                &operation_id,
                &context,
                duplicate,
                committed,
            )
        })
        .await;
    Json(OwnedDocumentApplyResponse(response_envelope(response))).into_response()
}

fn binary_document_read(
    state: &ServerState,
    headers: &HeaderMap,
    bound: &BoundConnection,
    bytes: &[u8],
) -> Response {
    let result = (|| {
        if bytes.len() > document_wire::MAX_SYNC_FRAME_BYTES {
            return Err(invalid("Document sync frame exceeds its bound"));
        }
        let context = document_context(state, headers, bound)?;
        let document_id = required_header(headers, DOCUMENT_HEADER, "Document")?;
        let header_session =
            required_header(headers, CLIENT_SESSION_HEADER, "Document client session")?;
        match document_wire::decode_sync(bytes)? {
            SyncFrame::Yjs(metadata, state_vector) => {
                require_wire_version(metadata.version)?;
                require_same_identity(
                    &header_session,
                    &metadata.client_session_id,
                    "client session",
                )?;
                let snapshot = state.document_realtime.sync_yjs(
                    &context,
                    &metadata.client_session_id,
                    document_id,
                    state_vector,
                    metadata.history_after_head_seq,
                )?;
                document_wire::parse_yjs_sync(snapshot)
                    .and_then(|sync| document_wire::encode_sync(&sync))
            }
            SyncFrame::Canvas(metadata) => {
                require_wire_version(metadata.version)?;
                require_same_identity(
                    &header_session,
                    &metadata.client_session_id,
                    "client session",
                )?;
                let snapshot = state.document_realtime.sync_canvas(
                    &context,
                    &metadata.client_session_id,
                    document_id,
                )?;
                let sync = document_wire::parse_canvas_sync(snapshot)?;
                if let Some(known_store_epoch) = metadata.known_store_epoch.as_deref()
                    && known_store_epoch != sync.store_epoch
                {
                    return Err(stale_document_store_epoch(&sync.store_epoch));
                }
                if let Some(known_generation) = metadata.known_generation
                    && known_generation != sync.generation
                {
                    return Err(stale_document_generation(sync.generation, sync.head_seq));
                }
                let kind = match (
                    metadata.known_head_seq,
                    metadata.known_scene_hash.as_deref(),
                ) {
                    (Some(known_head_seq), Some(known_scene_hash))
                        if known_head_seq == sync.head_seq
                            && known_scene_hash == sync.scene_hash =>
                    {
                        CanvasSyncKind::UpToDate
                    }
                    (Some(known_head_seq), Some(_)) if known_head_seq == sync.head_seq => {
                        return Err(canvas_scene_corrupt(
                            "Canvas scene hash disagrees at the same Document head",
                        ));
                    }
                    _ => CanvasSyncKind::Snapshot,
                };
                let frame =
                    document_wire::encode_canvas_sync(&sync, &metadata.sync_request_id, kind)?;
                state.metrics.record_canvas_sync(
                    metadata.known_head_seq.is_none(),
                    match kind {
                        CanvasSyncKind::Snapshot => Some(sync.scene_json.len()),
                        CanvasSyncKind::UpToDate => None,
                    },
                );
                Ok(frame)
            }
        }
    })();
    match result {
        Ok(frame) => binary_response(frame),
        Err(error) => json_document_read_error(error),
    }
}

fn binary_document_apply(
    state: &ServerState,
    headers: &HeaderMap,
    bound: &BoundConnection,
    bytes: &[u8],
) -> Response {
    let result = (|| {
        let context = document_context(state, headers, bound)?;
        let document_id = required_header(headers, DOCUMENT_HEADER, "Document")?;
        let header_session =
            required_header(headers, CLIENT_SESSION_HEADER, "Document client session")?;
        match document_wire::decode_apply(bytes)? {
            ApplyFrame::Update(metadata, update) => {
                if bytes.len() > document_wire::MAX_APPLY_FRAME_BYTES {
                    return Err(invalid("Document update frame exceeds its bound"));
                }
                require_wire_version(metadata.version)?;
                require_same_identity(
                    &header_session,
                    &metadata.client_session_id,
                    "client session",
                )?;
                require_same_identity(
                    &descriptor_snapshot(state).store_epoch,
                    &metadata.store_epoch,
                    "store epoch",
                )?;
                let update_id = metadata.update_id.clone();
                record_operation("owned_document", &update_id);
                let outcome = state.document_realtime.apply(
                    &context,
                    &metadata.client_session_id,
                    nodex_core_contracts::ModuleApplyRequest {
                        contract_version:
                            nodex_core_contracts::document::OWNED_DOCUMENT_CONTRACT_VERSION,
                        operation_id: metadata.update_id.clone(),
                        store_epoch: StoreEpoch(metadata.store_epoch),
                        intent: OwnedDocumentIntent::ApplyYjsUpdate {
                            document_id: document_id.clone(),
                            generation: metadata.generation,
                            base_head_seq: metadata.base_head_seq,
                            update_id: metadata.update_id,
                            touched_block_ids: metadata.touched_block_ids,
                            update,
                        },
                    },
                )?;

                let duplicate = outcome.committed.receipt.mutation.duplicate;
                let response = build_authorized_apply_response(
                    state,
                    ModuleName::OwnedDocument,
                    &update_id,
                    &context,
                    duplicate,
                    outcome.committed,
                )?;
                let snapshot = state.document_realtime.sync_yjs(
                    &context,
                    &metadata.client_session_id,
                    document_id,
                    Vec::new(),
                    None,
                )?;
                let sync = document_wire::parse_yjs_sync(snapshot)?;
                document_wire::encode_apply_ack(&response, &update_id, &sync)
            }
            ApplyFrame::Awareness(metadata, update) => {
                if bytes.len() > document_wire::MAX_AWARENESS_FRAME_BYTES {
                    return Err(invalid("Document Awareness frame exceeds its bound"));
                }
                require_wire_version(metadata.version)?;
                require_same_identity(
                    &header_session,
                    &metadata.client_session_id,
                    "client session",
                )?;
                require_same_identity(
                    &descriptor_snapshot(state).store_epoch,
                    &metadata.store_epoch,
                    "store epoch",
                )?;
                if let Some(publication) = state.document_realtime.publish_awareness(
                    &context.connection_id,
                    &metadata.client_session_id,
                    &StoreEpoch(metadata.store_epoch),
                    metadata.generation,
                    &update,
                )? {
                    publish_document_transport(state, publication);
                }
                Ok(serde_json::to_vec(&serde_json::json!({ "accepted": true }))
                    .map_err(|_| invalid("Awareness acknowledgement cannot be encoded"))?)
            }
        }
    })();
    match result {
        Ok(frame)
            if matches!(
                document_wire::decode_apply(bytes),
                Ok(ApplyFrame::Awareness(..))
            ) =>
        {
            ([(CONTENT_TYPE, "application/json")], frame).into_response()
        }
        Ok(frame) => binary_response(frame),
        Err(error) => json_document_apply_error(error),
    }
}

async fn events(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let mut receiver = state.event_sender.subscribe();
    if query.after < 0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Event sequence must be non-negative",
        ));
    }
    if optional_header(&headers, DOCUMENT_HEADER, "Document")
        .map_err(api_core_error)?
        .is_some()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Global event streams cannot bind an exact Document",
        ));
    }
    let event_subscription = state
        .connections
        .acquire_event_subscription(&bound.id, EventSubscriptionKey::Global)
        .map_err(connection_registry_error)?;
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    let stream_descriptor = descriptor_snapshot(&state);
    let generation = stream_descriptor.start_nonce.clone();
    let stream_store_epoch = stream_descriptor.store_epoch;
    let stream_state = Arc::clone(&state);
    let scanner = state.commit_wake_scanner.clone();
    let recipient = CommitRecipientResolver::bound_scope(generation.clone(), context);
    let stream_generation = generation;
    let stream_metrics = state.metrics.clone();
    let mut stream_shutdown = state.lifecycle.subscribe_stream_shutdown();
    let stream = async_stream::stream! {
        let _event_subscription = event_subscription;
        let mut scanned_through = query.after;
        let mut opening = true;
        let mut opening_packet_count = 0_u64;
        loop {
            let current_descriptor = descriptor_snapshot(&stream_state);
            if current_descriptor.store_epoch != stream_store_epoch {
                // Store replacement can invalidate the old scanner before it
                // can form another checkpoint. Emit the new identity first so
                // clients fail closed instead of observing a clean EOF.
                yield Ok(sse_stream_checkpoint(&StreamCheckpoint {
                    store_epoch: StoreEpoch(current_descriptor.store_epoch),
                    generation: current_descriptor.start_nonce,
                    scanned_through_seq: scanned_through,
                    oldest_available_seq: 0,
                    resync_token: None,
                }));
                return;
            }
            loop {
                match scanner.scan(scanned_through, recipient.clone()).await {
                    Ok(CoreAuthorizedEventReplay::Scan { packets, checkpoint, commit_head }) => {
                        if opening {
                            stream_metrics.record_event_replay_lag(commit_head, query.after);
                            opening_packet_count = opening_packet_count.saturating_add(
                                u64::try_from(packets.len()).unwrap_or(u64::MAX),
                            );
                        }
                        for packet in packets {
                            yield Ok(sse_event(&EventEnvelope {
                                transport_version: TRANSPORT_PROTOCOL_MAX,
                                packet,
                            }));
                        }
                        let previous = scanned_through;
                        scanned_through = checkpoint.scanned_through_seq;
                        yield Ok(sse_stream_checkpoint(&checkpoint));
                        if scanned_through >= commit_head {
                            if opening {
                                tracing::debug!(
                                    requestedAfter = query.after,
                                    eventHead = commit_head,
                                    replayCount = opening_packet_count,
                                    "Core event subscription opened"
                                );
                                opening = false;
                            }
                            break;
                        }
                        if scanned_through <= previous {
                            yield Ok(sse_core_resync(&EventReplayRequired {
                                requested_after: previous,
                                oldest_available: checkpoint.oldest_available_seq,
                                commit_head,
                                generation: stream_generation.clone(),
                                resync_token: checkpoint.resync_token.clone().unwrap_or_else(|| {
                                    format!("{}:{previous}:{commit_head}", stream_generation)
                                }),
                            }));
                            return;
                        }
                    }
                    Ok(CoreAuthorizedEventReplay::ResyncRequired {
                        requested_after,
                        oldest_available,
                        commit_head,
                        resync_token,
                    }) => {
                        stream_metrics.record_event_replay_lag(commit_head, query.after);
                        tracing::warn!(
                            requestedAfter = requested_after,
                            eventHead = commit_head,
                            replayCount = opening_packet_count,
                            "Core event subscription requires resynchronization"
                        );
                        yield Ok(sse_core_resync(&EventReplayRequired {
                            requested_after,
                            oldest_available,
                            commit_head,
                            generation: stream_generation.clone(),
                            resync_token,
                        }));
                        return;
                    }
                    Err(error) => {
                        tracing::error!(error = %error.message, "Authorized commit scanner failed");
                        return;
                    }
                }
            }

            let mut rescan = false;
            let mut wake_channel_closed = false;
            loop {
                match receiver.try_recv() {
                    Ok(CommitWake) => rescan = true,
                    Err(broadcast::error::TryRecvError::Lagged(_)) => rescan = true,
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Closed) => {
                        wake_channel_closed = true;
                        break;
                    }
                }
            }
            if wake_channel_closed {
                break;
            }
            if rescan {
                continue;
            }
            tokio::select! {
                () = LifecycleCoordinator::wait_for_stream_shutdown(&mut stream_shutdown) => {
                    break;
                }
                received = receiver.recv() => match received {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    };
    Ok(Sse::new(stream))
}

fn projection_live_scopes(
    state: &ServerState,
    encoded: &str,
) -> Result<Vec<DeliveryAuthorizationScope>, ApiError> {
    if encoded.is_empty() || encoded.len() > 128 * 1024 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Projection live scopes exceed their bound",
        ));
    }
    let requested =
        serde_json::from_str::<Vec<ProjectionLiveRequestedScope>>(encoded).map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "Projection live scopes are invalid",
            )
        })?;
    if requested.is_empty() || requested.len() > 200 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Projection live broker requires between 1 and 200 scopes",
        ));
    }
    let mut seen = HashSet::with_capacity(requested.len());
    let mut scopes = Vec::with_capacity(requested.len());
    for scope in requested {
        let (key, scope) = match scope {
            ProjectionLiveRequestedScope::Library => (
                "library".to_owned(),
                DeliveryAuthorizationScope::Library {
                    library_id: state.library_id.clone(),
                },
            ),
            ProjectionLiveRequestedScope::Project { project_id }
                if !project_id.is_empty()
                    && project_id.len() <= 512
                    && project_id.trim() == project_id =>
            {
                (
                    format!("project:{project_id}"),
                    DeliveryAuthorizationScope::Project {
                        library_id: state.library_id.clone(),
                        project_id,
                    },
                )
            }
            ProjectionLiveRequestedScope::Project { .. } => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "Projection live Project identity is invalid",
                ));
            }
        };
        if !seen.insert(key) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Projection live scopes must be unique",
            ));
        }
        scopes.push(scope);
    }
    scopes.sort();
    Ok(scopes)
}

fn projection_live_subscription_key(
    scopes: &[DeliveryAuthorizationScope],
) -> Result<String, ApiError> {
    let canonical = serde_json::to_vec(scopes).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Projection live subscription identity could not be encoded",
        )
    })?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

fn projection_live_recipient_leases(
    generation: &str,
    scopes: &[DeliveryAuthorizationScope],
) -> Result<Vec<AuthorizedRecipientLease>, ApiError> {
    scopes
        .iter()
        .map(|scope| {
            let delivery_address = match scope {
                DeliveryAuthorizationScope::Library { library_id } => DeliveryAddress::Library {
                    library_id: library_id.clone(),
                },
                DeliveryAuthorizationScope::Project {
                    library_id,
                    project_id,
                } => DeliveryAddress::Project {
                    library_id: library_id.clone(),
                    project_id: project_id.clone(),
                },
                DeliveryAuthorizationScope::Document { .. } => {
                    return Err(ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "Projection live broker does not accept Document addresses",
                    ));
                }
            };
            let encoded =
                serde_json::to_vec(&("recipient-lease-v1", generation, &delivery_address, scope))
                    .map_err(|_| {
                    ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Projection live recipient lease could not be encoded",
                    )
                })?;
            Ok(AuthorizedRecipientLease {
                lease_id: hex::encode(Sha256::digest(encoded)),
                delivery_address,
                authorization_scope: scope.clone(),
            })
        })
        .collect()
}

async fn projection_live_events(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
    Query(query): Query<ProjectionLiveQuery>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    if bound.adapter != AdapterKind::ElectronHost {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Projection live broker requires the Electron Host Adapter",
        ));
    }
    if optional_header(&headers, PROJECT_HEADER, "Project")
        .map_err(api_core_error)?
        .is_some()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Projection live broker cannot bind one command Project",
        ));
    }
    let scopes = projection_live_scopes(&state, &query.scopes)?;
    let subscription_key = projection_live_subscription_key(&scopes)?;
    let event_subscription = state
        .connections
        .acquire_event_subscription(
            &bound.id,
            EventSubscriptionKey::ProjectionLive(subscription_key),
        )
        .map_err(connection_registry_error)?;
    // Install the receiver before observing the barrier. Commits racing the
    // barrier are therefore either covered by the canonical floor or queued.
    let mut receiver = state.event_sender.subscribe();
    let context = module_context(&state, &headers, &bound).map_err(api_core_error)?;
    let scanner = state.commit_wake_scanner.clone();
    let (barrier_epoch, barrier_head) = scanner
        .barrier()
        .await
        .map_err(|error| ApiError::new(StatusCode::CONFLICT, error.message))?;
    let descriptor = descriptor_snapshot(&state);
    if descriptor.store_epoch != barrier_epoch.0 {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Projection live Store identity changed while opening",
        ));
    }
    let recipient = CommitRecipientResolver::projection_broker(
        descriptor.start_nonce.clone(),
        context,
        scopes.clone(),
    );
    let recipient_leases = projection_live_recipient_leases(&descriptor.start_nonce, &scopes)?;
    let barrier = ProjectionLiveBarrier {
        store_epoch: barrier_epoch,
        core_generation: descriptor.start_nonce,
        commit_head: barrier_head,
        recipient_leases,
    };
    let mut stream_shutdown = state.lifecycle.subscribe_stream_shutdown();
    let stream_state = Arc::clone(&state);
    let stream = async_stream::stream! {
        let _event_subscription = event_subscription;
        yield Ok(sse_projection_live_barrier(&barrier));
        let mut delivered_through = barrier.commit_head;
        loop {
            let current = descriptor_snapshot(&stream_state);
            if current.store_epoch != barrier.store_epoch.0 {
                yield Ok(sse_projection_live_repair(&ProjectionLiveRepair {
                    store_epoch: StoreEpoch(current.store_epoch),
                    commit_head: 0,
                    reason: ProjectionLiveRepairReason::IdentityChanged,
                }));
                break;
            }
            loop {
                match scanner.scan(delivered_through, recipient.clone()).await {
                    Ok(CoreAuthorizedEventReplay::Scan { packets, checkpoint, commit_head }) => {
                        for packet in packets {
                            yield Ok(sse_event(&EventEnvelope {
                                transport_version: TRANSPORT_PROTOCOL_MAX,
                                packet,
                            }));
                        }
                        let previous = delivered_through;
                        delivered_through = checkpoint.scanned_through_seq;
                        if delivered_through >= commit_head {
                            break;
                        }
                        if delivered_through <= previous {
                            tracing::error!(
                                durableCursor = previous,
                                commitHead = commit_head,
                                "Projection live scanner did not advance"
                            );
                            yield Ok(sse_projection_live_repair(&ProjectionLiveRepair {
                                store_epoch: barrier.store_epoch.clone(),
                                commit_head,
                                reason: ProjectionLiveRepairReason::PayloadUnavailable,
                            }));
                            return;
                        }
                    }
                    Ok(CoreAuthorizedEventReplay::ResyncRequired { commit_head, .. }) => {
                        yield Ok(sse_projection_live_repair(&ProjectionLiveRepair {
                            store_epoch: barrier.store_epoch.clone(),
                            commit_head,
                            reason: ProjectionLiveRepairReason::PayloadUnavailable,
                        }));
                        return;
                    }
                    Err(error) => {
                        tracing::error!(
                            error = %error.message,
                            durableCursor = delivered_through,
                            "Projection live durable scan failed"
                        );
                        yield Ok(sse_projection_live_repair(&ProjectionLiveRepair {
                            store_epoch: barrier.store_epoch.clone(),
                            commit_head: delivered_through,
                            reason: ProjectionLiveRepairReason::PayloadUnavailable,
                        }));
                        return;
                    }
                }
            }

            let mut rescan = false;
            let mut wake_channel_closed = false;
            loop {
                match receiver.try_recv() {
                    Ok(CommitWake) | Err(broadcast::error::TryRecvError::Lagged(_)) => {
                        rescan = true;
                    }
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Closed) => {
                        wake_channel_closed = true;
                        break;
                    }
                }
            }
            if wake_channel_closed {
                break;
            }
            if rescan {
                continue;
            }
            tokio::select! {
                () = LifecycleCoordinator::wait_for_stream_shutdown(&mut stream_shutdown) => break,
                received = receiver.recv() => match received {
                    Ok(CommitWake) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    };
    Ok(Sse::new(stream))
}

async fn document_live_events(
    State(state): State<Arc<ServerState>>,
    Extension(bound): Extension<BoundConnection>,
    headers: HeaderMap,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let document_id =
        required_header(&headers, DOCUMENT_HEADER, "Document").map_err(api_core_error)?;
    let client_session_id =
        required_header(&headers, CLIENT_SESSION_HEADER, "Document client session")
            .map_err(api_core_error)?;
    let event_subscription = state
        .connections
        .acquire_event_subscription(
            &bound.id,
            EventSubscriptionKey::Document(client_session_id.clone()),
        )
        .map_err(connection_registry_error)?;
    let context = document_context(&state, &headers, &bound).map_err(api_core_error)?;

    // Both receivers are installed before the atomic authorization/read
    // barrier. Notices at or below that barrier are harmless duplicates;
    // every later addressed commit is guaranteed to be observed.
    let mut live_subscription = state.document_live.subscribe(document_id.clone());
    let subscription = state
        .document_realtime
        .subscribe(&context, document_id.clone(), client_session_id.clone())
        .map_err(api_core_error)?;
    let generation = descriptor_snapshot(&state).start_nonce;
    let barrier = DocumentLiveBarrier {
        store_epoch: subscription.store_epoch.clone(),
        core_generation: generation.clone(),
        document_id: subscription.document_id.clone(),
        document_generation: subscription.generation,
        head_seq: subscription.head_seq,
        commit_head: subscription.commit_head,
        engine: match subscription.engine {
            nodex_core::document::DocumentSubscriptionEngine::Yjs => DocumentLiveEngine::Yjs,
            nodex_core::document::DocumentSubscriptionEngine::CanvasScene => {
                DocumentLiveEngine::CanvasScene
            }
        },
    };
    let initial_awareness =
        subscription
            .awareness_update
            .map(|update| DocumentRealtimeEvent::Awareness {
                document_id: subscription.document_id,
                store_epoch: subscription.store_epoch,
                generation: subscription.generation,
                client_session_id: "core:awareness-snapshot".to_owned(),
                update,
            });
    let disconnect = DocumentSubscriptionGuard {
        lease_id: subscription.lease_id,
        adapter: state.document_realtime.clone(),
        connection_id: context.connection_id.clone(),
        client_session_id,
        live_hub: state.document_live.clone(),
    };
    let connection_id = context.connection_id.clone();
    let event_log = state.event_log.clone();
    let mut stream_shutdown = state.lifecycle.subscribe_stream_shutdown();
    tracing::debug!(
        documentId = barrier.document_id,
        commitHead = barrier.commit_head,
        documentHead = barrier.head_seq,
        "Exact Document live session opened"
    );

    let stream_barrier = barrier.clone();
    let stream = async_stream::stream! {
        let _event_subscription = event_subscription;
        let _disconnect = disconnect;
        yield Ok(sse_document_live_barrier(&stream_barrier));
        if let Some(awareness) = initial_awareness {
            yield Ok(sse_document_realtime_event(&awareness));
        }
        loop {
            let (live_receiver, realtime_receiver) = live_subscription.receivers();
            tokio::select! {
                () = LifecycleCoordinator::wait_for_stream_shutdown(&mut stream_shutdown) => {
                    break;
                }
                received = live_receiver.recv() => match received {
                    Ok(DocumentLiveNotice::Commit(commit_seq)) => {
                        if commit_seq <= stream_barrier.commit_head {
                            continue;
                        }
                        match resolve_document_live_delivery(
                            event_log.clone(),
                            commit_seq,
                            context.clone(),
                            stream_barrier.document_id.clone(),
                            stream_barrier.store_epoch.clone(),
                            stream_barrier.core_generation.clone(),
                            stream_barrier.commit_head,
                        ).await {
                            Ok(DocumentLiveDelivery::Packet(packet)) => {
                                yield Ok(sse_event(&EventEnvelope {
                                    transport_version: TRANSPORT_PROTOCOL_MAX,
                                    packet: *packet,
                                }));
                            }
                            Ok(DocumentLiveDelivery::Unrelated) => {}
                            Ok(DocumentLiveDelivery::AccessRevoked) => {
                                yield Ok(sse_document_live_repair_at(
                                    &stream_barrier,
                                    stream_barrier.store_epoch.clone(),
                                    commit_seq,
                                    DocumentLiveRepairReason::AccessRevoked,
                                ));
                                return;
                            }
                            Ok(DocumentLiveDelivery::IdentityChanged(checkpoint)) => {
                                yield Ok(sse_document_live_repair_at(
                                    &stream_barrier,
                                    checkpoint.store_epoch,
                                    checkpoint.scanned_through_seq,
                                    DocumentLiveRepairReason::IdentityChanged,
                                ));
                                return;
                            }
                            Err(error) => {
                                tracing::error!(
                                    error = %error.message,
                                    documentId = stream_barrier.document_id,
                                    commitSequence = commit_seq,
                                    "Exact Document live delivery failed"
                                );
                                yield Ok(sse_document_live_repair_at(
                                    &stream_barrier,
                                    stream_barrier.store_epoch.clone(),
                                    commit_seq,
                                    DocumentLiveRepairReason::PayloadUnavailable,
                                ));
                                return;
                            }
                        }
                    }
                    Ok(DocumentLiveNotice::Repair { store_epoch, commit_head, reason }) => {
                        let reason = match reason {
                            DocumentLiveRepairKind::IdentityChanged => {
                                DocumentLiveRepairReason::IdentityChanged
                            }
                            DocumentLiveRepairKind::PayloadUnavailable => {
                                DocumentLiveRepairReason::PayloadUnavailable
                            }
                        };
                        yield Ok(sse_document_live_repair_at(
                            &stream_barrier,
                            StoreEpoch(store_epoch),
                            commit_head,
                            reason,
                        ));
                        return;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        yield Ok(sse_document_live_repair_at(
                            &stream_barrier,
                            stream_barrier.store_epoch.clone(),
                            stream_barrier.commit_head,
                            DocumentLiveRepairReason::ReceiverLagged,
                        ));
                        return;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                received = realtime_receiver.recv() => match received {
                    Ok(publication) => {
                        if !publication.recipient_connections.iter().any(
                            |recipient| recipient == &connection_id,
                        ) {
                            continue;
                        }
                        if realtime_event_document_id(&publication.event)
                            != stream_barrier.document_id
                        {
                            continue;
                        }
                        yield Ok(sse_document_realtime_event(&publication.event));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        yield Ok(sse_document_live_repair_at(
                            &stream_barrier,
                            stream_barrier.store_epoch.clone(),
                            stream_barrier.commit_head,
                            DocumentLiveRepairReason::ReceiverLagged,
                        ));
                        return;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    };
    Ok(Sse::new(stream))
}

#[allow(clippy::too_many_arguments)]
async fn resolve_document_live_delivery(
    event_log: CoreEventLog,
    commit_seq: i64,
    context: BoundModuleContext,
    document_id: String,
    store_epoch: StoreEpoch,
    generation: String,
    live_after: i64,
) -> Result<DocumentLiveDelivery, StoreError> {
    tokio::task::spawn_blocking(move || {
        event_log.authorized_document_live_delivery(
            commit_seq,
            &context,
            &document_id,
            &store_epoch,
            &generation,
            live_after,
        )
    })
    .await
    .map_err(blocking_event_delivery_error)?
}

fn blocking_event_delivery_error(error: tokio::task::JoinError) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Event delivery worker failed: {error}"),
        false,
    )
}

async fn shutdown(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<PeerIdentity>,
    headers: HeaderMap,
    Json(request): Json<ShutdownRequest>,
) -> Result<Json<ShutdownResponse>, ApiError> {
    if let ShutdownRequest::Replacement(request) = request {
        return replacement_handoff(&state, *request);
    }
    let bound = bind_authenticated_connection(&state, &headers, &peer)?;
    if !matches!(
        bound.adapter,
        AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
    ) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "connection role cannot control Core lifecycle",
        ));
    }
    let connection_id = log_identity(&bound.id);
    tracing::Span::current().record("connectionId", connection_id.as_str());
    tracing::Span::current().record("adapter", adapter_name(&bound.adapter));
    if state.lifecycle.begin_drain(DrainReason::ExplicitShutdown) {
        tracing::info!(reason = "explicit", "Core drain began");
    }
    Ok(Json(ShutdownResponse {
        status: ShutdownStatus::Draining,
        runtime: None,
        retry_after_ms: None,
    }))
}

fn replacement_handoff(
    state: &Arc<ServerState>,
    request: nodex_core_protocol::CoreReplacementRequest,
) -> Result<Json<ShutdownResponse>, ApiError> {
    let descriptor = descriptor_snapshot(state);
    let runtime = Some(RuntimeGenerationIdentity::from(&descriptor));
    let manifest_digest = canonical_manifest_digest(&request.candidate_manifest);
    let forward_safe = replacement_is_forward_safe(
        &descriptor.manifest,
        &request.candidate_manifest,
        &descriptor.actual_store_format,
    );
    let contract_changed = request.candidate_manifest != descriptor.manifest;
    let artifact_changed = request.candidate_artifact.sha256 != descriptor.artifact.sha256;
    let policy_requires_replacement = contract_changed
        || (matches!(
            request.policy,
            nodex_core_protocol::CoreSelectionPolicy::PreferCurrentArtifact
        ) && artifact_changed);
    if request.expected != RuntimeGenerationIdentity::from(&descriptor)
        || manifest_digest.as_ref() != Ok(&request.candidate_manifest_digest)
        || forward_safe.is_err()
        || !policy_requires_replacement
    {
        tracing::warn!(
            reason = "replacement",
            status = "rejected_downgrade",
            "Core replacement rejected"
        );
        return Ok(Json(ShutdownResponse {
            status: ShutdownStatus::Incompatible,
            runtime,
            retry_after_ms: None,
        }));
    }
    if state.lifecycle.is_draining() {
        tracing::debug!(
            reason = "replacement",
            status = "already_draining",
            "Core handoff evaluated"
        );
        return Ok(Json(ShutdownResponse {
            status: ShutdownStatus::Draining,
            runtime,
            retry_after_ms: None,
        }));
    }
    if state
        .lifecycle
        .try_begin_idle_drain_if(DrainReason::Replacement, || {
            descriptor_snapshot(state) == descriptor && server_is_idle(state)
        })
    {
        tracing::info!(
            reason = "replacement",
            status = "accepted",
            "Core drain began"
        );
        return Ok(Json(ShutdownResponse {
            status: ShutdownStatus::Draining,
            runtime,
            retry_after_ms: None,
        }));
    }
    tracing::debug!(
        reason = "replacement",
        status = "busy",
        "Core handoff evaluated"
    );
    Ok(Json(ShutdownResponse {
        status: ShutdownStatus::Busy,
        runtime,
        retry_after_ms: Some(250),
    }))
}

fn router(state: Arc<ServerState>) -> Router {
    let infrastructure_routes = Router::new()
        .route("/core/v1/health", get(health))
        .route("/core/v1/handshake", post(handshake))
        .route("/core/v1/admin/shutdown", post(shutdown));
    let connected_routes = Router::new()
        .route("/core/v1/events", get(events))
        .route("/core/v1/requests/cancel", post(cancel_request))
        .route("/core/v1/projections/live", get(projection_live_events))
        .route(
            "/core/v1/local-mutations/resolve",
            post(resolve_local_mutation),
        )
        .route("/core/v1/modules/library/read", post(library_read))
        .route("/core/v1/modules/library/apply", post(library_apply))
        .route("/core/v1/modules/database/read", post(database_read))
        .route("/core/v1/modules/database/apply", post(database_apply))
        .route("/core/v1/modules/workspace/read", post(workspace_read))
        .route("/core/v1/modules/workspace/apply", post(workspace_apply))
        .route("/core/v1/modules/automation/read", post(automation_read))
        .route("/core/v1/modules/automation/apply", post(automation_apply))
        .route(
            "/core/v1/modules/administration/read",
            post(administration_read),
        )
        .route(
            "/core/v1/modules/administration/apply",
            post(administration_apply),
        )
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            bind_connection,
        ))
        .layer(DefaultBodyLimit::max(MAX_JSON_REQUEST_BYTES));
    let document_routes = Router::new()
        .route("/core/v1/modules/document/read", post(document_read))
        .route("/core/v1/modules/document/apply", post(document_apply))
        .route("/core/v1/modules/document/live", get(document_live_events))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            bind_connection,
        ))
        .layer(DefaultBodyLimit::max(MAX_DOCUMENT_REQUEST_BYTES));
    let file_blob_routes = Router::new()
        .route("/core/v1/blobs/prepare", post(prepare_blob))
        .route(
            "/core/v1/threads/{thread_id}/blobs/{content_hash}",
            get(read_thread_asset_blob),
        )
        .route("/core/v1/files/blobs/prepare", post(prepare_blob))
        .route("/core/v1/files/blobs/{file_id}", get(read_file_blob))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            bind_connection,
        ))
        .layer(DefaultBodyLimit::max(
            nodex_core_protocol::MAX_MANAGED_BLOB_BYTES,
        ));
    infrastructure_routes
        .merge(connected_routes)
        .merge(document_routes)
        .merge(file_blob_routes)
        .layer(middleware::from_fn(transport_bounds::enforce))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            authenticate,
        ))
        .layer(middleware::from_fn(trace_request))
        .with_state(state)
}

fn module_context(
    state: &ServerState,
    headers: &HeaderMap,
    bound: &BoundConnection,
) -> Result<BoundModuleContext, CoreError> {
    Ok(BoundModuleContext {
        profile_id: ProfileId(state.profile_id.clone()),
        library_id: LibraryId(state.library_id.clone()),
        project_id: optional_header(headers, PROJECT_HEADER, "Project")?.map(ProjectId),
        connection_id: bound.id.clone(),
        adapter: bound.adapter.clone(),
        editor_history_owner: editor_history_owner(headers, bound)?,
    })
}

fn editor_history_owner(
    headers: &HeaderMap,
    bound: &BoundConnection,
) -> Result<Option<nodex_core_contracts::BoundEditorHistoryOwner>, CoreError> {
    let Some(id) = optional_header(headers, EDITOR_HISTORY_OWNER_HEADER, "Editor history owner")?
    else {
        return Ok(None);
    };
    if bound.adapter != AdapterKind::ElectronHost {
        return Err(unauthorized(
            "Editor history lifetimes require the authenticated desktop Host",
        ));
    }
    let peer_pid = bound
        .peer_pid
        .ok_or_else(|| unauthorized("Editor history requires authenticated process identity"))?;
    Ok(Some(nodex_core_contracts::BoundEditorHistoryOwner {
        id,
        peer_pid,
    }))
}

fn database_context(
    state: &ServerState,
    headers: &HeaderMap,
    bound: &BoundConnection,
) -> Result<BoundModuleContext, CoreError> {
    let project_id = optional_header(headers, PROJECT_HEADER, "Project")?;
    let database_scope = optional_header(headers, DATABASE_SCOPE_HEADER, "Database scope")?;
    let project_id = match (project_id, database_scope.as_deref()) {
        (Some(project_id), None) => Some(ProjectId(project_id)),
        (None, Some(LIBRARY_DATABASE_SCOPE))
            if matches!(
                bound.adapter,
                AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
            ) =>
        {
            None
        }
        (None, Some(LIBRARY_DATABASE_SCOPE)) => {
            return Err(unauthorized(
                "Library Database scope requires a trusted local Adapter",
            ));
        }
        (Some(_), Some(_)) => {
            return Err(unauthorized(
                "Database access cannot bind both Project and Library scope",
            ));
        }
        (None, Some(_)) => return Err(unauthorized("Database scope is unsupported")),
        (None, None) => return Err(unauthorized("Database scope binding is required")),
    };
    Ok(BoundModuleContext {
        profile_id: ProfileId(state.profile_id.clone()),
        library_id: LibraryId(state.library_id.clone()),
        project_id,
        connection_id: bound.id.clone(),
        adapter: bound.adapter.clone(),
        editor_history_owner: None,
    })
}

fn is_document_binary(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        == Some(DOCUMENT_CONTENT_TYPE)
}

fn binary_response(frame: Vec<u8>) -> Response {
    ([(CONTENT_TYPE, DOCUMENT_CONTENT_TYPE)], frame).into_response()
}

fn json_document_read_error(error: CoreError) -> Response {
    Json(OwnedDocumentReadResponse(ResponseEnvelope::Error(
        record_core_error(error),
    )))
    .into_response()
}

fn json_document_apply_error(error: CoreError) -> Response {
    Json(OwnedDocumentApplyResponse(ResponseEnvelope::Error(
        record_core_error(error),
    )))
    .into_response()
}

fn require_wire_version(version: u32) -> Result<(), CoreError> {
    if version == 3 {
        return Ok(());
    }
    Err(invalid("Document binary frame version is unsupported"))
}

fn require_same_identity(expected: &str, actual: &str, label: &str) -> Result<(), CoreError> {
    if expected == actual {
        return Ok(());
    }
    Err(CoreError {
        code: CoreErrorCode::Unauthorized,
        message: format!("Document binary {label} does not match its bound header"),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    })
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn stale_document_store_epoch(current_store_epoch: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::StaleStoreEpoch,
        message: "Canvas sync belongs to a different store epoch".to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::CurrentStoreEpoch {
            store_epoch: StoreEpoch(current_store_epoch.to_owned()),
        },
    }
}

fn stale_document_generation(generation: i64, head_seq: i64) -> CoreError {
    CoreError {
        code: CoreErrorCode::GenerationConflict,
        message: "Canvas sync belongs to a different Document generation".to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::CurrentDocumentHead {
            generation,
            head_seq,
        },
    }
}

fn canvas_scene_corrupt(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::StoreCorrupt,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn unauthorized(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn record_core_error(error: CoreError) -> CoreError {
    let code = match &error.code {
        CoreErrorCode::InvalidInput => "invalid_input",
        CoreErrorCode::Unauthorized => "unauthorized",
        CoreErrorCode::NotFound => "not_found",
        CoreErrorCode::Ambiguous => "ambiguous",
        CoreErrorCode::Conflict => "conflict",
        CoreErrorCode::StaleStoreEpoch => "stale_store_epoch",
        CoreErrorCode::RevisionConflict => "revision_conflict",
        CoreErrorCode::GenerationConflict => "generation_conflict",
        CoreErrorCode::HeadConflict => "head_conflict",
        CoreErrorCode::PatchNotFound => "patch_not_found",
        CoreErrorCode::PatchAmbiguous => "patch_ambiguous",
        CoreErrorCode::PatchOverlap => "patch_overlap",
        CoreErrorCode::IdempotencyKeyReused => "idempotency_key_reused",
        CoreErrorCode::IdempotencyWindowExpired => "idempotency_window_expired",
        CoreErrorCode::LegacyIdempotencyUnavailable => "legacy_idempotency_unavailable",
        CoreErrorCode::ProtectedOwnerDeletion => "protected_owner_deletion",
        CoreErrorCode::DocumentUpdateMissingDependencies => "document_update_missing_dependencies",
        CoreErrorCode::InvalidDocumentSchema => "invalid_document_schema",
        CoreErrorCode::MaterializationStale => "materialization_stale",
        CoreErrorCode::MaintenanceInProgress => "maintenance_in_progress",
        CoreErrorCode::SchemaUnsupported => "schema_unsupported",
        CoreErrorCode::StoreCorrupt => "store_corrupt",
        CoreErrorCode::ProtocolIncompatible => "protocol_incompatible",
        CoreErrorCode::EventReplayUnavailable => "event_replay_unavailable",
        CoreErrorCode::ResourceExhausted => "resource_exhausted",
        CoreErrorCode::DeadlineExceeded => "deadline_exceeded",
        CoreErrorCode::Cancelled => "cancelled",
        CoreErrorCode::Overloaded => "overloaded",
        CoreErrorCode::CoreUnavailable => "core_unavailable",
    };
    match &error.code {
        CoreErrorCode::StoreCorrupt | CoreErrorCode::CoreUnavailable => {
            tracing::error!(
                errorCode = code,
                retryable = error.retryable,
                "Core operation failed"
            );
        }
        CoreErrorCode::MaintenanceInProgress
        | CoreErrorCode::EventReplayUnavailable
        | CoreErrorCode::ResourceExhausted
        | CoreErrorCode::DeadlineExceeded
        | CoreErrorCode::Overloaded => {
            tracing::warn!(
                errorCode = code,
                retryable = error.retryable,
                "Core operation failed"
            );
        }
        _ => {
            tracing::debug!(
                errorCode = code,
                retryable = error.retryable,
                "Core operation failed"
            );
        }
    }
    error
}

fn response_envelope<T>(result: Result<T, CoreError>) -> ResponseEnvelope<T> {
    match result {
        Ok(value) => ResponseEnvelope::Ok(value),
        Err(error) => ResponseEnvelope::Error(record_core_error(error)),
    }
}

struct DocumentSubscriptionGuard {
    lease_id: u64,
    adapter: OwnedDocumentRealtimeAdapter,
    connection_id: String,
    client_session_id: String,
    live_hub: DocumentLiveHub,
}

impl Drop for DocumentSubscriptionGuard {
    fn drop(&mut self) {
        let Ok(publication) =
            self.adapter
                .release_lease(&self.connection_id, &self.client_session_id, self.lease_id)
        else {
            return;
        };
        if let Some(publication) = publication {
            self.live_hub.publish_awareness(publication);
        }
    }
}

fn document_context(
    state: &ServerState,
    headers: &HeaderMap,
    bound: &BoundConnection,
) -> Result<BoundModuleContext, CoreError> {
    let project_id = optional_header(headers, PROJECT_HEADER, "Project")?;
    let document_scope = optional_header(headers, DOCUMENT_SCOPE_HEADER, "Document scope")?;
    let project_id = match (project_id, document_scope.as_deref()) {
        (Some(project_id), None) => Some(ProjectId(project_id)),
        (None, Some(LIBRARY_DOCUMENT_SCOPE))
            if matches!(
                bound.adapter,
                AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
            ) =>
        {
            None
        }
        (None, Some(LIBRARY_DOCUMENT_SCOPE)) => {
            return Err(unauthorized(
                "Library Document scope requires a trusted local Adapter",
            ));
        }
        (Some(_), Some(_)) => {
            return Err(unauthorized(
                "Document access cannot bind both Project and Library scope",
            ));
        }
        (None, Some(_)) => return Err(unauthorized("Document scope is unsupported")),
        (None, None) => return Err(unauthorized("Document scope binding is required")),
    };
    Ok(BoundModuleContext {
        profile_id: ProfileId(state.profile_id.clone()),
        library_id: LibraryId(state.library_id.clone()),
        project_id,
        connection_id: bound.id.clone(),
        adapter: bound.adapter.clone(),
        editor_history_owner: editor_history_owner(headers, bound)?,
    })
}

fn connection_binding(
    state: &ServerState,
    connection_id: &str,
    adapter: &AdapterKind,
    peer: &PeerIdentity,
    build_id: &str,
) -> String {
    let adapter = match adapter {
        AdapterKind::ElectronHost => "electron_host",
        AdapterKind::NativeCli => "native_cli",
        AdapterKind::Test => "test",
        AdapterKind::LoopbackHttp => "loopback_http",
        AdapterKind::Agent => "agent",
    };
    let mut digest = Sha256::new();
    digest.update(state.auth_header.as_bytes());
    digest.update(b"\0connection-binding-v2\0");
    digest.update(descriptor_snapshot(state).start_nonce.as_bytes());
    digest.update(b"\0");
    digest.update(connection_id.as_bytes());
    digest.update(b"\0");
    digest.update(adapter.as_bytes());
    digest.update(b"\0");
    digest.update(peer.uid.unwrap_or_default().to_be_bytes());
    digest.update(peer.gid.unwrap_or_default().to_be_bytes());
    digest.update(peer.pid.unwrap_or_default().to_be_bytes());
    digest.update(b"\0");
    digest.update(build_id.as_bytes());
    hex::encode(digest.finalize())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn required_header(
    headers: &HeaderMap,
    name: &'static str,
    label: &str,
) -> Result<String, CoreError> {
    optional_header(headers, name, label)?.ok_or_else(|| CoreError {
        code: CoreErrorCode::Unauthorized,
        message: format!("{label} binding is required"),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    })
}

fn optional_header(
    headers: &HeaderMap,
    name: &'static str,
    label: &str,
) -> Result<Option<String>, CoreError> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| CoreError {
        code: CoreErrorCode::Unauthorized,
        message: format!("{label} binding is not valid UTF-8"),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    })?;
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: format!("{label} binding is invalid"),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        });
    }
    Ok(Some(value.to_owned()))
}

fn valid_binding(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.trim() == value
}

fn api_core_error(error: CoreError) -> ApiError {
    let status = match error.code {
        CoreErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        CoreErrorCode::NotFound => StatusCode::NOT_FOUND,
        CoreErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
        CoreErrorCode::ResourceExhausted | CoreErrorCode::Overloaded => {
            StatusCode::TOO_MANY_REQUESTS
        }
        CoreErrorCode::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
        CoreErrorCode::Cancelled => StatusCode::from_u16(499).expect("499 is a valid status"),
        _ => StatusCode::CONFLICT,
    };
    ApiError::new(status, error.message)
}

fn connection_registry_error(error: ConnectionRegistryError) -> ApiError {
    let status = match error.kind {
        ConnectionRegistryErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
        ConnectionRegistryErrorKind::Conflict => StatusCode::CONFLICT,
        ConnectionRegistryErrorKind::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
        ConnectionRegistryErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
    };
    ApiError::new(status, error.message)
}

fn realtime_event_document_id(event: &DocumentRealtimeEvent) -> &str {
    match event {
        DocumentRealtimeEvent::Awareness { document_id, .. } => document_id,
    }
}

fn publish_document_transport(state: &ServerState, publication: AwarenessPublication) {
    state.document_live.publish_awareness(publication);
}

fn record_operation(module: &str, operation_id: &str) {
    let operation_id = log_identity(operation_id);
    let receipt_key = format!("{module}:{operation_id}");
    let span = tracing::Span::current();
    span.record("operationId", operation_id.as_str());
    span.record("receiptKey", receipt_key.as_str());
}

fn log_identity(identity: &str) -> String {
    let digest = Sha256::digest(identity.as_bytes());
    format!("sha256:{}", &hex::encode(digest)[..32])
}

fn record_apply_response<T, R>(response: &ApplyResponse<T, R>, duplicate: bool) {
    match response {
        ApplyResponse::Committed { commit, .. } => tracing::debug!(
            commitSequence = commit.commit_seq,
            duplicate,
            status = "committed",
            "Core mutation receipt resolved"
        ),
        ApplyResponse::NoOp { observed, .. } => tracing::debug!(
            observedCommitHead = observed.commit_head,
            duplicate,
            status = "no_op",
            "Core mutation receipt resolved"
        ),
    }
}

fn publish_local_commit(state: &ServerState, commit_seq: i64, store_epoch: String) {
    let started_at = Instant::now();
    tracing::debug!(
        commitSequence = commit_seq,
        "Core commit scanner wake published"
    );
    let _ = state.event_sender.send(CommitWake);
    state
        .document_live_publisher
        .publish(commit_seq, store_epoch);
    state
        .metrics
        .record_local_commit_publication(started_at.elapsed());
}

fn sse_event(envelope: &EventEnvelope) -> Event {
    Event::default()
        .event("module")
        .id(envelope.packet.manifest.identity.commit_seq.to_string())
        .data(serde_json::to_string(envelope).expect("event envelope serializes"))
}

fn sse_stream_checkpoint(checkpoint: &StreamCheckpoint) -> Event {
    Event::default()
        .event("stream-checkpoint")
        .id(checkpoint.scanned_through_seq.to_string())
        .data(serde_json::to_string(checkpoint).expect("stream checkpoint serializes"))
}

fn sse_document_live_barrier(barrier: &DocumentLiveBarrier) -> Event {
    Event::default()
        .event("document-live-opened")
        .data(serde_json::to_string(barrier).expect("Document live barrier serializes"))
}

fn sse_projection_live_barrier(barrier: &ProjectionLiveBarrier) -> Event {
    Event::default()
        .event("projection-live-opened")
        .id(barrier.commit_head.to_string())
        .data(serde_json::to_string(barrier).expect("Projection live barrier serializes"))
}

fn sse_projection_live_repair(repair: &ProjectionLiveRepair) -> Event {
    Event::default()
        .event("projection-live-repair")
        .id(repair.commit_head.to_string())
        .data(serde_json::to_string(repair).expect("Projection live repair serializes"))
}

fn sse_document_live_repair(repair: &DocumentLiveRepair) -> Event {
    Event::default()
        .event("document-live-repair")
        .data(serde_json::to_string(repair).expect("Document live repair serializes"))
}

fn sse_document_live_repair_at(
    barrier: &DocumentLiveBarrier,
    store_epoch: StoreEpoch,
    commit_head: i64,
    reason: DocumentLiveRepairReason,
) -> Event {
    sse_document_live_repair(&DocumentLiveRepair {
        document_id: barrier.document_id.clone(),
        store_epoch,
        document_generation: barrier.document_generation,
        head_seq: barrier.head_seq,
        commit_head,
        reason,
    })
}

fn sse_core_resync(resync: &EventReplayRequired) -> Event {
    Event::default()
        .event("core-resync-required")
        .data(serde_json::to_string(resync).expect("Core resync event serializes"))
}

fn sse_document_realtime_event(event: &DocumentRealtimeEvent) -> Event {
    Event::default()
        .event("document-realtime")
        .data(document_wire::encode_realtime_event(event).expect("Document event serializes"))
}

fn profile_id(home: &Path) -> String {
    let digest = Sha256::digest(home.as_os_str().as_encoded_bytes());
    format!("profile-{}", hex::encode(&digest[..16]))
}

fn ensure_store_epoch(
    store: &SqliteStoreKernel,
    proposed_epoch: String,
) -> Result<String, nodex_core::infrastructure::sqlite::StoreError> {
    store.writer().call(move |connection| {
        with_immediate_transaction(connection, |transaction| {
            transaction.execute(
                "INSERT OR IGNORE INTO block_store_metadata(\
                   id, store_epoch, created_at, updated_at\
                 ) VALUES (1, ?1, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [&proposed_epoch],
            )?;
            transaction
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
        })
    })
}

struct LocalIdentity {
    profile_id: String,
    library_id: String,
}

fn ensure_local_identity(
    store: &SqliteStoreKernel,
    proposed_profile_id: String,
) -> Result<LocalIdentity, nodex_core::infrastructure::sqlite::StoreError> {
    store.writer().call(move |connection| {
        with_immediate_transaction(connection, |transaction| {
            let (profile_count, library_count) = transaction.query_row(
                "SELECT (SELECT COUNT(*) FROM profiles), \
                        (SELECT COUNT(*) FROM libraries)",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            if profile_count != library_count || profile_count > 1 {
                return Err(nodex_core::infrastructure::sqlite::StoreError::new(
                    nodex_core::infrastructure::sqlite::StoreErrorCode::StoreCorrupt,
                    "A Profile store must contain exactly one Profile/Library identity pair",
                    false,
                ));
            }
            if profile_count == 1 {
                let (profile_id, library_id) = transaction.query_row(
                    "SELECT profile.id, library.id FROM profiles profile \
                     JOIN libraries library ON library.profile_id = profile.id",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                return Ok(LocalIdentity {
                    profile_id,
                    library_id,
                });
            }
            let library_id = proposed_profile_id.replacen("profile-", "library-", 1);
            transaction.execute(
                "INSERT INTO profiles(id, created_at, updated_at) VALUES (?1, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [&proposed_profile_id],
            )?;
            transaction.execute(
                "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                 VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [&library_id, &proposed_profile_id],
            )?;
            Ok(LocalIdentity {
                profile_id: proposed_profile_id,
                library_id,
            })
        })
    })
}

pub async fn run(home: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    run_with_selection(
        home,
        CoreSelectionPolicy::Compatible,
        LauncherKind::NativeCli,
    )
    .await
}

pub async fn run_with_selection(
    home: PathBuf,
    selection_policy: CoreSelectionPolicy,
    launcher: LauncherKind,
) -> Result<(), Box<dyn std::error::Error>> {
    let idle_timeout = configured_idle_timeout()?;
    let manifest = core_compatibility_manifest();
    let manifest_digest = canonical_manifest_digest(&manifest)
        .map_err(|mismatch| io::Error::other(format!("invalid Core manifest: {mismatch:?}")))?;
    let artifact_started_at = Instant::now();
    let artifact = current_artifact_identity()?;
    report_internal_startup_event(CoreStartupEvent::CandidateChecked {
        artifact_hash_ms: duration_millis(artifact_started_at.elapsed()),
    });
    let candidate = CandidateRuntime {
        manifest: manifest.clone(),
        manifest_digest: manifest_digest.clone(),
        artifact: artifact.clone(),
        requirements: core_client_requirements(),
        policy: selection_policy,
        launcher,
    };
    let paths = RuntimePaths::prepare(&home)?;
    let owner_uid = paths.owner_uid()?;
    let lock = paths.open_lock()?;
    let mut selection_reason = CoreSelectionReason::StartedNoIncumbent;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            match paths.wait_for_running_core(&lock, &candidate)? {
                ExistingCore::LockAcquired => {}
                ExistingCore::Reuse(descriptor, reason) => {
                    println!(
                        "{}",
                        serde_json::to_string(&CoreSelectionResult {
                            selection_version: 1,
                            disposition: CoreSelectionDisposition::Reused,
                            reason,
                            descriptor: *descriptor,
                        })?
                    );
                    return Ok(());
                }
                ExistingCore::HandoffAccepted(descriptor, reason) => {
                    selection_reason = reason;
                    match paths.wait_for_handoff_completion(&lock, &descriptor, &candidate)? {
                        ExistingCore::LockAcquired => {}
                        ExistingCore::Reuse(descriptor, reason) => {
                            println!(
                                "{}",
                                serde_json::to_string(&CoreSelectionResult {
                                    selection_version: 1,
                                    disposition: CoreSelectionDisposition::Reused,
                                    reason,
                                    descriptor: *descriptor,
                                })?
                            );
                            return Ok(());
                        }
                        ExistingCore::HandoffAccepted(_, _) => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "replacement Core published another incompatible generation",
                            )
                            .into());
                        }
                    }
                }
            }
        }
        Err(error) => return Err(error.into()),
    }

    paths.remove_stale_socket()?;
    let (logging_guard, logging_handle) = logging::install(&home);
    tracing::info!(
        subsystem = "lifecycle",
        transportMin = TRANSPORT_PROTOCOL_MIN,
        transportMax = TRANSPORT_PROTOCOL_MAX,
        "Core startup began"
    );

    let auth = random_hex(32)?;
    let start_nonce = random_hex(16)?;
    let proposed_profile_id = profile_id(&home);
    let store_started_at = Instant::now();
    let migration_heartbeat = MigrationHeartbeat::start();
    let store = SqliteStoreKernel::open_with_observer(&home, |event| match event {
        StorePreparationEvent::MigrationStarted {
            from_version,
            to_version,
        } => {
            migration_heartbeat.activate();
            report_internal_startup_event(CoreStartupEvent::MigrationStarted {
                from_version,
                to_version,
            });
        }
        StorePreparationEvent::MigrationProgress { completed, total } => {
            report_internal_startup_event(CoreStartupEvent::MigrationProgress { completed, total });
        }
    })?;
    drop(migration_heartbeat);
    report_internal_startup_event(CoreStartupEvent::StoreReady {
        created_fresh: store.preparation().created_fresh,
        migrated_from_version: store.preparation().migrated_from_version,
        store_open_ms: duration_millis(store_started_at.elapsed()),
    });
    let schema_version = u32::try_from(store.preparation().schema_version)?;
    let actual_store_format = store_format(schema_version).ok_or_else(|| {
        io::Error::other(format!(
            "Core Store format v{schema_version} is not declared"
        ))
    })?;
    if actual_store_format != manifest.store.current {
        return Err(io::Error::other("Core opened a non-current Store format").into());
    }
    let store_epoch = ensure_store_epoch(&store, random_hex(16)?)?;
    let identity = ensure_local_identity(&store, proposed_profile_id)?;
    let workspace = ProjectWorkspaceModule::new(&identity.profile_id, &identity.library_id, &store)
        .map_err(|error| io::Error::other(error.message))?;
    paths.atomic_write_private(&paths.auth, format!("{auth}\n").as_bytes())?;
    let listener = UnixListener::bind(&paths.socket)?;
    fs::set_permissions(&paths.socket, fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
    let descriptor = RuntimeDescriptor {
        manifest,
        manifest_digest,
        artifact,
        actual_store_format,
        pid: std::process::id(),
        start_nonce: start_nonce.clone(),
        socket_path: paths.socket.to_string_lossy().into_owned(),
        profile_id: identity.profile_id.clone(),
        store_epoch: store_epoch.clone(),
        readiness_generation: 1,
    };
    paths.atomic_write_private(
        &paths.descriptor,
        format!("{}\n", serde_json::to_string(&descriptor)?).as_bytes(),
    )?;
    let lifecycle_summary = LifecycleSummaryWriter::start(paths.clone(), &descriptor);
    println!(
        "{}",
        serde_json::to_string(&CoreSelectionResult {
            selection_version: 1,
            disposition: CoreSelectionDisposition::Started,
            reason: selection_reason,
            descriptor: descriptor.clone(),
        })?
    );
    tracing::info!(
        subsystem = "lifecycle",
        readinessGeneration = descriptor.readiness_generation,
        "Core is ready"
    );

    let descriptor = Arc::new(Mutex::new(descriptor));
    let event_log = CoreEventLog::new(store.readers());
    let commit_wake_scanner = CommitWakeScanner::new(event_log.clone(), COMMIT_WAKE_SCAN_LIMIT);
    let (event_sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
    let document_live = DocumentLiveHub::new(store_epoch.clone(), EVENT_CHANNEL_CAPACITY);
    let document_live_publisher =
        DocumentLivePublisher::start(event_log.clone(), document_live.clone());
    let library = LibraryModule::new(&identity.profile_id, &identity.library_id, &store);
    let replacement_library_operations = library.prepared_agent_operation_registry();
    let replacement_search_snapshots = library.search_snapshot_lease_registry();
    let database = DatabaseModule::new(&identity.profile_id, &identity.library_id, &store);
    let automation = AutomationModule::new(&identity.profile_id, &identity.library_id, &store);
    let document = OwnedDocumentModule::new(
        identity.profile_id.clone(),
        identity.library_id.clone(),
        &store,
    );
    let document_realtime = OwnedDocumentRealtimeAdapter::new(document.clone());
    let replacement_document = document.clone();
    let replacement_realtime = document_realtime.clone();
    let replacement_document_live = document_live.clone();
    let replacement_event_sender = event_sender.clone();
    let replacement_descriptor = Arc::clone(&descriptor);
    let replacement_paths = paths.clone();
    let replacement_lifecycle_summary = lifecycle_summary.clone();
    let administration =
        StoreAdministrationModule::new(&identity.profile_id, &identity.library_id, &store)
            .with_store_replacement_hook(move |store_epoch| {
                replacement_library_operations.invalidate_all()?;
                if let Some(search_snapshots) = &replacement_search_snapshots {
                    search_snapshots.invalidate_all()?;
                }
                replacement_document
                    .reset_for_store_replacement()
                    .map_err(store_replacement_hook_error)?;
                replacement_realtime
                    .reset_for_store_replacement()
                    .map_err(store_replacement_hook_error)?;
                let mut descriptor = replacement_descriptor.lock().map_err(|_| {
                    StoreError::new(
                        StoreErrorCode::Internal,
                        "Core runtime descriptor lock failed during Store replacement",
                        false,
                    )
                })?;
                let mut next = descriptor.clone();
                next.store_epoch = store_epoch.to_owned();
                next.readiness_generation =
                    next.readiness_generation.checked_add(1).ok_or_else(|| {
                        StoreError::new(
                            StoreErrorCode::Internal,
                            "Core readiness generation overflowed during Store replacement",
                            false,
                        )
                    })?;
                let bytes = format!(
                    "{}\n",
                    serde_json::to_string(&next).map_err(|error| {
                        StoreError::new(
                            StoreErrorCode::Internal,
                            format!("Core runtime descriptor could not be encoded: {error}"),
                            false,
                        )
                    })?
                );
                replacement_paths
                    .atomic_write_private(&replacement_paths.descriptor, bytes.as_bytes())
                    .map_err(|error| {
                        StoreError::new(
                            StoreErrorCode::Internal,
                            format!("Core runtime descriptor could not be replaced: {error}"),
                            false,
                        )
                    })?;
                replacement_lifecycle_summary.replace_generation(&next);
                *descriptor = next;
                drop(descriptor);
                replacement_document_live.publish_repair(
                    store_epoch,
                    0,
                    DocumentLiveRepairKind::IdentityChanged,
                );
                let _ = replacement_event_sender.send(CommitWake);
                Ok(())
            });
    let drain_lifecycle_summary = lifecycle_summary.clone();
    let lifecycle = LifecycleCoordinator::with_drain_observer(move |reason| {
        drain_lifecycle_summary.mark_draining(reason);
    });
    let state = Arc::new(ServerState {
        auth_header: format!("Bearer {auth}"),
        owner_uid,
        connections: ConnectionRegistry::new(),
        lifecycle: lifecycle.clone(),
        profile_id: identity.profile_id,
        library_id: identity.library_id,
        library,
        database,
        workspace,
        automation,
        administration,
        document_realtime,
        document,
        store,
        schema_version,
        descriptor,
        event_log,
        commit_wake_scanner,
        event_sender,
        document_live,
        document_live_publisher,
        metrics: ServerMetrics::default(),
        request_executor: RequestExecutor::new(),
        logging: logging_handle,
    });
    let idle_task = idle_timeout.map(|timeout| {
        let idle_state = Arc::clone(&state);
        let idle_lifecycle = lifecycle.clone();
        tokio::spawn(monitor_idle(idle_lifecycle, timeout, move || {
            server_is_idle(&idle_state)
        }))
    });
    let history_state = Arc::clone(&state);
    let history_cleanup = tokio::spawn(async move {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            request_execution::REQUEST_ID_HEADER,
            "history-cleanup".parse().expect("static request identity"),
        );
        loop {
            let state = Arc::clone(&history_state);
            let result = history_state
                .request_executor
                .execute(
                    "history-maintenance",
                    &headers,
                    RequestClass::Maintenance,
                    move || {
                        state.library.maintain_editor_history_owners(|pid| {
                            connections::peer_process_is_alive(Some(pid))
                        })
                    },
                )
                .await;
            if let Err(error) = &result {
                tracing::warn!(subsystem = "editor_history", error = ?error, "History lifetime cleanup will retry");
            }
            // Commit one slice, then yield before asking for writer admission again.
            let delay = if matches!(result, Ok(true)) {
                Duration::from_millis(25)
            } else {
                Duration::from_secs(30)
            };
            tokio::time::sleep(delay).await;
        }
    });
    let order_state = Arc::clone(&state);
    let order_maintenance = tokio::spawn(async move {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            request_execution::REQUEST_ID_HEADER,
            "view-order-preparation"
                .parse()
                .expect("static request identity"),
        );
        loop {
            let state = Arc::clone(&order_state);
            let result = order_state
                .request_executor
                .execute(
                    "view-order-maintenance",
                    &headers,
                    RequestClass::Maintenance,
                    move || state.database.maintain_view_orders(),
                )
                .await;
            if let Err(error) = &result {
                tracing::warn!(subsystem = "database_order", error = ?error, "View order preparation will retry");
            }
            let delay = if matches!(result, Ok(true)) {
                Duration::from_millis(25)
            } else {
                Duration::from_secs(30)
            };
            tokio::time::sleep(delay).await;
        }
    });
    let result = axum::serve(
        listener,
        router(Arc::clone(&state)).into_make_service_with_connect_info::<PeerIdentity>(),
    )
    .with_graceful_shutdown(shutdown_signal(lifecycle))
    .await;
    if let Some(idle_task) = idle_task {
        idle_task.abort();
        let _ = idle_task.await;
    }
    state
        .request_executor
        .cancel("history-maintenance", "history-cleanup");
    history_cleanup.abort();
    let _ = history_cleanup.await;
    state
        .request_executor
        .cancel("view-order-maintenance", "view-order-preparation");
    order_maintenance.abort();
    let _ = order_maintenance.await;
    match &result {
        Ok(()) => tracing::info!(subsystem = "lifecycle", "Core server stopped"),
        Err(_) => tracing::error!(subsystem = "lifecycle", "Core server stopped with an error"),
    }
    if result.is_ok() {
        match state.store.clean_shutdown_validation_receipt() {
            Ok(receipt) => {
                if let Err(error) = persist_clean_shutdown_validation_receipt(&home, &receipt) {
                    tracing::warn!(
                        error = %error,
                        "Core could not publish clean Store validation evidence; next startup will fully validate"
                    );
                } else {
                    tracing::info!("Core published clean Store validation evidence");
                }
            }
            Err(error) => tracing::warn!(
                error = %error,
                "Core could not read clean Store validation evidence; next startup will fully validate"
            ),
        }
    }
    // Keep the runtime ownership fence held until the Store has released its
    // independent writer lock. A replacement Core may start as soon as
    // `core.lock` is released, so dropping these in the opposite order creates
    // a window where it owns the runtime but cannot open the Profile Store.
    drop(state);
    lifecycle_summary.mark_stopped(result.is_ok());
    logging_guard.shutdown();
    paths.cleanup(&start_nonce);
    drop(lock);
    result.map_err(Into::into)
}

fn server_is_idle(state: &ServerState) -> bool {
    if state.lifecycle.is_draining() {
        return false;
    }
    let Ok(connections) = state.connections.activity() else {
        return false;
    };
    if connections.clients != 0 || connections.event_subscriptions != 0 {
        return false;
    }
    let Ok(realtime) = state.document_realtime.activity() else {
        return false;
    };
    if realtime.subscriptions != 0 || realtime.awareness_clients != 0 {
        return false;
    }
    let Ok(prepared_operations) =
        state
            .document
            .prepared_agent_operation_count()
            .and_then(|document| {
                state
                    .library
                    .prepared_agent_operation_count()
                    .map(|library| document.saturating_add(library))
            })
    else {
        return false;
    };
    if prepared_operations != 0 {
        return false;
    }
    let store = state.store.activity();
    if store.phase != StoreRuntimePhase::Running
        || store.active_writes != 0
        || store.active_reads != 0
        || store.queued_writes != 0
    {
        return false;
    }
    let Ok(now_ms) = unix_time_millis() else {
        return false;
    };
    state
        .automation
        .has_due_background_work(now_ms)
        .is_ok_and(|due| !due)
}

async fn shutdown_signal(lifecycle: LifecycleCoordinator) {
    tokio::select! {
        () = lifecycle.wait_for_drain() => {}
        () = operating_system_shutdown_signal() => {
            if lifecycle.begin_drain(DrainReason::OperatingSystemSignal) {
                tracing::info!(reason = "operating_system_signal", "Core drain began");
            }
        }
    }
}

async fn operating_system_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        signal.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

fn unix_time_millis() -> Result<i64, std::time::SystemTimeError> {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    Ok(i64::try_from(millis).unwrap_or(i64::MAX))
}

fn store_replacement_hook_error(error: CoreError) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, error.message, error.retryable)
}
