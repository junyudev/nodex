use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::workspace::ProjectWorkspaceTurnAuthority;

/// Durable identity of the runtime family that owns an Agent conversation.
/// Backend-specific settings live behind their own stable identifiers instead
/// of accumulating nullable fields on Threads and Automations.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentBackendBinding {
    #[default]
    Codex,
    Acp {
        agent_definition_id: String,
        instance_config_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentTurnProvenance {
    pub profile_id: String,
    pub authority: ProjectWorkspaceTurnAuthority,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentProjectResourceAction {
    Read,
    Write,
    CreateChild,
    Move,
    ManageSchema,
    ManageViews,
    ManageDatabase,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentProjectResourceAccess {
    Read,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentResourceAuthorizationReason {
    Allowed,
    ProjectNotFound,
    ResourceNotFound,
    ResourceHierarchyCorrupt,
    LibraryMismatch,
    AuthorityStale,
    GrantMissing,
    ProjectReadOnly,
    GrantReadOnly,
    StructuralCapabilityRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentResourceConsentReason {
    GrantMissing,
    GrantReadOnly,
    LibraryConsentRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentAuthorizationTarget {
    Page { page_id: String },
    Database { database_id: String },
    DataSource { data_source_id: String },
    View { view_id: String },
    Library { library_id: String },
    PageOrBlock { id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentResourceIntent {
    pub target: AgentAuthorizationTarget,
    pub action: AgentProjectResourceAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentResourceGrantRoot {
    Page { page_id: String },
    Database { database_id: String },
    Library { library_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentResourceGrantSpec {
    pub root: AgentResourceGrantRoot,
    pub access: AgentProjectResourceAccess,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub library_actions: Vec<AgentProjectResourceAction>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentResourceAccessOverlayKind {
    Inspection,
    Consent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentResourceAccessOverlayScope {
    Call,
    Task,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentResourceAccessOverlay {
    pub kind: AgentResourceAccessOverlayKind,
    pub scope: AgentResourceAccessOverlayScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    pub root_thread_id: String,
    pub actor_project_id: String,
    pub library_id: String,
    pub store_epoch: String,
    pub grants: Vec<AgentResourceGrantSpec>,
    #[serde(default)]
    pub persist_resulting_page_grants: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentResourceConsentRequirement {
    pub intent: AgentResourceIntent,
    pub grant: AgentResourceGrantSpec,
    pub reason: AgentResourceConsentReason,
    pub persistable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentResourceAccessPlan {
    Authorized {
        #[serde(skip_serializing_if = "Option::is_none")]
        resource_access: Option<AgentResourceAccessOverlay>,
    },
    ConsentRequired {
        requirements: Vec<AgentResourceConsentRequirement>,
        inspection_access: AgentResourceAccessOverlay,
    },
    Denied {
        intent: AgentResourceIntent,
        reason: AgentResourceAuthorizationReason,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentEffectClass {
    Write,
    Destructive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentConsentRequirement {
    None,
    Resource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentResourceKind {
    Library,
    Page,
    Database,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentResourceTarget {
    pub kind: AgentResourceKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentOwnershipTransformation {
    pub resource_id: String,
    pub parent_id: Option<String>,
    pub before_id: Option<String>,
}

/// Stable, user-visible mutation scope. Incidental ranks and internal Document
/// heads deliberately remain outside this value.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentOperationFootprint {
    pub effect_class: AgentEffectClass,
    pub targets: Vec<AgentResourceTarget>,
    pub created_roots: Vec<String>,
    pub updated_roots: Vec<String>,
    pub deleted_roots: Vec<String>,
    pub deleted_owner_roots: Vec<String>,
    pub ownership_transformations: Vec<AgentOwnershipTransformation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentOperationPreparationState {
    Prepared,
    CommittedReplay,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentOperationPreparation {
    pub state: AgentOperationPreparationState,
    pub consent: AgentConsentRequirement,
    pub footprint: AgentOperationFootprint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentExecutionAuthorization {
    pub provenance: AgentTurnProvenance,
    pub call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_access: Option<AgentResourceAccessOverlay>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentPreparedExecution {
    pub authorization: AgentExecutionAuthorization,
    /// Exact receipt replay may omit a token. A new mutation cannot.
    pub token: Option<String>,
}
