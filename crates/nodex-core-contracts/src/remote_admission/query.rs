use super::{RemoteAccess, RemoteAdmission};
use crate::query::QueryRead;

impl RemoteAdmission for QueryRead {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::Schema { .. } | Self::Query { .. } => RemoteAccess::Participant,
            Self::AgentSchema { .. }
            | Self::AgentQuery { .. }
            | Self::AgentDisplayedViewQuery { .. } => RemoteAccess::Denied,
        }
    }
}
