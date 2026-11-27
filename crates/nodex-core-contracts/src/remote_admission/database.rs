use super::{RemoteAccess, RemoteAdmission};
use crate::database::{DatabaseIntent, DatabaseRead};

impl RemoteAdmission for DatabaseRead {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::ViewPersonalPreferences { .. }
            | Self::ViewCollapsedOccurrences { .. }
            | Self::WorkContext { .. }
            | Self::CatalogWindow { .. }
            | Self::Database { .. }
            | Self::PageKeyPrefixPreview { .. }
            | Self::PageKeyNamespace { .. }
            | Self::DataSourceWindow { .. }
            | Self::DataSource { .. }
            | Self::PropertyWindow { .. }
            | Self::OptionWindow { .. }
            | Self::PageLayout { .. }
            | Self::ViewDescriptorWindow { .. }
            | Self::View { .. }
            | Self::DataSourceQuery { .. }
            | Self::ViewWindow { .. }
            | Self::ListWindow { .. }
            | Self::ViewGroups { .. }
            | Self::ViewContext { .. }
            | Self::RowsById { .. }
            | Self::RowDetail { .. }
            | Self::ReadyWork { .. }
            | Self::Blocking { .. }
            | Self::Prerequisites { .. }
            | Self::RelationTargetWindow { .. }
            | Self::RelationCandidateWindow { .. } => RemoteAccess::Participant,
            Self::AgentDataSourceQuery { .. } | Self::AgentViewQuery { .. } => RemoteAccess::Denied,
        }
    }
}

impl RemoteAdmission for DatabaseIntent {
    fn remote_access(&self) -> RemoteAccess {
        match self {
            Self::PutViewPersonalPreferences { .. }
            | Self::SetViewOccurrenceDisclosure { .. }
            | Self::Configure { .. }
            | Self::RenamePageKeyPrefix { .. }
            | Self::PutProperty { .. }
            | Self::MoveProperty { .. }
            | Self::ChangePropertyType { .. }
            | Self::DuplicateProperty { .. }
            | Self::RestoreProperty { .. }
            | Self::PermanentlyDeleteProperty { .. }
            | Self::DeleteProperty { .. }
            | Self::PutOption { .. }
            | Self::MoveOption { .. }
            | Self::DeleteOption { .. }
            | Self::DeleteOptionAndClearValues { .. }
            | Self::PutPageLayoutEntry { .. }
            | Self::EditPropertyValues { .. }
            | Self::TransferPage { .. }
            | Self::PutView { .. }
            | Self::DuplicateView { .. }
            | Self::ChangeViewLayout { .. }
            | Self::MoveView { .. }
            | Self::DeleteView { .. }
            | Self::PositionPage { .. }
            | Self::PositionPages { .. }
            | Self::SetTaskParent { .. }
            | Self::MoveListOccurrences { .. }
            | Self::UndoListOccurrenceMove { .. }
            | Self::ReverseDataEdit { .. } => RemoteAccess::Member,
            Self::SetPageProperties { .. } | Self::ApplyPagePropertyEdits { .. } => {
                RemoteAccess::Denied
            }
        }
    }
}
