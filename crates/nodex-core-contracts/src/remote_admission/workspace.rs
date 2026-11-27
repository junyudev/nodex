use super::RemoteAdmission;
use crate::inbox::{InboxConfirmedBy, ProjectWorkspaceInboxSource};
use crate::sources::{SourceCommand, SourceRead};
use crate::workspace::{ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead};

impl RemoteAdmission for ProjectWorkspaceRead {
    fn admits_remote_member(&self) -> bool {
        match self {
            Self::InboxSnoozeNotifications { for_push, .. } => !*for_push,
            Self::Sources { read, .. } => match read {
                SourceRead::Sources { .. }
                | SourceRead::Positions { .. }
                | SourceRead::Threads { .. }
                | SourceRead::Triggers { .. }
                | SourceRead::OpenProblems { .. }
                | SourceRead::KnownPullRequests { .. }
                | SourceRead::PageFollows { .. }
                | SourceRead::GitHubThreadLinks { .. }
                | SourceRead::Deliveries { .. } => true,
                SourceRead::EventAutomationWatching { .. }
                | SourceRead::ChannelOutbox { .. }
                | SourceRead::DeliveryBatches { .. } => false,
            },
            Self::InboxRoutingConsent { .. }
            | Self::InboxTurnNotifications { .. }
            | Self::ActivityWindow { .. }
            | Self::ExecutionHolds { .. }
            | Self::EffectiveExecutionHold { .. }
            | Self::PageWorkspace { .. }
            | Self::PageTurn { .. }
            | Self::PageTurns { .. }
            | Self::PageWorkLaunch { .. }
            | Self::DecisionRun { .. }
            | Self::ManagedChat { .. }
            | Self::ProjectBootstrap { .. }
            | Self::ProjectWindow { .. }
            | Self::Project { .. }
            | Self::ProjectActivitySummaries { .. }
            | Self::SessionLinkedPageSummaries { .. }
            | Self::SessionSidebarPlacements { .. }
            | Self::PageChatActivitySummaries { .. }
            | Self::PageChatWindow { .. }
            | Self::SessionWindow { .. }
            | Self::AgentRuntimeSessionBinding { .. }
            | Self::AgentRuntimeSessionBindingByExecution { .. }
            | Self::AgentRuntimeSessionIdsByExecution { .. }
            | Self::AgentRuntimeSessionBindingWindow { .. }
            | Self::SessionWorkPage { .. }
            | Self::TaskWindow { .. }
            | Self::TaskWindows { .. }
            | Self::SidebarOverview { .. }
            | Self::SidebarSectionWindow { .. }
            | Self::SidebarSectionItemWindow { .. }
            | Self::BuiltinSidebarOrder { .. }
            | Self::SidebarSectionPlacement { .. }
            | Self::Session { .. }
            | Self::SessionDetail { .. }
            | Self::SessionSideChats { .. }
            | Self::SessionStart { .. }
            | Self::InboxEntry { .. }
            | Self::InboxMessage { .. }
            | Self::InboxDispatchContext { .. }
            | Self::InboxSummary { .. }
            | Self::InboxCounts { .. }
            | Self::InboxWindow { .. }
            | Self::SessionFollowUps { .. }
            | Self::InboxChatTargets { .. }
            | Self::InboxMessageEdit { .. }
            | Self::SessionMemberActions { .. } => true,
            // A Member's Dock counts their own unread chats in the Space.
            Self::UnreadChatCount { .. } => true,
            Self::AutomationAssessments { .. }
            | Self::HeldSessionWindow { .. }
            | Self::SessionExecutionObserver { .. }
            | Self::SessionExecutionObservers { .. }
            | Self::SessionWorkspace { .. }
            | Self::PageWorkspaceWindow { .. }
            | Self::PageWorkspaceConsumers { .. }
            | Self::PageWorkOutbox { .. }
            | Self::DecisionRunReservations { .. }
            | Self::RetiredDecisionRuns { .. }
            | Self::NextSessionSnooze { .. }
            | Self::QueuedMessageState { .. }
            | Self::ThreadReadState { .. }
            | Self::SidebarSectionHostLinkWindow { .. }
            | Self::AgentRuntimeSessionBindingByThread { .. }
            | Self::AgentRuntimeExecutionCleanupWindow { .. }
            | Self::AgentAuthority { .. }
            | Self::AgentSession { .. }
            | Self::CodexThreadSession { .. }
            | Self::Thread { .. }
            | Self::ThreadBackendSession { .. }
            | Self::NativeSessionBindings { .. }
            | Self::ChildThreadWindow { .. }
            | Self::SubagentOverviewWindow { .. }
            | Self::SubagentOverviewItem { .. }
            | Self::ExecutionContext { .. }
            | Self::TurnAuthority { .. }
            | Self::BackgroundProcessWindow { .. }
            | Self::ManagedWorktreeWindow { .. }
            | Self::ManagedWorktreeLifecycleSnapshot { .. }
            | Self::ChatMessageInbound { .. }
            | Self::NextInboxSnooze { .. }
            | Self::CurrentTurnNotifications { .. }
            | Self::InboxAutomaticDispatches { .. }
            | Self::InboxSuggestionRequest { .. }
            | Self::InboxSuggestionRequests { .. }
            | Self::InboxPendingSuggestionRequestIds { .. }
            | Self::InboxPendingSuggestions { .. }
            | Self::InboxDispatchOutbox { .. } => false,
        }
    }
}

