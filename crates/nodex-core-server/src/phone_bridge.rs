//! One phone frontier on Core's pinned listener. Only Core-issued proofs cross to the local Host.
use super::*;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use nodex_core::workspace::HostChatAction;
use nodex_core_contracts::{RemotePrincipal, team::*};
use std::collections::{HashMap, VecDeque};
use tokio::sync::{Notify, mpsc};

const FRAME_BYTES: usize = 1024 * 1024;
const CHANNELS: usize = 32;
const QUEUED_EVENTS: usize = 256;
const REQUESTS: usize = 8;
const DEADLINE: Duration = Duration::from_secs(25);

struct Invocation {
    credential: String,
    id: i64,
    method: String,
    params: serde_json::Value,
    created: Instant,
    delivered: bool,
}
struct Channel {
    principal: RemotePrincipal,
    credential: String,
    delivered: bool,
    output: mpsc::Sender<serde_json::Value>,
    requests: HashMap<i64, Invocation>,
}
#[derive(Default)]
struct Inner {
    channels: HashMap<String, Channel>,
    queue: VecDeque<PhoneHostEvent>,
}
#[derive(Default)]
pub(crate) struct PhoneBridge {
    inner: Mutex<Inner>,
    wake: Notify,
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "The Space phone Host is unavailable",
    )
}
fn channel_id(event: &PhoneHostEvent) -> &str {
    match event {
        PhoneHostEvent::Open { channel_id, .. }
        | PhoneHostEvent::Request { channel_id, .. }
        | PhoneHostEvent::Close { channel_id } => channel_id,
    }
}
fn authorize_response(
    workspace: &ProjectWorkspaceModule,
    principal: &RemotePrincipal,
    method: &str,
    params: &serde_json::Value,
) -> Result<(), CoreError> {
    // A phone stops a chat's Run as its desktop does, by Core's one chat stewardship rule.
    if method == "chat.stop" {
        let text = |key| params.get(key).and_then(|v| v.as_str());
        let (Some(session), Some(run)) = (text("sessionId"), text("runId")) else {
            return Err(unauthorized("Stopping work requires its Session and Run"));
        };
        return workspace.authorize_host_chat(
            principal,
            HostChatAction::Stop {
                session,
                run: Some(run),
            },
        );
    }
    // A phone starts a chat as its desktop does: a new one, or the unstarted one its Member opened.
    if method == "chats.start" {
        let text = |key| params.get(key).and_then(|v| v.as_str());
        let (Some(session), Some(launch)) = (text("sessionId"), text("launchId")) else {
            return Err(unauthorized(
                "Starting a chat requires its Session and launch",
            ));
        };
        return workspace.authorize_host_chat(principal, HostChatAction::Start { session, launch });
    }
    if method != "chat.respond" {
        return Ok(());
    }
    let id = |key| {
        params
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| unauthorized("A phone response requires its Session and request"))
    };
    let run = match params.get("runId") {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(run)) => Some(run.as_str()),
        _ => return Err(unauthorized("A phone response requires its original Run")),
    };
    workspace.authorize_host_response(principal, id("sessionId")?, run, id("requestId")?)
}
impl PhoneBridge {
    pub(crate) fn observation(&self, token: &str) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner
                .channels
                .values()
                .any(|channel| constant_time_equal(channel.credential.as_bytes(), token.as_bytes()))
        })
    }
    pub(crate) fn retire_all(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = Inner::default();
        }
        self.wake.notify_waiters();
    }
    fn remove(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.channels.remove(id);
            inner.queue.retain(|event| channel_id(event) != id);
            inner.queue.push_back(PhoneHostEvent::Close {
                channel_id: id.into(),
            });
        }
        self.wake.notify_one();
    }
    /// Open proofs are observation-only. Mutation proofs expire with their exact in-flight request.
    pub(crate) fn principal(
        &self,
        token: &str,
        workspace: &ProjectWorkspaceModule,
        read_only: bool,
    ) -> Result<RemotePrincipal, CoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| unauthorized("Phone invocation unavailable"))?;
        for channel in inner.channels.values() {
            if read_only
                && channel.delivered
                && constant_time_equal(channel.credential.as_bytes(), token.as_bytes())
            {
                return Ok(channel.principal.clone());
            }
            for request in channel.requests.values() {
                if !request.delivered
                    || request.created.elapsed() >= DEADLINE
                    || !constant_time_equal(request.credential.as_bytes(), token.as_bytes())
                {
                    continue;
                }
                authorize_response(
                    workspace,
                    &channel.principal,
                    &request.method,
                    &request.params,
                )?;
                return Ok(channel.principal.clone());
            }
        }
        Err(unauthorized("Phone invocation has expired"))
    }
    /// The phone's own live `push.register` or `push.unregister` request, with its Device.
    fn push_request(&self, token: &str) -> Option<(RemotePrincipal, Option<PushRegistration>)> {
        let inner = self.inner.lock().ok()?;
        inner.channels.values().find_map(|channel| {
            channel.requests.values().find_map(|request| {
                if !request.delivered
                    || request.created.elapsed() >= DEADLINE
                    || !constant_time_equal(request.credential.as_bytes(), token.as_bytes())
                {
                    return None;
                }
                let registration = match request.method.as_str() {
                    "push.register" => Some(
                        serde_json::from_value::<PushRegistration>(request.params.clone()).ok()?,
                    ),
                    "push.unregister" => None,
                    _ => return None,
                };
                Some((channel.principal.clone(), registration))
            })
        })
    }
    pub(crate) fn authorizes_launch(&self, token: &str, session: &str, launch: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        inner.channels.values().any(|channel| {
            channel.requests.values().any(|request| {
                request.delivered
                    && request.created.elapsed() < DEADLINE
                    && constant_time_equal(request.credential.as_bytes(), token.as_bytes())
                    && request.method == "chats.start"
                    && request.params.get("sessionId").and_then(|v| v.as_str()) == Some(session)
                    && request.params.get("launchId").and_then(|v| v.as_str()) == Some(launch)
            })
        })
    }
    pub(crate) fn authorizes_message(&self, token: &str, session: &str, message: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        inner.channels.values().any(|channel| {
            channel.requests.values().any(|request| {
                request.delivered
                    && request.created.elapsed() < DEADLINE
                    && constant_time_equal(request.credential.as_bytes(), token.as_bytes())
                    && matches!(request.method.as_str(), "chat.send" | "chats.start")
                    && request.params.get("sessionId").and_then(|v| v.as_str()) == Some(session)
                    && request.params.get("messageId").and_then(|v| v.as_str()) == Some(message)
            })
        })
    }
}
struct Retire {
    state: Arc<ServerState>,
    id: String,
}
impl Drop for Retire {
    fn drop(&mut self) {
        self.state.phone_bridge.remove(&self.id);
    }
}

