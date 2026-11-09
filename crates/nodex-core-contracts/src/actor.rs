use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Core-authored identity of a mutation. Transport, origin and execution Project
/// are independent coordinates and cannot stand in for a person.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Actor {
    Member {
        member_id: String,
    },
    Agent {
        session_id: String,
        run_id: Option<String>,
        on_behalf_of: String,
    },
    Service {
        kind: ServiceKind,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    Sources,
    Automations,
    Scheduler,
    InboxRouting,
    AgentRuntime,
    Maintenance,
    Notifications,
    Membership,
}

impl Actor {
    pub fn member_id(&self) -> Option<&str> {
        match self {
            Self::Member { member_id } => Some(member_id),
            Self::Agent { on_behalf_of, .. } => Some(on_behalf_of),
            Self::Service { .. } => None,
        }
    }
}
