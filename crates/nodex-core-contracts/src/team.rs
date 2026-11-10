//! Enrollment and local Space administration. Secrets appear only in one-time responses.
use crate::{RemotePrincipal, library::MemberRole};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Verified device identity before session issuance; contains no bearer credential.
#[derive(Clone, Debug)]
pub struct AuthenticatedDevice {
    pub device_id: String,
    pub space_id: String,
    pub member_id: String,
    pub role: MemberRole,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentRequest {
    pub code: String,
    pub device_label: String,
    pub display_name: String,
    #[serde(default)]
    pub form_factor: DeviceFormFactor,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct EnrollmentResponse {
    pub space_id: String,
    pub space_name: String,
    pub member_id: String,
    pub device_id: String,
    pub device_credential: String,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    pub device_credential: String,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct SessionResponse {
    pub session_token: String,
    pub expires_at: i64,
    pub principal: RemotePrincipal,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ListenRequest {
    pub address: String,
    pub cert: Option<String>,
    pub key: Option<String>,
    #[serde(default)]
    pub peer_policy: ListenerPeerPolicy,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct ListenerInfo {
    pub peer_policy: ListenerPeerPolicy,
    pub routes: Vec<String>,
    pub url: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct SpaceIdentity {
    pub space_id: String,
    pub space_name: String,
    pub owner_member_id: String,
    pub fingerprint: String,
}

/// Only these semantic operations may cross from a Member to the execution owner.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostOperation {
    Activity,
    Connection,
    Providers,
    SessionRead,
    SessionControl,
    SessionInspect,
    /// The chat or subagent a transcript names, such as the sender of a message.
    ThreadIdentity,
    SessionHistory,
    SessionMessage,
    SessionRespond,
    /// Stopping a chat's work; Core admits only the Run's requester, the chat's owner or a
    /// Space Owner.
    SessionStop,
    SessionStopTask,
    SessionCancelTask,
    SessionStopBackground,
    SessionBackgroundOutput,
    SessionPromptTurns,
    SessionPromptIndex,
    SessionQueue,
    SessionQueueRead,
    SessionItem,
    /// A range of one attachment a chat's transcript names, read under the Member's invocation.
    SessionAttachment,
    SessionOverview,
    SessionQueuedPreview,
    SessionRunMessage,
    /// A new hosted chat a Member starts, with or without a Project; Core makes them its owner.
    SessionStart,
    /// A new hosted chat from one the Member can read; Core makes that Member its owner.
    SessionFork,
    /// A persistent side chat of a hosted chat the Member may reply to, owned by that Member.
    SessionSideChatCreate,
    /// Delete the Member's own side chat through its execution host.
    SessionSideChatDelete,
    /// Bring a fork or side chat the Member requested back into the chat it came from.
    SessionMergeBack,
    /// Rewrite the Member's own message, while no other Member has posted after it.
    SessionRewriteMessage,
    /// Compact the chat's context, or compact it and continue a failed reply: its steward's.
    SessionCompact,
    /// End the chat's context after its latest Run: its steward's.
    SessionClearContext,
    /// Shared chat changes; Core admits only the chat's owner or a Space Owner.
    SessionRename,
    SessionArchive,
    SessionUnarchive,
    SessionMove,
    WorkStart,
    WorkspaceRefresh,
    CoordinatorOpen,
    /// The host's Inbox settings: the Agents its suggestions and new chats run on. Every Member
    /// reads them; each Member's own consent to start their requests stays in Core.
    InboxSettings,
    InboxReplyDestination,
    InboxSend,
    InboxPrepareConfirmation,
    InboxSkillAvailability,
    InboxConfirm,
    InboxDispatch,
    InboxChatTargets,
    InboxRequestSuggestion,
    InboxStopSuggestion,
    InboxRetryDispatch,
    /// Chats the Member may read that match a query, ranked by the host and bounded.
    ChatSearch,
    /// Those chats matched by their message history, bounded and best effort.
    ChatSearchMessages,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HostCall {
    pub operation: HostOperation,
    pub input: serde_json::Value,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HostRegistration {
    pub instance: String,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HostLease {
    pub token: String,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct HostInvocation {
    pub id: String,
    /// Private, short-lived proof of the Member who admitted this exact call.
    pub credential: String,
    pub call: HostCall,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostCallResult {
    Ok { value: serde_json::Value },
    Error { message: String },
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HostCompletion {
    pub token: String,
    pub id: String,
    pub result: HostCallResult,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct HostAvailability {
    pub available: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InviteRequest {
    pub role: MemberRole,
    #[serde(default)]
    pub member_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct InviteResponse {
    pub url: String,
    pub fingerprint: String,
    pub code: String,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct MemberDevice {
    pub space_id: String,
    pub form_factor: DeviceFormFactor,
    pub id: String,
    pub member_id: String,
    pub label: String,
    pub created_at: i64,
    pub last_seen: i64,
    pub revoked_at: Option<i64>,
    /// The Device receives phone notifications. Its relay handle and key are never listed.
    pub notifications_enabled: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RevokeDeviceRequest {
    pub device_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoveMemberRequest {
    pub member_id: String,
}

/// Display identity belongs to Core; endpoints remain transport coordinates.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct SpaceName {
    pub space_id: String,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameSpaceRequest {
    pub name: String,
}
/// The name other Members see for the requesting Member; never the relative word "You".
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameMemberRequest {
    pub name: String,
}

/// The independently bounded resource which refused remote admission.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RemoteBudget {
    PreAuthIp,
    DeviceRequests,
    DeviceBytes,
    MemberRequests,
    MemberBytes,
    MemberDeviceLinks,
    MemberConcurrency,
    GlobalConcurrency,
    DeviceStreams,
    MemberStreams,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct RemoteBudgetCounter {
    pub requests: u64,
    pub bytes: u64,
    pub peak_requests: u64,
    pub peak_bytes: u64,
    pub refusals: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct RemoteTransportStats {
    pub pre_auth_ips: std::collections::BTreeMap<String, RemoteBudgetCounter>,
    pub members: std::collections::BTreeMap<String, RemoteBudgetCounter>,
    pub devices: std::collections::BTreeMap<String, RemoteBudgetCounter>,
    pub routes: std::collections::BTreeMap<String, u64>,
    pub refusals: std::collections::BTreeMap<String, u64>,
}

/// Presentation metadata never changes a Device's authority.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeviceFormFactor {
    #[default]
    Desktop,
    Phone,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ListenerPeerPolicy {
    #[default]
    Private,
    Operator,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct DeviceLinkOffer {
    pub space_id: String,
    pub space_name: String,
    pub member_id: String,
    pub fingerprint: String,
    pub routes: Vec<String>,
    pub code: String,
    pub expires_at: i64,
}
/// Profile-owned remote listener preference, restored by Core at startup.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteAccessIntent {
    pub enabled: bool,
    pub address: String,
}
impl Default for RemoteAccessIntent {
    fn default() -> Self {
        Self {
            enabled: false,
            address: "0.0.0.0:0".into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct RemoteAccessState {
    pub listener: Option<ListenerInfo>,
    pub intent: RemoteAccessIntent,
    pub routes_changed: bool,
}

/// Core-owned Space kind, independent of listener activation or hosting mode.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpaceKind {
    Personal,
    Team,
}

/// Private local relay events. Core creates identity and proof; a phone cannot choose either.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PhoneHostEvent {
    Open {
        channel_id: String,
        credential: String,
        space_id: String,
        member_id: String,
        device_id: String,
        space_name: String,
        space_kind: SpaceKind,
        routes: Vec<String>,
    },
    Request {
        channel_id: String,
        credential: String,
        id: i64,
        method: String,
        params: serde_json::Value,
    },
    Close {
        channel_id: String,
    },
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhoneHostPublish {
    pub token: String,
    pub channel_id: String,
    pub envelope: serde_json::Value,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhoneResponseRequest {
    pub run_id: Option<String>,
    pub request_id: String,
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhoneResponseEntitlementRequest {
    pub credential: String,
    pub session_id: String,
    pub requests: Vec<PhoneResponseRequest>,
}

/// What a phone wants to hear from this Space, in the phone RPC's own field names.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushPreferences {
    pub needs_you: bool,
    pub finished: bool,
}
/// Where a Device receives notifications: an opaque relay handle and the base64url key that seals
/// them. Both stay between the phone, Core and the local Host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PushRegistration {
    pub handle: String,
    pub key: String,
    pub preferences: PushPreferences,
}
/// Commits the phone's in-flight `push.register` or `push.unregister` request to its own Device.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhonePushCommit {
    pub credential: String,
}
/// Who should hear about a chat event. Core resolves it with the same rule that admits answers.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PhonePushAudience {
    /// A pending question or approval belongs to the Member entitled to answer it.
    Request {
        run_id: Option<String>,
        request: crate::workspace::SessionExecutionRequestKind,
    },
    /// A Run's outcome belongs to the Member who requested it.
    RunRequester { run_id: String },
    /// A chat reminder belongs to the Member who set it, as Core's reminder delivery names them.
    ReminderOwner { member_id: String },
    /// A Page Turn belongs to the Member whose move it is, while that episode is current.
    TurnOwner { page_id: String, episode: String },
}
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhonePushRecipientsRequest {
    pub token: String,
    /// The chat the event happened in; a Page Turn may wait on none.
    #[serde(default)]
    pub session_id: Option<String>,
    pub audience: PhonePushAudience,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct PhonePushRecipient {
    pub device_id: String,
    pub member_id: String,
    pub registration: PushRegistration,
}
/// What a Member's desktop says about its person, about every 30 seconds while someone uses it.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MemberPresenceReport {
    /// Milliseconds since the person last used this Device; absent while its screen is locked or
    /// the system cannot tell.
    pub idle_ms: Option<u32>,
}
/// The local Host asks whether a Member is at one of their computers.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MemberPresenceRequest {
    pub token: String,
    pub member_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct MemberPresence {
    /// The least time since the Member used one of their active Devices that reported within the
    /// last 90 seconds with an unlocked screen; absent when none vouches for them.
    pub idle_ms: Option<u64>,
}
/// The relay reported this handle gone; forget it unless the phone has since replaced it.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PhonePushForget {
    pub token: String,
    pub device_id: String,
    pub handle: String,
}
