//! The network adapter never inherits a local peer, bearer or Host capability.
use super::*;
use futures_core::Stream;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use nodex_core_contracts::{RemotePrincipal, team::*};
use nodex_platform::private_fs;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::{TlsAcceptor, rustls};

#[derive(Clone)]
pub(crate) struct RemotePeer(pub SocketAddr, Arc<Mutex<Option<RemotePrincipal>>>);
#[derive(Clone)]
pub(crate) struct IncomingBytes(u64);
#[derive(Default)]
struct Window {
    started: Option<Instant>,
    requests: u64,
    bytes: u64,
    peak_requests: u64,
    peak_bytes: u64,
    refusals: u64,
}
impl Window {
    fn reset(&mut self) {
        if self
            .started
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(60))
        {
            self.started = Some(Instant::now());
            self.requests = 0;
            self.bytes = 0;
        }
    }
    fn charge(&mut self, requests: u64, bytes: u64, max_requests: u64, max_bytes: u64) -> bool {
        self.reset();
        if self.requests + requests > max_requests || self.bytes + bytes > max_bytes {
            self.refusals += 1;
            return false;
        }
        self.requests += requests;
        self.bytes += bytes;
        self.peak_requests = self.peak_requests.max(self.requests);
        self.peak_bytes = self.peak_bytes.max(self.bytes);
        true
    }
    fn snapshot(&self) -> RemoteBudgetCounter {
        RemoteBudgetCounter {
            requests: self.requests,
            bytes: self.bytes,
            peak_requests: self.peak_requests,
            peak_bytes: self.peak_bytes,
            refusals: self.refusals,
        }
    }
}
// A Desktop opening a Space loads its Board, a Page and a hosted chat together: measured
// two-Desktop runs reach 530-600 requests in that first minute, while steady editing stays under
// 100. The Device window admits two such openings; a Member's covers a Desktop and a phone.
pub const DEVICE_REQUESTS_PER_MINUTE: u64 = 1_200;
pub const MEMBER_REQUESTS_PER_MINUTE: u64 = 2_400;

