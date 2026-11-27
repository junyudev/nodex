use super::{RemoteAccess, RemoteAdmission};
use crate::document::{OwnedDocumentIntent, OwnedDocumentRead};

impl RemoteAdmission for OwnedDocumentRead {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::Recovery { .. }
            | Self::Descriptor { .. }
            | Self::SyncYjs { .. }
            | Self::FetchUpdate { .. }
            | Self::ListVersions { .. }
            | Self::GetVersion { .. } => RemoteAccess::Participant,
            Self::RecoveryArtifact { .. }
            | Self::CanvasCompactionEligibility { .. }
            | Self::PrepareAgentSemanticMutation { .. }
            | Self::AgentSemanticSnapshot { .. } => RemoteAccess::Denied,
        }
    }
}

impl RemoteAdmission for OwnedDocumentIntent {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::CaptureRecovery { .. }
            | Self::ResolveRecovery { .. }
            | Self::PrepareOwner { .. }
            | Self::ApplyYjsUpdate { .. }
            | Self::ApplySemanticMutation { .. }
            | Self::ApplyOperationBatch { .. }
            | Self::ReplaceFromMarkdown { .. }
            | Self::ApplyCanvasMutation { .. }
            | Self::CreateCheckpoint { .. }
            | Self::RestoreVersion { .. } => RemoteAccess::Member,
            Self::ExecutePreparedAgentSemanticMutation { .. }
            | Self::CompactCanvasTombstones { .. }
            | Self::ApplyOwnerCommand { .. } => RemoteAccess::Denied,
        }
    }
}
