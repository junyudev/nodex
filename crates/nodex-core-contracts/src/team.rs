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
    pub space_name: String,
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
