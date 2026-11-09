//! Bounded, generation-local relay to the Space's execution owner. No transcript is stored in Core.
use super::*;
use nodex_core::workspace::HostChatAction;
use nodex_core_contracts::{RemotePrincipal, team::*};
use std::collections::{HashMap, VecDeque};
use tokio::sync::{Notify, oneshot};

const CAPACITY: usize = 32;
const DEADLINE: Duration = Duration::from_secs(25);
const LEASE_IDLE: Duration = Duration::from_secs(30);
pub(crate) const INVOCATION_HEADER: &str = "x-nodex-host-invocation";

struct Pending {
    credential: String,
    call: HostCall,
    principal: RemotePrincipal,
    created: Instant,
    delivered: bool,
    reply: oneshot::Sender<HostCallResult>,
}
#[derive(Default)]
struct Inner {
    lease: Option<(String, Instant)>,
    pending: HashMap<String, Pending>,
    queue: VecDeque<String>,
}
#[derive(Default)]
pub(crate) struct HostBridge {
    inner: Mutex<Inner>,
    wake: Notify,
}
pub(crate) fn credential() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    Ok(hex::encode(bytes))
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "The Space Host is unavailable",
    )
}
fn local(remote: Option<Extension<remote::RemotePeer>>) -> Result<(), ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    Ok(())
}
impl HostBridge {
    pub(crate) fn check_lease(&self, token: &str) -> Result<(), ApiError> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.lease(&mut inner, token)?;
        Ok(())
    }
    pub(crate) fn available(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| Self::active(&inner))
    }

    /// A Member's live delete call for exactly this side chat of theirs.
    pub(crate) fn authorizes_side_chat_delete(&self, token: &str, session: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        Self::live_call(&inner, token).is_some_and(|pending| {
            matches!(pending.call.operation, HostOperation::SessionSideChatDelete)
                && text(&pending.call.input, &["sessionId"]) == Some(session)
        })
    }
    /// The delivered, unexpired call this exact invocation proof belongs to.
    fn live_call<'a>(inner: &'a Inner, token: &str) -> Option<&'a Pending> {
        if !Self::active(inner) {
            return None;
        }
        inner.pending.values().find(|pending| {
            pending.delivered
                && pending.created.elapsed() < DEADLINE
                && constant_time_equal(pending.credential.as_bytes(), token.as_bytes())
        })
    }
    pub(crate) fn authorizes_message(&self, token: &str, session: &str, message: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        Self::live_call(&inner, token).is_some_and(|pending| {
            matches!(
                pending.call.operation,
                HostOperation::SessionMessage
                    | HostOperation::SessionRewriteMessage
                    | HostOperation::SessionStart
            ) && text(&pending.call.input, &["sessionId"]) == Some(session)
                && text(&pending.call.input, &["message", "messageId"]) == Some(message)
        })
    }
    /// A Member's call that creates exactly this chat: a new chat, a fork or a side chat.
    pub(crate) fn authorizes_launch(
        &self,
        token: &str,
        session: &str,
        launch: &str,
        side_chat_source: Option<&str>,
    ) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        Self::live_call(&inner, token).is_some_and(|pending| {
            let input = &pending.call.input;
            let created = text(input, &["sessionId"]) == Some(session)
                && text(input, &["requestId"]) == Some(launch);
            match pending.call.operation {
                HostOperation::SessionStart => {
                    text(input, &["sessionId"]) == Some(session)
                        && text(input, &["launchId"]) == Some(launch)
                        && side_chat_source.is_none()
                }
                HostOperation::SessionFork => created && side_chat_source.is_none(),
                HostOperation::SessionSideChatCreate => {
                    created
                        && side_chat_source.is_some()
                        && side_chat_source == text(input, &["source", "sessionId"])
                }
                _ => false,
            }
        })
    }
    fn active(inner: &Inner) -> bool {
        inner
            .lease
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() < LEASE_IDLE)
    }
    fn lease<'a>(&self, inner: &'a mut Inner, token: &str) -> Result<&'a mut Inner, ApiError> {
        if !Self::active(inner)
            || !inner.lease.as_ref().is_some_and(|(current, _)| {
                constant_time_equal(current.as_bytes(), token.as_bytes())
            })
        {
            return Err(unavailable());
        }
        inner.lease.as_mut().unwrap().1 = Instant::now();
        Ok(inner)
    }
    pub(crate) fn principal(
        &self,
        token: &str,
        workspace: &ProjectWorkspaceModule,
    ) -> Result<RemotePrincipal, CoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| unauthorized("Host call is unavailable"))?;
        let pending =
            Self::live_call(&inner, token).ok_or_else(|| unauthorized("Host call has expired"))?;
        authorize_call(workspace, &pending.principal, &pending.call)?;
        Ok(pending.principal.clone())
    }
}

