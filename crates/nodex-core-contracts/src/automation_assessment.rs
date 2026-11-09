//! Bounded Coordinator judgement. Core supplies policy, scope, target, and authority.
use crate::{automation::Automation, library::AgentWorkSelection};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationAssessmentRequest {
    pub request_id: String,
    pub generation: i64,
    pub thread_id: String,
    pub policy_hash: String,
    pub automations: Vec<Automation>,
    pub trigger_ids: Vec<String>,
    pub coordinator_session_id: Option<String>,
    pub handed_over_at_ms: Option<i64>,
    pub run_started_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationAssessmentResource {
    Triggers,
    Thread,
    Automations,
    Pages,
    Follows,
    Decisions,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationAssessmentRead {
    LaunchAuthority {
        decision_id: String,
    },
    Pending {
        limit: u32,
    },
    Request {
        request_id: String,
    },
    Resource {
        request_id: String,
        generation: i64,
        resource: AutomationAssessmentResource,
        cursor: Option<String>,
        provenance: Box<crate::agent::AgentTurnProvenance>,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationAssessmentReadValue {
    LaunchAuthority {
        valid: bool,
        target: Option<Box<Automation>>,
    },
    Pending {
        requests: Vec<AutomationAssessmentRequest>,
    },
    Request {
        request: Option<AutomationAssessmentRequest>,
    },
    Resource {
        value: serde_json::Value,
        next_cursor: Option<String>,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationAssessment {
    pub automation_id: String,
    pub revision: i64,
    pub matched: bool,
    pub reason: String,
    pub evidence_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationProposedAction {
    pub automation_ids: Vec<String>,
    pub scope: AutomationActionScope,
    pub title: String,
    pub body: String,
    pub execution_target: AgentWorkSelection,
    pub thread_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationActionScope {
    Project { project_id: String },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationAssessmentCommand {
    Begin {
        request_id: String,
        generation: i64,
        coordinator_session_id: String,
    },
    StartRun {
        request_id: String,
        generation: i64,
        coordinator_session_id: String,
        started_at_ms: i64,
    },
    Fail {
        request_id: String,
        generation: i64,
        reason: String,
    },
    Submit {
        request_id: String,
        generation: i64,
        policy_hash: String,
        automation_assessments: Vec<AutomationAssessment>,
        proposed_actions: Vec<AutomationProposedAction>,
    },
}
