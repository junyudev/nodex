use super::{RemoteAccess, RemoteAdmission};
use crate::administration::{StoreAdministrationIntent, StoreAdministrationRead};

impl RemoteAdmission for StoreAdministrationRead {
    fn remote_access(&self) -> RemoteAccess {
        // Runner administration, backups, restore and maintenance stay host-only.
        match self {
            Self::Status { .. }
            | Self::Backups { .. }
            | Self::BackupJobs { .. }
            | Self::OperationalJournalStatus { .. }
            | Self::MaintenanceStatus { .. }
            | Self::MaintenancePlan { .. } => RemoteAccess::Denied,
        }
    }
}

impl RemoteAdmission for StoreAdministrationIntent {
    fn remote_access(&self) -> RemoteAccess {
        // Runner administration, backups, restore and maintenance stay host-only.
        match self {
            Self::CreateBackup { .. }
            | Self::CoalesceBackup { .. }
            | Self::CancelBackup { .. }
            | Self::RestoreBackup { .. }
            | Self::DeleteBackup { .. }
            | Self::PruneBackups { .. }
            | Self::RunMaintenance { .. } => RemoteAccess::Denied,
        }
    }
}
