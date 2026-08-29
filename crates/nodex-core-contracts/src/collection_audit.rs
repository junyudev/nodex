//! Compile-time inventory of every public Core read shape.
//!
//! A new read variant must be deliberately assigned one of these budget
//! policies before this crate's tests compile. This is intentionally an
//! exhaustive match rather than a source-text assertion: it audits the
//! protocol surface and makes the review obligation follow the type.

use crate::administration::StoreAdministrationRead;
use crate::automation::AutomationRead;
use crate::database::DatabaseRead;
use crate::document::OwnedDocumentRead;
use crate::library::LibraryRead;
use crate::workspace::ProjectWorkspaceRead;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadBudgetPolicy {
    /// A cursor-reachable collection whose response is assembled under the
    /// ordinary collection item and encoded-byte budgets.
    CollectionWindow,
    /// A single entity or fixed-size status/projection read.
    Identity,
    /// Caller supplies a collection with an ingress count/byte bound.
    BoundedBatch,
    /// The domain itself has an enforced finite cardinality/depth.
    FixedDomain,
    /// A deliberately wide object using an identity-scoped Document, binary,
    /// or file-lease transport.
    LargeObject,
}

fn workspace_policy(read: &ProjectWorkspaceRead) -> ReadBudgetPolicy {
    match read {
        ProjectWorkspaceRead::ProjectWindow { .. }
        | ProjectWorkspaceRead::TaskWindow { .. }
        | ProjectWorkspaceRead::SidebarOverview { .. }
        | ProjectWorkspaceRead::ChildThreadWindow { .. }
        | ProjectWorkspaceRead::BackgroundProcessWindow { .. }
        | ProjectWorkspaceRead::ManagedWorktreeWindow { .. }
        | ProjectWorkspaceRead::PageChatWindow { .. }
        | ProjectWorkspaceRead::SidebarSectionWindow { .. }
        | ProjectWorkspaceRead::SidebarSectionItemWindow { .. }
        | ProjectWorkspaceRead::SidebarSectionHostLinkWindow { .. } => {
            ReadBudgetPolicy::CollectionWindow
        }
        ProjectWorkspaceRead::ProjectActivitySummaries { .. }
        | ProjectWorkspaceRead::PageChatActivitySummaries { .. } => ReadBudgetPolicy::BoundedBatch,
        ProjectWorkspaceRead::ManagedWorktreeLifecycleSnapshot => ReadBudgetPolicy::FixedDomain,
        ProjectWorkspaceRead::ProjectBootstrap
        | ProjectWorkspaceRead::Project { .. }
        | ProjectWorkspaceRead::ProjectPermissionMode { .. }
        | ProjectWorkspaceRead::ProjectlessPermissionMode
        | ProjectWorkspaceRead::Session { .. }
        | ProjectWorkspaceRead::Thread { .. }
        | ProjectWorkspaceRead::QueuedFollowUpLedger { .. }
        | ProjectWorkspaceRead::ExecutionContext { .. }
        | ProjectWorkspaceRead::TurnAuthority { .. }
        | ProjectWorkspaceRead::SidebarSectionPlacement { .. } => ReadBudgetPolicy::Identity,
    }
}

fn database_policy(read: &DatabaseRead) -> ReadBudgetPolicy {
    match read {
        DatabaseRead::CatalogWindow { .. }
        | DatabaseRead::DataSourceWindow { .. }
        | DatabaseRead::PropertyWindow { .. }
        | DatabaseRead::OptionWindow { .. }
        | DatabaseRead::ViewDescriptorWindow { .. }
        | DatabaseRead::AgentDataSourceQuery { .. }
        | DatabaseRead::AgentViewQuery { .. }
        | DatabaseRead::ViewWindow { .. }
        | DatabaseRead::ListWindow { .. }
        | DatabaseRead::ViewContext { .. }
        | DatabaseRead::RelationTargetWindow { .. }
        | DatabaseRead::RelationCandidateWindow { .. } => ReadBudgetPolicy::CollectionWindow,
        DatabaseRead::RowsById { .. } => ReadBudgetPolicy::BoundedBatch,
        DatabaseRead::PageKeyPrefixPreview { .. } | DatabaseRead::PageKeyNamespace { .. } => {
            ReadBudgetPolicy::Identity
        }
        // Group summaries are capped at MAX_VIEW_GROUP_SUMMARIES with an
        // explicit truncation flag, so the response cardinality is finite.
        DatabaseRead::ViewGroups { .. } => ReadBudgetPolicy::FixedDomain,
        DatabaseRead::Database { .. }
        | DatabaseRead::DataSource { .. }
        | DatabaseRead::View { .. }
        | DatabaseRead::ViewPersonalPresentation { .. }
        | DatabaseRead::ViewCollapsedOccurrences { .. }
        | DatabaseRead::RowDetail { .. } => ReadBudgetPolicy::Identity,
    }
}

fn automation_policy(read: &AutomationRead) -> ReadBudgetPolicy {
    match read {
        AutomationRead::Definitions { .. }
        | AutomationRead::Leases { .. }
        | AutomationRead::Runs { .. }
        | AutomationRead::Inbox { .. }
        | AutomationRead::Occurrences { .. }
        | AutomationRead::ReminderLeases { .. }
        | AutomationRead::ReminderSnoozes { .. } => ReadBudgetPolicy::CollectionWindow,
        AutomationRead::DueWork { .. }
        | AutomationRead::Definition { .. }
        | AutomationRead::Run { .. } => ReadBudgetPolicy::Identity,
    }
}