pub(crate) async fn upgrade(
    State(state): State<Arc<ServerState>>,
    principal: Option<Extension<RemotePrincipal>>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let Some(Extension(principal)) = principal else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "A verified Member Device is required",
        ));
    };
    if !state.host_bridge.available() {
        return Err(unavailable());
    }
    let permits = state.remote.stream(&principal)?;
    let id = host_bridge::credential()?;
    let proof = host_bridge::credential()?;
    let (output, input) = mpsc::channel(8);
    let routes = state
        .remote
        .info
        .lock()
        .map_err(|_| unavailable())?
        .as_ref()
        .ok_or_else(unavailable)?
        .routes
        .clone();
    let space_name = state.membership.name().map_err(|_| unavailable())?;
    let space_kind = state.membership.kind().map_err(|_| unavailable())?;
    {
        let mut inner = state.phone_bridge.inner.lock().map_err(|_| unavailable())?;
        if inner.channels.len() >= CHANNELS || inner.queue.len() >= QUEUED_EVENTS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Phone channel capacity reached",
            ));
        }
        inner.channels.insert(
            id.clone(),
            Channel {
                principal: principal.clone(),
                credential: proof.clone(),
                delivered: false,
                output,
                requests: HashMap::new(),
            },
        );
        inner.queue.push_back(PhoneHostEvent::Open {
            channel_id: id.clone(),
            credential: proof,
            space_id: principal.space_id.clone(),
            member_id: principal.member_id.clone(),
            device_id: principal.device_id.clone(),
            routes,
            space_name,
            space_kind,
        });
    }
    let retire = Retire {
        state: state.clone(),
        id: id.clone(),
    };
    state.phone_bridge.wake.notify_one();
    Ok(upgrade
        .max_frame_size(FRAME_BYTES)
        .max_message_size(FRAME_BYTES)
        .max_write_buffer_size(2 * FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            let _retire = retire;
            let _permits = permits;
            serve(state, principal, id, socket, input).await;
        }))
}
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}
async fn send(socket: &mut WebSocket, envelope: &serde_json::Value) -> bool {
    let Ok(text) = serde_json::to_string(envelope) else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            Duration::from_secs(1),
            socket.send(Message::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn serve(
    state: Arc<ServerState>,
    principal: RemotePrincipal,
    id: String,
    mut socket: WebSocket,
    mut output: mpsc::Receiver<serde_json::Value>,
) {
    let mut checks = tokio::time::interval(Duration::from_secs(1));
    // The upgrade ended its TLS connection's monitor; the open channel keeps the phone seen.
    let mut seen = remote::DeviceSeen::default();
    loop {
        tokio::select! {
            _ = state.lifecycle.wait_for_drain() => { close(&mut socket,1012,"Space restarting").await; break; }
            _ = checks.tick() => {
                if !state.membership.active(&principal) {
                    close(&mut socket,4401,"Renew the Device session").await; break;
                }
                seen.refresh(&state, &principal);
                if !state.host_bridge.available() || state.remote.info.lock().is_ok_and(|info|info.is_none()) {
                    close(&mut socket,1013,"Space Host unavailable").await; break;
                }
                let expired = {
                    let Ok(mut inner) = state.phone_bridge.inner.lock() else { break; };
                    let Some(channel) = inner.channels.get_mut(&id) else { break; };
                    let ids: Vec<i64> = channel.requests.values().filter(|r| r.created.elapsed() >= DEADLINE).map(|r|r.id).collect();
                    for request in &ids { channel.requests.remove(request); }
                    ids
                };
                for request in expired {
                    let envelope = error(request,"unavailable","The Space Host did not answer in time",true);
                    if state.remote.charge(&principal,0,envelope.to_string().len() as u64).is_err() || !send(&mut socket,&envelope).await { return; }
                }
            }
            value = output.recv() => {
                let Some(value) = value else { break; };
                if !state.membership.active(&principal) { close(&mut socket,4401,"Renew the Device session").await; break; }
                if state.remote.charge(&principal,0,value.to_string().len() as u64).is_err() {
                    close(&mut socket,1013,"Device or Member byte budget reached").await; break;
                }
                if !send(&mut socket,&value).await { break; }
            }
            value = socket.recv() => {
                let Some(Ok(Message::Text(text))) = value else { break; };
                if !state.membership.active(&principal) { close(&mut socket,4401,"Renew the Device session").await; break; }
                if state.remote.charge(&principal,1,text.len() as u64).is_err() {
                    close(&mut socket,1013,"Device or Member budget reached").await; break;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { break; };
                if value.get("t").and_then(|v|v.as_str()) == Some("ping") {
                    let pong=serde_json::json!({"t":"pong"});
                    if state.remote.charge(&principal,0,pong.to_string().len() as u64).is_err() || !send(&mut socket,&pong).await {break;}
                    continue;
                }
                let result = enqueue(&state, &principal, &id, value);
                if let Err((request, message)) = result {
                    if let Some(request) = request {
                        let busy=message.contains("capacity") || message.contains("queue full");
                        let envelope=error(request,if busy {"unavailable"} else {"rejected"},message,busy);
                        if state.remote.charge(&principal,0,envelope.to_string().len() as u64).is_err() || !send(&mut socket,&envelope).await {break;}
                    } else { break; }
                }
            }
        }
    }
}
fn error(id: i64, code: &str, message: &str, retryable: bool) -> serde_json::Value {
    serde_json::json!({"t":"res","id":id,"ok":false,"e":{"code":code,"message":message,"retryable":retryable}})
}
fn enqueue(
    state: &ServerState,
    principal: &RemotePrincipal,
    id: &str,
    value: serde_json::Value,
) -> Result<(), (Option<i64>, &'static str)> {
    let request = value.get("id").and_then(|v| v.as_i64());
    let Some(request) = request else {
        return Err((None, "Invalid phone request"));
    };
    let Some(method) = value
        .get("m")
        .and_then(|v| v.as_str())
        .filter(|v| v.len() <= 64)
    else {
        return Err((Some(request), "Invalid method"));
    };
    if value.get("t").and_then(|v| v.as_str()) != Some("req") {
        return Err((Some(request), "Invalid envelope"));
    }
    let params = value.get("p").cloned().unwrap_or(serde_json::Value::Null);
    authorize_response(&state.workspace, principal, method, &params).map_err(|_| {
        (
            Some(request),
            "This request belongs to another Member or episode",
        )
    })?;
    let credential =
        host_bridge::credential().map_err(|_| (Some(request), "Phone invocation unavailable"))?;
    let mut inner = state
        .phone_bridge
        .inner
        .lock()
        .map_err(|_| (Some(request), "Phone invocation unavailable"))?;
    if inner.queue.len() >= QUEUED_EVENTS {
        return Err((Some(request), "Phone queue full"));
    }
    let member_requests: usize = inner
        .channels
        .values()
        .filter(|channel| channel.principal.member_id == principal.member_id)
        .map(|channel| channel.requests.len())
        .sum();
    let total_requests: usize = inner
        .channels
        .values()
        .map(|channel| channel.requests.len())
        .sum();
    if member_requests >= 8 || total_requests >= 32 {
        return Err((Some(request), "Phone request queue full"));
    }
    let Some(channel) = inner.channels.get_mut(id) else {
        return Err((None, "Phone disconnected"));
    };
    if !channel.delivered
        || channel.requests.len() >= REQUESTS
        || channel.requests.contains_key(&request)
    {
        return Err((Some(request), "Phone request capacity or identity conflict"));
    }
    channel.requests.insert(
        request,
        Invocation {
            credential: credential.clone(),
            id: request,
            method: method.into(),
            params: params.clone(),
            created: Instant::now(),
            delivered: false,
        },
    );
    inner.queue.push_back(PhoneHostEvent::Request {
        channel_id: id.into(),
        credential,
        id: request,
        method: method.into(),
        params,
    });
    drop(inner);
    state.phone_bridge.wake.notify_one();
    Ok(())
}
pub(crate) async fn poll(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(lease): Json<HostLease>,
) -> Result<Json<Option<PhoneHostEvent>>, ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let notified = state.phone_bridge.wake.notified();
        state.host_bridge.check_lease(&lease.token)?;
        {
            let mut inner = state.phone_bridge.inner.lock().map_err(|_| unavailable())?;
            while let Some(event) = inner.queue.pop_front() {
                if let PhoneHostEvent::Close { .. } = &event {
                    return Ok(Json(Some(event)));
                }
                let Some(channel) = inner.channels.get_mut(channel_id(&event)) else {
                    continue;
                };
                if !state.membership.active(&channel.principal) {
                    continue;
                }
                match &event {
                    PhoneHostEvent::Open { .. } => channel.delivered = true,
                    PhoneHostEvent::Request { id, .. } => {
                        let Some(request) = channel.requests.get_mut(id) else {
                            continue;
                        };
                        if request.created.elapsed() >= DEADLINE {
                            continue;
                        }
                        if authorize_response(
                            &state.workspace,
                            &channel.principal,
                            &request.method,
                            &request.params,
                        )
                        .is_err()
                        {
                            let _ = channel.output.try_send(error(
                                *id,
                                "rejected",
                                "This request is no longer yours",
                                false,
                            ));
                            channel.requests.remove(id);
                            continue;
                        }
                        request.delivered = true;
                    }
                    PhoneHostEvent::Close { .. } => unreachable!(),
                }
                return Ok(Json(Some(event)));
            }
        }
        let idle = tokio::select! {
            woken = tokio::time::timeout_at(until, notified) => woken.is_err(),
            () = state.lifecycle.wait_for_drain() => true,
        };
        if idle {
            return Ok(Json(None));
        }
    }
}
pub(crate) async fn publish(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(input): Json<PhoneHostPublish>,
) -> Result<Json<bool>, ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    state.host_bridge.check_lease(&input.token)?;
    if input.envelope.to_string().len() > FRAME_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Phone envelope exceeds its bound",
        ));
    }
    let mut inner = state.phone_bridge.inner.lock().map_err(|_| unavailable())?;
    let Some(channel) = inner.channels.get_mut(&input.channel_id) else {
        return Ok(Json(false));
    };
    if !channel.delivered || !state.membership.active(&channel.principal) {
        return Ok(Json(false));
    }
    if input.envelope.get("t").and_then(|v| v.as_str()) == Some("res") {
        let Some(id) = input.envelope.get("id").and_then(|v| v.as_i64()) else {
            return Ok(Json(false));
        };
        let Some(request) = channel.requests.remove(&id) else {
            return Ok(Json(false));
        };
        if !request.delivered || request.created.elapsed() >= DEADLINE {
            return Ok(Json(false));
        }
    }
    if channel.output.try_send(input.envelope).is_err() {
        // Overflow retires proofs and closes the socket; a partial stream cannot be resumed.
        inner.channels.remove(&input.channel_id);
        inner
            .queue
            .retain(|event| channel_id(event) != input.channel_id);
        inner.queue.push_back(PhoneHostEvent::Close {
            channel_id: input.channel_id,
        });
        state.phone_bridge.wake.notify_one();
        return Ok(Json(false));
    }
    Ok(Json(true))
}

