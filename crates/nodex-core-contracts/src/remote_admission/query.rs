use super::RemoteAdmission;
use crate::query::QueryRead;

impl RemoteAdmission for QueryRead {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::Schema { .. } | Self::Query { .. } => true,
            Self::AgentSchema { .. }
            | Self::AgentQuery { .. }
            | Self::AgentDisplayedViewQuery { .. } => false,
        }
    }
}
