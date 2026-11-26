use super::RemoteAdmission;
use crate::administration::{StoreAdministrationIntent, StoreAdministrationRead};

impl RemoteAdmission for StoreAdministrationRead {
    fn admits_remote_member(&self) -> bool {
        // Runner administration, backups, restore and maintenance stay host-only.
        match self {
            Self::Status { .. }
            | Self::Backups { .. }
            | Self::BackupJobs { .. }
            | Self::OperationalJournalStatus { .. }
            | Self::MaintenanceStatus { .. }
            | Self::MaintenancePlan { .. } => false,
        }
    }
}

impl RemoteAdmission for StoreAdministrationIntent {
    fn admits_remote_member(&self) -> bool {
        // Runner administration, backups, restore and maintenance stay host-only.
        match self {
            Self::CreateBackup { .. }
            | Self::CoalesceBackup { .. }
            | Self::CancelBackup { .. }
            | Self::RestoreBackup { .. }
            | Self::DeleteBackup { .. }
            | Self::PruneBackups { .. }
            | Self::RunMaintenance { .. } => false,
        }
    }
}
