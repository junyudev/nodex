use super::{RemoteAccess, RemoteAdmission};
use crate::library::{LibraryIntent, LibraryRead};

impl RemoteAdmission for LibraryRead {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::Discussions { .. }
            | Self::Discussion { .. }
            | Self::Metadata { .. }
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
            | Self::BlockTransferPresentationPlan { .. } => RemoteAccess::Participant,
            Self::DiscussionAskContext { .. }
            | Self::DiscussionBlockWriters { .. }
            | Self::DiscussionInbox { .. }
            | Self::QueuedDiscussionAsks { .. }
            | Self::PreparePageOperation { .. }
            | Self::PageProjectionFile { .. }
            | Self::PageDraftProjection { .. }
            | Self::AcquireSearchSnapshot { .. }
            | Self::ReleaseSearchSnapshot { .. }
            | Self::BlockPage { .. }
            | Self::AgentBlockTarget { .. }
            | Self::AgentSurfaceDescription { .. }
            | Self::AuthorizeAgentSearch { .. }
            | Self::AgentSearch { .. }
            | Self::PrepareAgentPageCopy { .. }
            | Self::PrepareAgentCreatePages { .. }
            | Self::PrepareAgentMovePages { .. } => RemoteAccess::Denied,
        }
    }
}

impl RemoteAdmission for LibraryIntent {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::Discussion { .. } => RemoteAccess::Participant,
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
            | Self::UndoPageRelocation { .. } => RemoteAccess::Member,
            Self::CloseEditorHistoryOwner { .. }
            | Self::MovePages { .. }
            | Self::ExecutePreparedAgentPageCopy { .. }
            | Self::ExecutePreparedAgentCreatePages { .. }
            | Self::ExecutePreparedAgentMovePages { .. } => RemoteAccess::Denied,
        }
    }
}
