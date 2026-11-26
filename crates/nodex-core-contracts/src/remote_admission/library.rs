use super::RemoteAdmission;
use crate::library::{LibraryIntent, LibraryRead};

impl RemoteAdmission for LibraryRead {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::Metadata { .. }
            | Self::LocalMember { .. }
            | Self::Members { .. }
            | Self::Files { .. }
            | Self::File { .. }
            | Self::FilePresentation { .. }
            | Self::FileUsages { .. }
            | Self::FileVersions { .. }
            | Self::PageFileInventory { .. }
            | Self::ResolvePageFile { .. }
            | Self::Children { .. }
            | Self::StandaloneRoots { .. }
            | Self::Path { .. }
            | Self::Catalog { .. }
            | Self::MoveDestinations { .. }
            | Self::PageRelocationDestinations { .. }
            | Self::PageMentionDestination { .. }
            | Self::PageDetail { .. }
            | Self::PageContent { .. }
            | Self::PageTarget { .. }
            | Self::PageKeyTarget { .. }
            | Self::ResourceLocation { .. }
            | Self::PageLocation { .. }
            | Self::CanvasTarget { .. }
            | Self::ViewLocation { .. }
            | Self::PageLifecyclePreflight { .. }
            | Self::ProjectPageSearch { .. }
            | Self::ProjectBlockSearch { .. }
            | Self::ProjectPageSearchMetadata { .. }
            | Self::PageReferenceCandidates { .. }
            | Self::PageBacklinks { .. }
            | Self::PageHistory { .. }
            | Self::StructuralHistoryStates { .. }
            | Self::BlockTransferPresentationPlan { .. } => true,
            Self::PreparePageOperation { .. }
            | Self::PageProjectionFile { .. }
            | Self::PageDraftProjection { .. }
            | Self::AcquireSearchSnapshot { .. }
            | Self::ReleaseSearchSnapshot { .. }
            | Self::AgentBlockTarget { .. }
            | Self::AgentSurfaceDescription { .. }
            | Self::AuthorizeAgentSearch { .. }
            | Self::AgentSearch { .. }
            | Self::PrepareAgentPageCopy { .. }
            | Self::PrepareAgentCreatePages { .. }
            | Self::PrepareAgentMovePages { .. } => false,
        }
    }
}

impl RemoteAdmission for LibraryIntent {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::PutPageFileEntry { .. }
            | Self::ApplyPageFileEntries { .. }
            | Self::TransferPageFileEntry { .. }
            | Self::ApplyFileChange { .. }
            | Self::CreatePage { .. }
            | Self::CreatePageMention { .. }
            | Self::CreatePagesFromText { .. }
            | Self::CreatePageFromText { .. }
            | Self::CreateDatabase { .. }
            | Self::CreateCanvas { .. }
            | Self::RenameCanvas { .. }
            | Self::MoveCanvas { .. }
            | Self::DuplicateCanvas { .. }
            | Self::DeleteCanvas { .. }
            | Self::CopyPage { .. }
            | Self::DuplicatePage { .. }
            | Self::MovePage { .. }
            | Self::DeletePage { .. }
            | Self::MoveBlock { .. }
            | Self::ArchiveResource { .. }
            | Self::RestoreResource { .. }
            | Self::ApplyPageLifecycle { .. }
            | Self::ApplyBlockPropertyMutation { .. }
            | Self::ApplyPageMetadataProperties { .. }
            | Self::ApplyStructuralEdit { .. }
            | Self::ReverseStructuralEdit { .. }
            | Self::TransferBlocks { .. }
            | Self::UndoBlockTransfer { .. }
            | Self::UndoPageRelocation { .. } => true,
            Self::CloseEditorHistoryOwner { .. }
            | Self::MovePages { .. }
            | Self::ExecutePreparedAgentPageCopy { .. }
            | Self::ExecutePreparedAgentCreatePages { .. }
            | Self::ExecutePreparedAgentMovePages { .. } => false,
        }
    }
}