#[derive(Default)]
struct Budgets {
    ips: HashMap<IpAddr, Window>,
    routes: std::collections::BTreeMap<String, u64>,
    members: HashMap<String, Window>,
    devices: HashMap<String, Window>,
    queues: HashMap<String, Arc<Semaphore>>,
    streams: HashMap<String, Arc<Semaphore>>,
    member_streams: HashMap<String, Arc<Semaphore>>,
}
pub(crate) struct RemoteState {
    pub(crate) info: Mutex<Option<ListenerInfo>>,
    budgets: Mutex<Budgets>,
    admitted: Arc<Semaphore>,
    refusals: Mutex<std::collections::BTreeMap<String, u64>>,
}
impl Default for RemoteState {
    fn default() -> Self {
        Self {
            info: Mutex::new(None),
            budgets: Mutex::new(Budgets::default()),
            admitted: Arc::new(Semaphore::new(8)),
            refusals: Mutex::new(Default::default()),
        }
    }
}
impl RemoteState {
    fn limited(&self, budget: RemoteBudget, milliseconds: u64) -> ApiError {
        if let Ok(mut refusals) = self.refusals.lock() {
            *refusals.entry(format!("{budget:?}")).or_default() += 1;
        }
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            format!("Remote admission refused: {budget:?}"),
        )
        .with_recovery(nodex_core_contracts::CoreErrorRecovery::RetryAfter {
            budget,
            milliseconds,
        })
    }
    fn preauth(&self, ip: IpAddr) -> bool {
        let Ok(mut b) = self.budgets.lock() else {
            return false;
        };
        b.ips.retain(|_, w| {
            w.started
                .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
        });
        if b.ips.len() >= 4096 && !b.ips.contains_key(&ip) {
            return false;
        }
        b.ips.entry(ip).or_default().charge(1, 0, 240, 0)
    }
        self.charge_device(&p.member_id, &p.device_id, requests, bytes)
    }
    fn charge_device(
        &self,
        member: &str,
        device: &str,
        requests: u64,
        bytes: u64,
    ) -> Result<(), ApiError> {
        let mut b = self.budgets.lock().map_err(|_| remote_unavailable())?;
        let member_window = b.members.entry(member.to_owned()).or_default();
        member_window.reset();
        let device_window = b.devices.entry(device.to_owned()).or_default();
        device_window.reset();
        for (
            used_requests,
            used_bytes,
            started,
            max_requests,
            max_bytes,
            request_budget,
            byte_budget,
        ) in [
            {
                let w = b.members.get(member).unwrap();
                (
                    w.requests,
                    w.bytes,
                    w.started.unwrap(),
                    MEMBER_REQUESTS_PER_MINUTE,
                    64 * 1024 * 1024,
                    RemoteBudget::MemberRequests,
                    RemoteBudget::MemberBytes,
                )
            },
            {
                let w = b.devices.get(device).unwrap();
                (
                    w.requests,
                    w.bytes,
                    w.started.unwrap(),
                    DEVICE_REQUESTS_PER_MINUTE,
                    32 * 1024 * 1024,
                    RemoteBudget::DeviceRequests,
                    RemoteBudget::DeviceBytes,
                )
            },
        ] {
            let budget = if used_requests + requests > max_requests {
                Some(request_budget)
            } else if used_bytes + bytes > max_bytes {
                Some(byte_budget)
            } else {
                None
            };
            if let Some(budget) = budget {
                let retry = Duration::from_secs(60)
                    .saturating_sub(started.elapsed())
                    .as_millis() as u64;
                if matches!(
                    budget,
                    RemoteBudget::MemberRequests | RemoteBudget::MemberBytes
                ) {
                    b.members.get_mut(member).unwrap().refusals += 1;
                } else {
                    b.devices.get_mut(device).unwrap().refusals += 1;
                }
                return Err(self.limited(budget, retry.max(1)));
            }
        }
        b.members.get_mut(member).unwrap().charge(
            requests,
            bytes,
            MEMBER_REQUESTS_PER_MINUTE,
            64 * 1024 * 1024,
        );
        b.devices.get_mut(device).unwrap().charge(
            requests,
            bytes,
            DEVICE_REQUESTS_PER_MINUTE,
            32 * 1024 * 1024,
        );
        Ok(())
    }
    async fn admit(&self, p: &RemotePrincipal) -> Result<OwnedSemaphorePermit, ApiError> {
        let queue = {
            let mut b = self.budgets.lock().map_err(|_| remote_unavailable())?;
            b.queues
                .entry(p.member_id.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(2)))
                .clone()
        };
        // FIFO per Member, before entering the shared execution classes. Bounded wait
        // prevents one person's queued work from borrowing all global admission slots.
        tokio::time::timeout(Duration::from_secs(2), queue.acquire_owned())
            .await
            .map_err(|_| self.limited(RemoteBudget::MemberConcurrency, 1_000))?
            .map_err(|_| self.limited(RemoteBudget::MemberConcurrency, 1_000))
    }
        &self,
        p: &RemotePrincipal,
    ) -> Result<(OwnedSemaphorePermit, OwnedSemaphorePermit), ApiError> {
        let mut b = self.budgets.lock().map_err(|_| remote_unavailable())?;
        let member = b
            .member_streams
            .entry(p.member_id.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(16)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| self.limited(RemoteBudget::MemberStreams, 1_000))?;
        let device = b
            .streams
            .entry(p.device_id.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(8)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| self.limited(RemoteBudget::DeviceStreams, 1_000))?;
        Ok((member, device))
    }
}
/// Every network route is deliberate; adding a local Host capability never
/// makes it remotely reachable just because it shares the HTTP router.
fn admitted_route(path: &str) -> bool {
    matches!(
        path,
            | "/core/v1/admin/space/member-name"
            | "/core/v1/remote-info"
            | "/core/v1/events"
            | "/core/v1/requests/cancel"
            | "/core/v1/projections/live"
            | "/core/v1/local-mutations/resolve"
            | "/core/v1/modules/library/read"
            | "/core/v1/modules/library/apply"
            | "/core/v1/modules/database/read"
            | "/core/v1/modules/database/apply"
            | "/core/v1/modules/query/read"
            | "/core/v1/modules/workspace/read"
            | "/core/v1/modules/workspace/apply"
            | "/core/v1/modules/automation/read"
            | "/core/v1/modules/automation/apply"
            | "/core/v1/modules/administration/read"
            | "/core/v1/modules/administration/apply"
            | "/core/v1/modules/document/recovery/capture"
            | "/core/v1/modules/document/recovery/export"
            | "/core/v1/modules/document/read"
            | "/core/v1/modules/document/apply"
            | "/core/v1/modules/document/live"
            | "/core/v1/blobs/prepare"
            | "/core/v1/files/blobs/prepare"
    ) || path
        .strip_prefix("/core/v1/files/blobs/")
        .is_some_and(|id| !id.is_empty() && !id.contains('/'))
        || path
            .strip_prefix("/core/v1/threads/")
            .is_some_and(|suffix| {
                let parts: Vec<_> = suffix.split('/').collect();
                parts.len() == 3 && parts[1] == "blobs"
            })
}
fn remote_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "Remote authority is unavailable",
    )
}
fn session_required() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "Remote session requires renewal")
        .with_recovery(nodex_core_contracts::CoreErrorRecovery::RenewRemoteSession)
}