/// Presentation can expose shared history without offering another Member's pending answer.
pub(crate) async fn response_entitlements(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(input): Json<PhoneResponseEntitlementRequest>,
) -> Result<Json<Vec<String>>, ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    if input.credential.len() != 64
        || input.session_id.len() > 512
        || input.requests.len() > 32
        || input
            .requests
            .iter()
            .any(|r| r.request_id.len() > 512 || r.run_id.as_ref().is_some_and(|v| v.len() > 512))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Phone entitlement query exceeds its bound",
        ));
    }
    let principal = state
        .phone_bridge
        .principal(&input.credential, &state.workspace, true)
        .map_err(api_core_error)?;
    if !state.host_bridge.available() || !state.membership.active(&principal) {
        return Err(unavailable());
    }
    Ok(Json(
        input
            .requests
            .into_iter()
            .filter_map(|r| {
                state
                    .workspace
                    .authorize_host_response(
                        &principal,
                        &input.session_id,
                        r.run_id.as_deref(),
                        &r.request_id,
                    )
                    .is_ok()
                    .then_some(r.request_id)
            })
            .collect(),
    ))
}

fn local_host(remote: &Option<Extension<remote::RemotePeer>>) -> Result<(), ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> Result<Json<T>, ApiError> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|_| unavailable())?
        .map(Json)
        .map_err(remote::store_api)
}

