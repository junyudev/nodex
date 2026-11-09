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
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct ListenerInfo {
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
    /// A temporary side chat of a hosted chat the Member may reply to, requested by that Member.
    SessionSideChatCreate,
    /// Keep the Member's own side chat as a hosted chat of its own.
    SessionSideChatSave,
    /// Close the Member's own side chat.
    SessionSideChatDiscard,
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
    pub id: String,
    pub member_id: String,
    pub label: String,
    pub created_at: i64,
    pub last_seen: i64,
    pub revoked_at: Option<i64>,
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