pub(crate) async fn authenticate(
    state: &Arc<ServerState>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(RemotePeer(peer, identity)) = request.extensions().get::<RemotePeer>().cloned() else {
        return remote_unavailable().into_response();
    };
    let path = request.uri().path();
    if matches!(path, "/enroll" | "/session") {
        if !state.remote.preauth(peer.ip()) {
            return state
                .remote
                .limited(RemoteBudget::PreAuthIp, 60_000)
                .into_response();
        }
        let (parts, body) = request.into_parts();
        let bytes =
            match tokio::time::timeout(Duration::from_secs(10), to_bytes(body, 64 * 1024)).await {
                Ok(Ok(bytes)) => bytes,
                _ => {
                    return ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Enrollment body exceeds its bound or deadline",
                    )
                    .into_response();
                }
            };
        request = Request::from_parts(parts, Body::from(bytes.clone()));
        request
            .extensions_mut()
            .insert(IncomingBytes(bytes.len() as u64));
        return next.run(request).await;
    }
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    let check_state = state.clone();
    let principal = match tokio::task::spawn_blocking(move || {
        check_state.membership.authenticate(&token)
    })
    .await
    {
        Ok(Ok(p)) => p,
        Ok(Err(error)) if error.code == StoreErrorCode::Unauthorized => {
            if !state.remote.preauth(peer.ip()) {
                return state
                    .remote
                    .limited(RemoteBudget::PreAuthIp, 60_000)
                    .into_response();
            }
            return session_required().into_response();
        }
        _ => return remote_unavailable().into_response(),
    };
    {
        let Ok(mut bound) = identity.lock() else {
            return remote_unavailable().into_response();
        };
        if bound.as_ref().is_some_and(|old| {
            old.space_id != principal.space_id
                || old.member_id != principal.member_id
                || old.device_id != principal.device_id
        }) {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                "An HTTP connection cannot change its Device",
            )
            .into_response();
        }
        *bound = Some(principal.clone());
    }
    if let Ok(mut budgets) = state.remote.budgets.lock() {
        // Diagnostic cardinality follows the router, never caller-supplied resource IDs.
        let route = request
            .extensions()
            .get::<axum::extract::MatchedPath>()
            .map_or("<unmatched>", |matched| matched.as_str());
        *budgets.routes.entry(route.to_owned()).or_default() += 1;
    }
    if let Err(error) = state.remote.charge(&principal, 1, 0) {
        return error.into_response();
    }
    if !admitted_route(path)
        || path == "/core/v1/health"
        || path == "/core/v1/agent-attributions"
        || path == "/core/v1/modules/workspace/tool-operations/admit"
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "This operation requires the local Host",
        )
        .into_response();
    }
    if request
        .headers()
        .get(request_execution::REQUEST_CLASS_HEADER)
        .is_some_and(|v| v != "interactive" && v != "background")
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "Remote clients cannot select an administrative execution class",
        )
        .into_response();
    }
    if request.headers().contains_key(EDITOR_HISTORY_OWNER_HEADER)
        || request
            .headers()
            .contains_key(nodex_core_protocol::AGENT_ATTRIBUTION_HEADER)
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "Remote clients cannot assert Host or Agent authority",
        )
        .into_response();
    }
    let permit = match state.remote.admit(&principal).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };
    let global_permit = match tokio::time::timeout(
        Duration::from_secs(2),
        state.remote.admitted.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return state
                .remote
                .limited(RemoteBudget::GlobalConcurrency, 1_000)
                .into_response();
        }
    };
    // Count actual bytes, including chunked uploads, before handing a bounded body to
    // transport parsing. No Content-Length trust and no unbounded upload allocation.
    let (parts, body) = request.into_parts();
    let bytes =
        match tokio::time::timeout(Duration::from_secs(20), to_bytes(body, 32 * 1024 * 1024)).await
        {
            Ok(Ok(bytes)) => bytes,
            _ => {
                return ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Remote request body exceeds its bound or deadline",
                )
                .into_response();
            }
        };
    if let Err(error) = state.remote.charge(&principal, 0, bytes.len() as u64) {
        return error.into_response();
    }
    request = Request::from_parts(parts, Body::from(bytes));
    request.extensions_mut().insert(principal.clone());
    let sse = response
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"));
    let stream_permit = if sse {
        match state.remote.stream(&principal) {
            Ok(p) => Some(p),
            Err(e) => return e.into_response(),
        }
    } else {
        None
    };
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .insert("x-accel-buffering", "no".parse().unwrap());
    let state = state.clone();
    let mut body = body.into_data_stream();
    let stream = async_stream::stream! {
     let _lease=stream_permit;
     let mut checks=tokio::time::interval(Duration::from_secs(1));
     let mut heartbeat=tokio::time::interval_at(tokio::time::Instant::now()+Duration::from_secs(15),Duration::from_secs(15));
     loop {tokio::select! {
      _=checks.tick()=>{if state.lifecycle.is_draining() || !state.membership.active(&principal) {break;}},
      _=heartbeat.tick(),if sse=>{let bytes=Bytes::from_static(b": heartbeat\n\n");if state.remote.charge(&principal,0,bytes.len() as u64).is_err() {break;}yield Ok::<Bytes,io::Error>(bytes);},
      item=std::future::poll_fn(|cx|std::pin::Pin::new(&mut body).poll_next(cx))=>{match item {Some(Ok(bytes))=>{if !state.membership.active(&principal)||state.remote.charge(&principal,0,bytes.len() as u64).is_err() {break;}yield Ok(bytes);},Some(Err(_))=>{yield Err(io::Error::other("Remote response ended"));break;},None=>break,}}
     }}
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

fn pem_bytes(path: &Path, private: bool) -> io::Result<Vec<u8>> {
    if private {
        private_fs::checked_metadata(path, private_fs::EntryKind::File, Some(0o600))?;
    } else {
        private_fs::entry_metadata(path, private_fs::EntryKind::File)?;
    }
    let mut file = private_fs::OpenOptions::new().read(true).open(path)?;
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(io::Error::other("PEM exceeds its bound"));
    }
    Ok(bytes)
}
fn certificate(
    home: &Path,
    request: &ListenRequest,
) -> Result<(rustls::ServerConfig, String), Box<dyn std::error::Error>> {
    let (cert, key) = match (&request.cert, &request.key) {
        (Some(cert), Some(key)) => (
            pem_bytes(Path::new(cert), false)?,
            pem_bytes(Path::new(key), true)?,
        ),
        (None, None) => {
            let dir = home.join("team-transport");
            private_fs::create_dir_all(&dir)?;
            let identity_path = dir.join("server-identity.pem");
            if !identity_path.try_exists()? {
                let host = request
                    .address
                    .rsplit_once(':')
                    .ok_or("Expected host:port")?
                    .0
                    .trim_matches(['[', ']'])
                    .to_string();
                let rcgen::CertifiedKey { cert, signing_key } =
                    rcgen::generate_simple_self_signed(vec!["localhost".into(), host])?;
                let pending = dir.join("server-identity.pending");
                private_fs::write(
                    &pending,
                    format!("{}{}", cert.pem(), signing_key.serialize_pem()),
                )?;
                private_fs::OpenOptions::new()
                    .read(true)
                    .open(&pending)?
                    .sync_all()?;
                private_fs::atomic_replace(&pending, &identity_path)?;
                private_fs::sync_directory(&dir)?;
            }
            let identity = pem_bytes(&identity_path, true)?;
            (identity.clone(), identity)
        }
        _ => return Err("Provide both certificate and private key".into()),
    };
    let certs = rustls_pemfile::certs(&mut cert.as_slice()).collect::<io::Result<Vec<_>>>()?;
    let first = certs.first().ok_or("Certificate chain is empty")?;
    let fingerprint = hex::encode(Sha256::digest(first.as_ref()));
    let key = rustls_pemfile::private_key(&mut key.as_slice())?.ok_or("Private key is empty")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((config, fingerprint))
}