/// A phone's registration is its own request, committed to its own Device; the Host relays it
/// but cannot choose the Device, handle or key.
pub(crate) async fn commit_push(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(input): Json<PhonePushCommit>,
) -> Result<Json<bool>, ApiError> {
    local_host(&remote)?;
    let (principal, registration) = state
        .phone_bridge
        .push_request(&input.credential)
        .ok_or_else(|| api_core_error(unauthorized("Phone invocation has expired")))?;
    if !state.membership.active(&principal) {
        return Err(api_core_error(unauthorized(
            "Remote membership has been revoked",
        )));
    }
    let membership = state.membership.for_principal(Some(principal));
    blocking(move || {
        membership.set_push_registration(registration)?;
        Ok(true)
    })
    .await
}

/// Recipients follow Core's entitlement: a request's answerer or a Run's requester, never a guess.
pub(crate) async fn push_recipients(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(input): Json<PhonePushRecipientsRequest>,
) -> Result<Json<Vec<PhonePushRecipient>>, ApiError> {
    local_host(&remote)?;
    state.host_bridge.check_lease(&input.token)?;
    let member = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            state
                .workspace
                .push_audience(input.session_id.as_deref(), &input.audience)
        })
        .await
        .map_err(|_| unavailable())?
        .map_err(api_core_error)?
    };
    let Some(member) = member else {
        return Ok(Json(vec![]));
    };
    let membership = state.membership.for_principal(None);
    blocking(move || membership.push_recipients(&member)).await
}

pub(crate) async fn forget_push(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(input): Json<PhonePushForget>,
) -> Result<Json<bool>, ApiError> {
    local_host(&remote)?;
    state.host_bridge.check_lease(&input.token)?;
    let membership = state.membership.for_principal(None);
    blocking(move || membership.forget_push_registration(input.device_id, input.handle)).await
}