impl RemoteAdmission for ProjectWorkspaceIntent {
    fn admits_remote_member(&self) -> bool {
        match self {
            // Ingress additionally requires the exact live execution-owner message proof.
            Self::RecordChatDelivery { author, .. } => match author {
                ProjectWorkspaceInboxSource::User { .. } => true,
                ProjectWorkspaceInboxSource::Github { .. }
                | ProjectWorkspaceInboxSource::Nodex { .. }
                | ProjectWorkspaceInboxSource::Agent { .. }
                | ProjectWorkspaceInboxSource::CommandLine { .. }
                | ProjectWorkspaceInboxSource::Automation { .. } => false,
            },
            Self::Source { command, .. } => match command {
                SourceCommand::RetryProblem { .. } | SourceCommand::ReplyToOrigin { .. } => true,
                SourceCommand::ClaimChannelSend { .. }
                | SourceCommand::SettleChannelSend { .. }
                | SourceCommand::RecordThreadDeliveryFailure { .. }
                | SourceCommand::FollowThread { .. }
                | SourceCommand::PrepareThreadDeliveryBatch { .. }
                | SourceCommand::BeginThreadDeliveryBatch { .. }
                | SourceCommand::SettleThreadDeliveryBatch { .. }
                | SourceCommand::InvalidateThreadDelivery { .. }
                | SourceCommand::ConfigureSource { .. }
                | SourceCommand::ClaimSourcePartition { .. }
                | SourceCommand::IngestSourceBatch { .. }
                | SourceCommand::RecordSourceFailure { .. }
                | SourceCommand::RecordSourceSuccess { .. } => false,
            },
            Self::ClaimInboxSnoozeNotification { for_push, .. } => !*for_push,
            Self::ConfirmInboxDispatch { confirmed_by, .. } => match confirmed_by {
                InboxConfirmedBy::User { .. } => true,
                InboxConfirmedBy::Nodex { .. } => false,
            },
            // Core ingress additionally requires the exact live Host launch proof: a phone's new chat,
            // or a Member's fork or side chat through the Space host.
            Self::CreateAgentRuntimeSession { decision_run, .. } => decision_run.is_none(),
            // Accepted messages additionally require their exact live execution-owner delivery proof;
            // renaming and archiving require the chat's owner or a Space Owner. Unread state,
            // pins, snoozes, settlement and a chat coming back to them are the requesting Member's own.
            Self::MutateSession { intent, .. } => match intent {
                ProjectSessionIntent::SetUnread { .. }
                | ProjectSessionIntent::SetPinned { .. }
                | ProjectSessionIntent::SetSnooze { .. }
                | ProjectSessionIntent::RecordAttention { .. }
                | ProjectSessionIntent::RecordUserMessage { .. }
                | ProjectSessionIntent::SetArchived { .. }
                | ProjectSessionIntent::Rename { .. } => true,
                ProjectSessionIntent::RecordOpened { .. }
                | ProjectSessionIntent::ConsumeSnooze { .. }
                | ProjectSessionIntent::CompleteSnoozeDelivery { .. }
                | ProjectSessionIntent::DeferSnoozeDelivery { .. }
                | ProjectSessionIntent::RecordAgentMessage { .. }
                | ProjectSessionIntent::SetFallbackTitle { .. }
                | ProjectSessionIntent::LinkThread { .. }
                | ProjectSessionIntent::UnlinkThread { .. }
                | ProjectSessionIntent::LinkPage { .. }
                | ProjectSessionIntent::HandOffPage { .. }
                | ProjectSessionIntent::UnlinkPage { .. } => false,
            },
            // Only the Member's own side chat, through its exact live Host delete call.
            Self::DeleteSession { .. } => true,
            // Core's writer lets a remote Member place only their own pins.
            Self::MoveSession { .. } | Self::PlaceSession { .. } => true,
            // A Member opens a default draft of their own; Core keeps each Member's draft theirs.
            Self::EnsureDefaultDraftSession { .. } => true,
            // A Member finishes only their own idle chats.
            Self::SettleIdleSessions { .. } | Self::SetSessionsSettled { .. } => true,
            Self::SetInboxRoutingConsent { .. }
            | Self::ClaimTurnNotification { .. }
            | Self::ReplyToPageTurn { .. }
            | Self::PauseWork { .. }
            | Self::ResumeWork { .. }
            | Self::StartPageWork { .. }
            | Self::AcceptPageWork { .. }
            | Self::SendInboxMessage { .. }
            | Self::DeleteInboxMessages { .. }
            | Self::DispatchInboxEntries { .. }
            | Self::EnsureInboxNotes { .. }
            | Self::RequestInboxSuggestion { .. }
            | Self::StopInboxSuggestion { .. }
            | Self::RetryInboxDispatch { .. }
            | Self::KeepInboxEntries { .. }
            | Self::SetInboxSnooze { .. }
            | Self::WakeInboxEntries { .. }
            | Self::MarkInboxMessagesDone { .. }
            | Self::ReturnInboxMessages { .. }
            | Self::SetInboxEntryKind { .. }
            | Self::SetInboxEntryImportant { .. }
            | Self::EditInboxMessage { .. }
            | Self::UndoInboxDecision { .. }
            | Self::ReviseInboxMessage { .. } => true,
            // Agent-authored context and Host interruption delivery never become Member commands.
            Self::AnswerInboxQuestion { .. }
            // Only the Host records that it could not prepare a requested start.
            | Self::RecordInboxStartPreparationFailure { .. }
            | Self::HandBackMessage { .. }
            | Self::BindChatInbound { .. }
            | Self::AutomationAssessment { .. }
            | Self::RecordSessionExecution { .. }
            | Self::ClaimPageWorkspace { .. }
            | Self::BindPageWorkspace { .. }
            | Self::RecordPageWorkspaceReady { .. }
            | Self::RecordPageWorkspaceFailed { .. }
            | Self::RequestPageWorkspaceCleanup { .. }
            | Self::MarkPageWorkspaceRemoved { .. }
            | Self::UpsertPagePullRequest { .. }
            | Self::SettlePageWorkLaunch { .. }
            | Self::ReportPageWork { .. }
            | Self::CreatePageFor { .. }
            | Self::SetQueuedMessageState { .. }
            | Self::SelectThreadReadStateIdentity { .. }
            | Self::SetIdentityThreadUnread { .. }
            | Self::ClearIdentityThreadReadState { .. }
            | Self::AgentCommand { .. }
            | Self::CreateProject { .. }
            | Self::UpdateProject { .. }
            | Self::SetProjectLifecycle { .. }
            | Self::ReorderProjects { .. }
            | Self::ReorderPinnedProjects { .. }
            | Self::SetProjectPinned { .. }
            | Self::CreateSidebarSection { .. }
            | Self::RenameSidebarSection { .. }
            | Self::DeleteSidebarSection { .. }
            | Self::RestoreSidebarSection { .. }
            | Self::MoveSidebarSectionItem { .. }
            | Self::ReorderSidebarSectionItems { .. }
            | Self::ReorderBuiltinSidebarItems { .. }
            | Self::PrioritizeBuiltinSidebarProjects { .. }
            | Self::ReorderSidebarSectionSessions { .. }
            | Self::ReorderSidebarSections { .. }
            | Self::ArchiveSidebarSectionSessions { .. }
            | Self::UpsertSidebarSectionHostLink { .. }
            | Self::DeleteSidebarSectionHostLink { .. }
            | Self::CreateSession { .. }
            | Self::AcknowledgeDecisionRunStopped { .. }
            | Self::AdoptNativeSessionExecution { .. }
            | Self::AdmitSessionHandoff { .. }
            | Self::CreateSessionInSidebarSection { .. }
            | Self::BindChatFolder { .. }
            | Self::ResetChatFolder { .. }
            | Self::RecordSessionActivity { .. }
            | Self::UpsertThread { .. }
            | Self::UpdateThread { .. }
            | Self::SetThreadExecutionLocation { .. }
            | Self::EnsureCodexThreadSession { .. }
            | Self::ObserveCodexThreadMetadata { .. }
            | Self::AttachNativeSession { .. }
            | Self::BindThreadBackendSession { .. }
            | Self::ClearThreadBackendSession { .. }
            | Self::DeleteThread { .. }
            | Self::RetainThreadAssets { .. }
            | Self::ObserveAppServerThreadWindow { .. }
            | Self::ReconcileAppServerThreadSweep { .. }
            | Self::ObserveSubagentDiscoveryPage { .. }
            | Self::ObserveSubagentStatusEvidence { .. }
            | Self::BufferSubagentStatusEvidence { .. }
            | Self::SetThreadArchived { .. }
            | Self::SetThreadPinned { .. }
            | Self::ReorderPinnedThreads { .. }
            | Self::MoveThread { .. }
            | Self::CommitThreadWorkspaceTransition { .. }
            | Self::SetThreadUnread { .. }
            | Self::ReplaceThreadDynamicToolCatalogs { .. }
            | Self::MergeThreadWritableRoots { .. }
            | Self::ReplaceThreadWritableRoots { .. }
            | Self::AdmitTurnAuthority { .. }
            | Self::AcknowledgeAgentRuntimeExecutionCleanup { .. }
            | Self::UpsertBackgroundProcess { .. }
            | Self::BeginInboxRouting { .. }
            | Self::RecordInboxRoutingRefusal { .. }
            | Self::StartInboxRoutingRun { .. }
            | Self::PublishDueInboxSnooze { .. }
            | Self::PrepareInboxSuggestions { .. }
            | Self::SettleInboxSuggestion { .. }
            | Self::BeginInboxDispatch { .. }
            | Self::RecordInboxSuggestionFailure { .. }
            | Self::CompleteInboxDispatch { .. }
            | Self::FailInboxDispatch { .. }
            | Self::HoldAutomationDecision { .. }
            | Self::RefreshAutomationDecision { .. } => false,
        }
    }
}