pub(crate) async fn listen(
    state: Arc<ServerState>,
    request: ListenRequest,
) -> Result<ListenerInfo, ApiError> {
    state.membership.require_owner().map_err(store_api)?;
    // Reserve once, even across concurrent local administration calls.
    let mut info = state.remote.info.lock().map_err(|_| remote_unavailable())?;
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "Remote listener is already enabled",
        ));
    }
    let (config, fingerprint) = certificate(&state.home, &request).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Certificate configuration is invalid",
        )
    })?;
    socket
        .set_nonblocking(true)
        .map_err(|_| remote_unavailable())?;
    let address = socket.local_addr().map_err(|_| remote_unavailable())?;
    let listener = tokio::net::TcpListener::from_std(socket).map_err(|_| remote_unavailable())?;
    let value = ListenerInfo {
        url: format!("https://{address}"),
        fingerprint,
    };
    *info = Some(value.clone());
    let acceptor = TlsAcceptor::from(Arc::new(config));
    tokio::spawn(async move {
        let capacity = Arc::new(Semaphore::new(128));
        loop {
            let Ok((socket, peer)) = accepted else { break };
            if !state.remote.preauth(peer.ip()) {
                state.remote.limited(RemoteBudget::PreAuthIp, 60_000);
                continue;
            }
            let Ok(permit) = capacity.clone().try_acquire_owned() else {
                continue;
            };
            let acceptor = acceptor.clone();
            let state = state.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = socket2::SockRef::from(&socket).set_tcp_keepalive(
                    &socket2::TcpKeepalive::new()
                        .with_time(Duration::from_secs(15))
                        .with_interval(Duration::from_secs(15)),
                );
                let Ok(Ok(socket)) =
                    tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket)).await
                else {
                    return;
                };
                let mut socket = tokio_io_timeout::TimeoutStream::new(socket);
                socket.set_write_timeout(Some(Duration::from_secs(15)));
                let identity = Arc::new(Mutex::new(None::<RemotePrincipal>));
                let service = router(state.clone())
                    .layer(Extension(RemotePeer(peer, identity.clone())))
                    .layer(Extension(ConnectInfo(PeerIdentity::unavailable())));
                let mut builder = hyper::server::conn::http1::Builder::new();
                builder
                    .timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(10))
                    .max_buf_size(64 * 1024);
                // This monitor owns the socket independently of Body polling, so
                // revocation also interrupts a reader stalled inside a TLS write.
                let withdrawn = async {
                    loop {
                        tokio::select! {
                            _=state.lifecycle.wait_for_drain()=>return,
                            _=tokio::time::sleep(Duration::from_secs(1))=>{
                            }
                        }
                    }
                };
                tokio::select! {_=connection=>{},_=withdrawn=>{}}
            });
        }
    });
    Ok(value)
}
    };
    ApiError::new(status, error.message)
}