fn text<'a>(input: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(input, |value, key| value.get(key))
        .and_then(|value| value.as_str())
}

/// Core decides from its own Store what a Member may do in a hosted chat; the call names only the
/// chats. Core's pending request determines a response's recipient, so a caller cannot select an
/// Actor or turn a question into an approval by changing the payload. Managing a chat and stopping
/// its work follow Core's one chat stewardship rule, for the exact Session and Run the host will
/// act on. Admission, delivery and every use of the invocation repeat this check, so a revoked
/// Device or role change ends it.
fn authorize_call(
    workspace: &ProjectWorkspaceModule,
    principal: &RemotePrincipal,
    call: &HostCall,
) -> Result<(), CoreError> {
    let session = |path: &[&str]| {
        text(&call.input, path)
            .ok_or_else(|| unauthorized("A hosted chat action requires its Session"))
    };
    let chat = |action| workspace.authorize_host_chat(principal, action);
    match call.operation {
        HostOperation::SessionRespond => {
            let id = |key| session(&[key]);
            let run = match call.input.get("runId") {
                Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(run)) => Some(run.as_str()),
                _ => return Err(unauthorized("A hosted response requires its original Run")),
            };
            workspace.authorize_host_response(principal, id("sessionId")?, run, id("requestId")?)
        }
        HostOperation::SessionStart => chat(HostChatAction::Start {
            session: session(&["sessionId"])?,
            launch: session(&["launchId"])?,
        }),
        HostOperation::SessionFork => chat(HostChatAction::Read {
            session: session(&["source", "sessionId"])?,
        }),
        HostOperation::SessionSideChatCreate => chat(HostChatAction::Reply {
            session: session(&["source", "sessionId"])?,
        }),
        HostOperation::SessionSideChatDelete => chat(HostChatAction::OwnSideChat {
            session: session(&["sessionId"])?,
        }),
        HostOperation::SessionMergeBack => chat(HostChatAction::Manage {
            session: session(&["sessionId"])?,
        }),
        HostOperation::SessionCompact | HostOperation::SessionClearContext => {
            chat(HostChatAction::ManageContext {
                session: session(&["sessionId"])?,
            })
        }
        HostOperation::SessionRewriteMessage => chat(HostChatAction::Edit {
            session: session(&["sessionId"])?,
            run: text(&call.input, &["runId"])
                .ok_or_else(|| unauthorized("A message edit requires its Run"))?,
        }),
        HostOperation::SessionStop | HostOperation::SessionStopTask => chat(HostChatAction::Stop {
            session: session(&["sessionId"])?,
            run: Some(
                text(&call.input, &["runId"])
                    .ok_or_else(|| unauthorized("Stopping work requires its Run"))?,
            ),
        }),
        // A delegated or background task answers for the Run that started it, which the host
        // checks it belongs to; one whose Run is unknown stops only for those who manage the chat.
        HostOperation::SessionCancelTask | HostOperation::SessionStopBackground => {
            chat(HostChatAction::Stop {
                session: session(&["sessionId"])?,
                run: text(&call.input, &["runId"]),
            })
        }
        _ => Ok(()),
    }
}
pub(crate) async fn register(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(request): Json<HostRegistration>,
) -> Result<Json<HostLease>, ApiError> {
    local(remote)?;
    state
        .membership
        .require_owner()
        .map_err(|_| unavailable())?;
    if request.instance.len() < 16
        || request.instance.len() > 64
        || !request
            .instance
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Invalid Host instance",
        ));
    }
    let token = credential()?;
    let mut inner = state.host_bridge.inner.lock().map_err(|_| unavailable())?;
    // The embedding process already owns its native home lease. A replacement retires
    // every old call, including credentials held by an interrupted execution owner.
    *inner = Inner {
        lease: Some((token.clone(), Instant::now())),
        ..Inner::default()
    };
    state.phone_bridge.retire_all();
    state.host_bridge.wake.notify_waiters();
    Ok(Json(HostLease { token }))
}
pub(crate) async fn availability(State(state): State<Arc<ServerState>>) -> Json<HostAvailability> {
    Json(HostAvailability {
        available: state
            .host_bridge
            .inner
            .lock()
            .is_ok_and(|inner| HostBridge::active(&inner)),
    })
}
pub(crate) async fn poll(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(request): Json<HostLease>,
) -> Result<Json<Option<HostInvocation>>, ApiError> {
    local(remote)?;
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let notified = state.host_bridge.wake.notified();
        {
            let mut inner = state.host_bridge.inner.lock().map_err(|_| unavailable())?;
            let inner = state.host_bridge.lease(&mut inner, &request.token)?;
            while let Some(id) = inner.queue.pop_front() {
                let Some(pending) = inner.pending.get_mut(&id) else {
                    continue;
                };
                if pending.reply.is_closed()
                    || pending.created.elapsed() >= DEADLINE
                    || !state.membership.active(&pending.principal)
                {
                    inner.pending.remove(&id);
                    continue;
                }
                if let Err(error) =
                    authorize_call(&state.workspace, &pending.principal, &pending.call)
                {
                    let pending = inner.pending.remove(&id).expect("pending call");
                    let _ = pending.reply.send(HostCallResult::Error {
                        message: error.message,
                    });
                    continue;
                }
                pending.delivered = true;
                return Ok(Json(Some(HostInvocation {
                    id,
                    credential: pending.credential.clone(),
                    call: pending.call.clone(),
                })));
            }
        }
        // A draining Core answers its own execution owner at once, so the owner can stop it.
        let idle = tokio::select! {
            woken = tokio::time::timeout_at(until, notified) => woken.is_err(),
            () = state.lifecycle.wait_for_drain() => true,
        };
        if idle {
            return Ok(Json(None));
        }
    }
}
struct Retire {
    state: Arc<ServerState>,
    id: String,
}
impl Drop for Retire {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.state.host_bridge.inner.lock() {
            inner.pending.remove(&self.id);
            inner.queue.retain(|id| id != &self.id);
        }
    }
}
pub(crate) async fn call(
    State(state): State<Arc<ServerState>>,
    principal: Option<Extension<RemotePrincipal>>,
    Json(request): Json<HostCall>,
) -> Result<Json<HostCallResult>, ApiError> {
    let Some(Extension(principal)) = principal else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "A verified Member is required",
        ));
    };
    if serde_json::to_vec(&request)
        .map_err(|_| unavailable())?
        .len()
        > 1024 * 1024
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Host call exceeds its bound",
        ));
    }
    authorize_call(&state.workspace, &principal, &request).map_err(api_core_error)?;
    let id = credential()?;
    let invocation = credential()?;
    let (reply, result) = oneshot::channel();
    {
        let mut inner = state.host_bridge.inner.lock().map_err(|_| unavailable())?;
        if !HostBridge::active(&inner) {
            return Err(unavailable());
        }
        if inner.pending.len() >= CAPACITY
            || inner
                .pending
                .values()
                .filter(|pending| pending.principal.member_id == principal.member_id)
                .count()
                >= 8
        {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Host call queue is full",
            ));
        }
        inner.pending.insert(
            id.clone(),
            Pending {
                credential: invocation,
                call: request,
                principal: principal.clone(),
                created: Instant::now(),
                delivered: false,
                reply,
            },
        );
        inner.queue.push_back(id.clone());
    }
    let _retire = Retire {
        state: state.clone(),
        id,
    };
    state.host_bridge.wake.notify_one();
    let result = tokio::select! {
        result = tokio::time::timeout(DEADLINE, result) => result,
        () = state.lifecycle.wait_for_drain() => return Err(unavailable()),
    }
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())?;
    if !state.membership.active(&principal) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Membership was revoked",
        ));
    }
    Ok(Json(result))
}
pub(crate) async fn complete(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(request): Json<HostCompletion>,
) -> Result<Json<bool>, ApiError> {
    local(remote)?;
    if serde_json::to_vec(&request.result)
        .map_err(|_| unavailable())?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Host response exceeds its bound",
        ));
    }
    let mut inner = state.host_bridge.inner.lock().map_err(|_| unavailable())?;
    let inner = state.host_bridge.lease(&mut inner, &request.token)?;
    let pending = inner.pending.remove(&request.id).ok_or_else(unavailable)?;
    if !pending.delivered
        || pending.created.elapsed() >= DEADLINE
        || !state.membership.active(&pending.principal)
    {
        return Err(unavailable());
    }
    Ok(Json(pending.reply.send(request.result).is_ok()))
}
