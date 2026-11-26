use super::RemoteAdmission;
use crate::automation::{AutomationIntent, AutomationRead};

impl RemoteAdmission for AutomationRead {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::DueWork { .. }
            | Self::AutomationDecisions { .. }
            | Self::AutomationNotificationPolicy { .. }
            | Self::Automations { .. }
            | Self::Automation { .. }
            | Self::AutomationForExecution { .. }
            | Self::Leases { .. }
            | Self::Run { .. }
            | Self::Runs { .. }
            | Self::Inbox { .. }
            | Self::Occurrences { .. }
            | Self::ReminderLeases { .. }
            | Self::ReminderSnoozes { .. } => true,
            Self::AutomationExecutionAdmission { .. }
            | Self::AgentAutomations { .. }
            | Self::AgentAutomation { .. } => false,
        }
    }
}

impl RemoteAdmission for AutomationIntent {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::CreateAutomation { .. }
            | Self::SetAutomationStatus { .. }
            | Self::UpdateAutomation { .. }
            | Self::DeleteAutomation { .. }
            | Self::DispatchNow { .. } => true,
            Self::AgentCommand { .. }
            | Self::RescheduleAutomation { .. }
            | Self::ClaimDue { .. }
            | Self::CompleteLease { .. }
            | Self::FailLease { .. }
            | Self::BeginRun { .. }
            | Self::RecordHistoricalRun { .. }
            | Self::BindRunSession { .. }
            | Self::SetRunSessionTitle { .. }
            | Self::CompleteRunForReview { .. }
            | Self::SetRunInboxItem { .. }
            | Self::AcceptRun { .. }
            | Self::SetRunReadState { .. }
            | Self::MarkAllRunsRead { .. }
            | Self::ArchiveRun { .. }
            | Self::UnarchiveRun { .. }
            | Self::DeleteRun { .. }
            | Self::SettleInterruptedRuns { .. }
            | Self::SnoozeReminder { .. }
            | Self::ClaimDueReminders { .. }
            | Self::CompleteReminderLease { .. }
            | Self::FailReminderLease { .. }
            | Self::CompletePageOccurrence { .. }
            | Self::SkipPageOccurrence { .. }
            | Self::UpdatePageOccurrence { .. } => false,
        }
    }
}
