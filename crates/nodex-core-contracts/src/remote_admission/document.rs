use super::RemoteAdmission;
use crate::document::{OwnedDocumentIntent, OwnedDocumentRead};

impl RemoteAdmission for OwnedDocumentRead {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::Recovery { .. }
            | Self::Descriptor { .. }
            | Self::SyncYjs { .. }
            | Self::FetchUpdate { .. }
            | Self::ListVersions { .. }
            | Self::GetVersion { .. } => true,
            Self::RecoveryArtifact { .. }
            | Self::CanvasCompactionEligibility { .. }
            | Self::PrepareAgentSemanticMutation { .. }
            | Self::AgentSemanticSnapshot { .. } => false,
        }
    }
}

impl RemoteAdmission for OwnedDocumentIntent {
    fn admits_remote_member(&self) -> bool {
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
            | Self::RestoreVersion { .. } => true,
            Self::ExecutePreparedAgentSemanticMutation { .. }
            | Self::CompactCanvasTombstones { .. }
            | Self::ApplyOwnerCommand { .. } => false,
        }
    }
}