fn withdrawal_api(error: StoreError) -> ApiError {
    if error.code == StoreErrorCode::Unauthorized {
        return store_api(error)
            .with_recovery(nodex_core_contracts::CoreErrorRecovery::RemoteAccessWithdrawn);
    }
    store_api(error)
}

pub(crate) async fn enroll(
    State(state): State<Arc<ServerState>>,
    Extension(_remote): Extension<RemotePeer>,
    Json(request): Json<EnrollmentRequest>,
) -> Result<Json<EnrollmentResponse>, ApiError> {
    tokio::task::spawn_blocking(move || state.membership.enroll(request))
        .await
        .map_err(|_| remote_unavailable())?
        .map(Json)
        .map_err(store_api)
}
pub(crate) async fn session(
    State(state): State<Arc<ServerState>>,
    Extension(_remote): Extension<RemotePeer>,
    Extension(bytes): Extension<IncomingBytes>,
    Json(request): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let device = state
            .membership
            .authenticate_device(&request.device_credential)
            .map_err(withdrawal_api)?;
        state
            .remote
            .charge_device(&device.member_id, &device.device_id, 1, bytes.0)?;
        // The writer verifies the credential again, fencing a revoke between
        // budget admission and durable session issuance.
        state
            .membership
            .session(request)
            .map(Json)
            .map_err(withdrawal_api)
    })
    .await
    .map_err(|_| remote_unavailable())?
}

