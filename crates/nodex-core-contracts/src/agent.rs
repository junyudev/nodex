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
    Claude {
        instance_config_id: String,
    },
    #[serde(rename = "opencode")]
    OpenCode {
        instance_config_id: String,
    },
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentEffectClass {
    Write,
    Destructive,
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AgentPreparedExecution {
    pub authorization: AgentExecutionAuthorization,
    /// Exact receipt replay may omit a token. A new mutation cannot.
    pub token: Option<String>,
}