fn administration_policy(read: &StoreAdministrationRead) -> ReadBudgetPolicy {
    match read {
        StoreAdministrationRead::Backups { .. } => ReadBudgetPolicy::CollectionWindow,
        StoreAdministrationRead::Status
        | StoreAdministrationRead::BackupJobs
        | StoreAdministrationRead::OperationalJournalStatus
        | StoreAdministrationRead::MaintenanceStatus
        | StoreAdministrationRead::MaintenancePlan { .. } => ReadBudgetPolicy::Identity,
    }
}

fn document_policy(read: &OwnedDocumentRead) -> ReadBudgetPolicy {
    match read {
        OwnedDocumentRead::ListVersions { .. }
        | OwnedDocumentRead::AgentSemanticSnapshot { .. } => ReadBudgetPolicy::CollectionWindow,
        OwnedDocumentRead::Descriptor { .. }
        | OwnedDocumentRead::GetVersion { .. }
        | OwnedDocumentRead::CanvasCompactionEligibility { .. } => ReadBudgetPolicy::Identity,
        OwnedDocumentRead::PrepareAgentSemanticMutation { .. } => ReadBudgetPolicy::BoundedBatch,
        OwnedDocumentRead::SyncYjs { .. } | OwnedDocumentRead::FetchUpdate { .. } => {
            ReadBudgetPolicy::LargeObject
        }
    }
}

fn library_policy(read: &LibraryRead) -> ReadBudgetPolicy {
    match read {
        LibraryRead::Children { .. }
        | LibraryRead::StandaloneRoots { .. }
        | LibraryRead::Catalog { .. }
        | LibraryRead::MoveDestinations { .. }
        | LibraryRead::AgentSearch { .. }
        | LibraryRead::Search { .. }
        | LibraryRead::PageFiles { .. }
        | LibraryRead::PageFileVersions { .. }
        | LibraryRead::PageHistory { .. }
        | LibraryRead::PageBacklinks { .. } => ReadBudgetPolicy::CollectionWindow,
        LibraryRead::Path { .. } | LibraryRead::PageOwnershipPath { .. } => {
            ReadBudgetPolicy::FixedDomain
        }
        LibraryRead::ProjectPageSearch { .. }
        | LibraryRead::ProjectPageSearchFacets { .. }
        | LibraryRead::ProjectPageSearchMetadata { .. }
        | LibraryRead::PageReferenceCandidates { .. }
        | LibraryRead::PlanAgentResourceAccess { .. }
        | LibraryRead::PrepareAgentPageCopy { .. }
        | LibraryRead::PrepareAgentCreatePages { .. }
        | LibraryRead::PrepareAgentMovePages { .. } => ReadBudgetPolicy::BoundedBatch,
        LibraryRead::PageContent { .. } | LibraryRead::PageProjectionFile { .. } => {
            ReadBudgetPolicy::LargeObject
        }
        LibraryRead::Metadata
        | LibraryRead::ResourceProjectAccess { .. }
        | LibraryRead::FilterProjectionImpactForProject { .. }
        | LibraryRead::PageDetail { .. }
        | LibraryRead::PageFileMetadata { .. }
        | LibraryRead::PageDraftProjection { .. }
        | LibraryRead::AcquireSearchSnapshot { .. }
        | LibraryRead::ReleaseSearchSnapshot { .. }
        | LibraryRead::AgentBlockTarget { .. }
        | LibraryRead::PageTarget { .. }
        | LibraryRead::PageKeyTarget { .. }
        | LibraryRead::CanvasTarget { .. }
        | LibraryRead::PageMentionDestination { .. }
        | LibraryRead::PageLocation { .. }
        | LibraryRead::ViewLocation { .. }
        | LibraryRead::PageLifecyclePreflight { .. } => ReadBudgetPolicy::Identity,
    }
}

#[test]
fn every_read_variant_has_an_explicit_budget_policy() {
    assert_eq!(
        database_policy(&DatabaseRead::CatalogWindow {
            window: Default::default(),
        }),
        ReadBudgetPolicy::CollectionWindow
    );
    assert_eq!(
        workspace_policy(&ProjectWorkspaceRead::Project {
            project_id: "project:audit".to_owned(),
        }),
        ReadBudgetPolicy::Identity
    );
    assert_eq!(
        workspace_policy(&ProjectWorkspaceRead::SidebarSectionItemWindow {
            section_id: "section:audit".to_owned(),
            include_archived: Some(false),
            window: Default::default(),
        }),
        ReadBudgetPolicy::CollectionWindow
    );
    assert_eq!(
        automation_policy(&AutomationRead::Inbox {
            window: Default::default(),
        }),
        ReadBudgetPolicy::CollectionWindow
    );
    assert_eq!(
        administration_policy(&StoreAdministrationRead::Status),
        ReadBudgetPolicy::Identity
    );
    assert_eq!(
        document_policy(&OwnedDocumentRead::SyncYjs {
            document_id: "document:audit".to_owned(),
            state_vector: Vec::new(),
        }),
        ReadBudgetPolicy::LargeObject
    );
    assert_eq!(
        library_policy(&LibraryRead::Metadata),
        ReadBudgetPolicy::Identity
    );
}