fn local_admin(state: &ServerState, remote: Option<Extension<RemotePeer>>) -> Result<(), ApiError> {
    if remote.is_some() {
        return Err(remote_unavailable());
    }
    state
        .membership
        .require_owner()
        .map(|_| ())
        .map_err(store_api)
}
pub(crate) async fn start_listener(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<RemotePeer>>,
    Json(request): Json<ListenRequest>,
) -> Result<Json<ListenerInfo>, ApiError> {
    local_admin(&state, remote)?;
    listen(state, request).await.map(Json)
}
        space_name: state.membership.name().map_err(store_api)?,
/// A committed name change wakes every live event stream, so connected desktops show the
/// new name now rather than after their next reconnection.
fn announce_name_change(state: &ServerState) {
    let _ = state.event_sender.send(CommitWake);
}
pub(crate) async fn rename_space(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<RenameSpaceRequest>,
) -> Result<Json<SpaceName>, ApiError> {
    let renamed = tokio::task::spawn_blocking(move || membership.rename(request))
        .await
        .map_err(|_| remote_unavailable())?
        .map_err(administration_api)?;
    announce_name_change(&state);
    Ok(Json(renamed))
}
pub(crate) async fn rename_member(
    State(state): State<Arc<ServerState>>,
    principal: Option<Extension<RemotePrincipal>>,
    Json(request): Json<RenameMemberRequest>,
) -> Result<Json<nodex_core_contracts::library::Member>, ApiError> {
    let membership = state
        .membership
        .for_principal(principal.map(|Extension(p)| p));
    let renamed = tokio::task::spawn_blocking(move || membership.rename_member(request))
        .await
        .map_err(|_| remote_unavailable())?
        .map_err(administration_api)?;
    announce_name_change(&state);
    Ok(Json(renamed))
}
pub(crate) async fn invite(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<InviteRequest>,
) -> Result<Json<InviteResponse>, ApiError> {
    let info = state
        .remote
        .info
        .lock()
        .map_err(|_| remote_unavailable())?
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "Enable the remote listener first"))?;
        .await
        .map_err(|_| remote_unavailable())?
        .map(Json)
}
pub(crate) async fn devices(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<MemberDevice>>, ApiError> {
        .await
        .map_err(|_| remote_unavailable())?
        .map(Json)
}
pub(crate) async fn revoke(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<RemotePeer>>,
    Json(request): Json<RevokeDeviceRequest>,
    tokio::task::spawn_blocking(move || {
            .revoke(request.device_id.clone())
        state
            .connections
            .withdraw(|p| p.device_id == request.device_id)
            .map_err(connection_registry_error)
    })
    .await
    .map_err(|_| remote_unavailable())??;
}
pub(crate) async fn remove(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<RemoveMemberRequest>,
) -> Result<Json<bool>, ApiError> {
    tokio::task::spawn_blocking(move || {
            .remove(request.member_id.clone())
        state
            .connections
            .withdraw(|p| p.member_id == request.member_id)
            .map_err(connection_registry_error)
    })
    .await
    .map_err(|_| remote_unavailable())??;
    Ok(Json(true))
}

/// Local Owner diagnostics; never admitted by the network listener.
pub(crate) async fn transport_stats(
) -> Result<Json<RemoteTransportStats>, ApiError> {
    let budgets = state
    Ok(Json(RemoteTransportStats {
        pre_auth_ips: budgets
            .map(|(key, value)| (key.to_string(), value.snapshot()))
            .collect(),
        members: budgets
            .map(|(key, value)| (key.clone(), value.snapshot()))
            .collect(),
        devices: budgets
            .map(|(key, value)| (key.clone(), value.snapshot()))
            .collect(),
        routes: budgets.routes.clone(),
        refusals: state
            .refusals
            .clone(),
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_and_request_windows_admit_the_exact_bound_then_refuse() {
        let mut window = Window::default();
        assert!(window.charge(1, 1024, 2, 1024));
        assert!(!window.charge(0, 1, 2, 1024));
        assert!(window.charge(1, 0, 2, 1024));
        assert!(!window.charge(1, 0, 2, 1024));
        window.started = Some(Instant::now() - Duration::from_secs(60));
        assert!(window.charge(2, 1024, 2, 1024));
    }
    #[test]
    fn desktop_request_bursts_remain_bounded_per_device_and_member() {
        let state = RemoteState::default();
        for _ in 0..DEVICE_REQUESTS_PER_MINUTE {
            assert!(state.charge_device("member", "first", 1, 0).is_ok());
        }
        assert!(state.charge_device("member", "first", 1, 0).is_err());
        // Device admission is atomic: a refused Device does not spend its Member window.
        for _ in 0..(MEMBER_REQUESTS_PER_MINUTE - DEVICE_REQUESTS_PER_MINUTE) {
            assert!(state.charge_device("member", "second", 1, 0).is_ok());
        }
        assert!(state.charge_device("member", "third", 1, 0).is_err());
        assert!(
            state
                .charge_device("another-member", "another-device", 1, 0)
                .is_ok()
        );
    }
    #[test]
    fn member_stream_capacity_is_shared_across_devices_and_released() {
        let state = RemoteState::default();
        let principal = |device| RemotePrincipal {
            space_id: "space".into(),
            member_id: "member".into(),
            device_id: format!("device:{device}"),
            session_id: "session".into(),
            role: nodex_core_contracts::library::MemberRole::Member,
        };
        let mut leases = Vec::new();
        for device in 0..16 {
            leases.push(
                state
                    .stream(&principal(device))
                    .unwrap_or_else(|_| panic!("Member stream fits its capacity")),
            );
        }
        assert!(state.stream(&principal(17)).is_err());
        leases.pop();
        assert!(state.stream(&principal(17)).is_ok());
    }
}
