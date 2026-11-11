use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::agent::AgentBackendBinding;
use crate::collection::{CollectionWindow, CollectionWindowRequest};
use crate::{ModuleMutationReceipt, ModuleName, VersionedModuleContract};

pub const AUTOMATION_CONTRACT_VERSION: u32 = 14;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDueWorkLane {
    Automations,
    Reminders,
}

/// A Core-authored scheduling decision. Main owns sleeping and wake sources,
/// while the Automation Module remains the authority for durable due state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationDueWorkPlan {
    pub due_now: bool,
    pub next_wake_at_ms: Option<i64>,
    pub work_token: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationExecutionKind {
    Cron,
    Heartbeat,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AutomationStatus {
    Active,
    Paused,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationExecutionEnvironment {
    Local,
    Worktree,
}

/// An Automation records a dry run, asks its Owner first in the Inbox, or runs the work.
/// Only its person Owner can change the mode or edit an Automation set to Run.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMode {
    #[default]
    Run,
    AskFirst,
    DryRun,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationNotificationPolicy {
    FailedRunsOnly,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationNotificationPreference {
    #[default]
    Preserve,
    Set {
        value: Option<AutomationNotificationPolicy>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationScope {
    Space,
    Project { project_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationInput {
    #[serde(default)]
    pub source_condition: Option<AutomationSourceFilter>,
    #[serde(default)]
    pub scope: Option<AutomationScope>,
    #[serde(default)]
    pub owner_member_id: Option<String>,
    #[serde(default)]
    pub condition_text: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    pub kind: AutomationExecutionKind,
    pub project_id: Option<String>,
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub notification_policy: AutomationNotificationPreference,
    /// Absent preserves the current mode on update. A new Automation uses `Run` when the
    /// Desktop Host creates it and `AskFirst` when an Agent does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<AutomationMode>,
    /// A Page whose current content every run follows as standing instructions, and which
    /// each run's chat links to. Absent clears it, like other optional fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runbook_page_id: Option<String>,
    pub name: String,
    pub prompt: Option<String>,
    pub rrule: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    #[serde(default)]
    pub backend_binding: AgentBackendBinding,
    pub cwds: Option<Vec<String>>,
    pub execution_environment: Option<AutomationExecutionEnvironment>,
    pub local_environment_config_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct Automation {
    pub scope: AutomationScope,
    pub owner_member_id: String,
    pub condition_text: String,
    pub typed_condition: Option<AutomationCondition>,
    pub automation_id: String,
    pub automation_revision: i64,
    pub kind: AutomationExecutionKind,
    pub status: AutomationStatus,
    pub project_id: Option<String>,
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub notification_policy: Option<AutomationNotificationPolicy>,
    pub mode: AutomationMode,
    pub runbook_page_id: Option<String>,
    /// The runbook Page's current title; None without a runbook or when the Page is no longer active.
    pub runbook_title: Option<String>,
    /// The decision of an `AskFirst` Automation waiting in the Inbox, if any. At most one waits per Automation.
    pub held_decision: Option<AutomationHeldDecision>,
    pub name: String,
    pub prompt: String,
    pub rrule: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub backend_binding: AgentBackendBinding,
    pub cwds: Vec<String>,
    pub execution_environment: AutomationExecutionEnvironment,
    pub local_environment_config_path: Option<String>,
    pub next_run_at_ms: Option<i64>,
    pub last_run_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// A typed condition narrows an Automation's natural-language condition. Clock schedules
/// retain their own zone and jitter seed, independent of the execution Host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationCondition {
    Clock {
        rrule: String,
        timezone: String,
        jitter_salt: String,
    },
    Source {
        filters: AutomationSourceFilter,
    },
}

/// Event filters select evidence, never authorize work or replace the written condition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationSourceFilter {
    pub source_id: Option<String>,
    pub repositories: Vec<String>,
    pub kinds: Vec<AutomationSourceEventKind>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub actor_class: Option<AutomationActorFilter>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationActorFilter {
    Person,
    Any,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationSourceEventKind {
    NewIssue,
    NewPr,
    Comment,
    Review,
    CheckFailed,
    CheckPassed,
    LabelAdded,
    LabelRemoved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationDecision {
    pub occurred_at_ms: i64,
    pub session_id: Option<String>,
    pub decision_id: String,
    pub dispatch_id: String,
    pub automation_id: String,
    pub automation_revision: i64,
    pub trigger_ids: Vec<String>,
    /// Retained Trigger evidence and a manual request instant when known.
    pub inputs: Value,
    pub reason: String,
    pub mode: AutomationMode,
    pub status: AutomationDecisionStatus,
    pub frozen_action: Value,
    pub frozen_authority: Value,
    pub page_id: Option<String>,
    pub proposal_id: Option<String>,
    pub first_scheduled_for_ms: i64,
    pub last_scheduled_for_ms: i64,
    pub missed_count: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// An Ask first decision waiting in the Inbox. Later occurrences append to it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationHeldDecision {
    pub dispatch_id: String,
    /// The Inbox message that holds the decision.
    pub page_id: String,
    /// The Project whose Inbox holds the message; None for the Library Inbox.
    pub inbox_project_id: Option<String>,
    pub first_scheduled_for_ms: i64,
    pub last_scheduled_for_ms: i64,
    /// Later decisions that fell due while this one waited.
    pub missed_count: u32,
}

/// Lifecycle of a decision that went through the Inbox.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDecisionStatus {
    /// Waiting in the Inbox for the user.
    Held,
    /// Confirmed; waiting for, or holding, its execution lease.
    Admitted,
    /// Its execution settled; its Runs carry the outcome.
    Completed,
    /// Its execution failed before any Run reached a chat.
    Failed,
    /// The user skipped it.
    Skipped,
    /// Its Automation or message is gone, so it can no longer run.
    Withdrawn,
}

/// Why a lease was claimed.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationLeasePurpose {
    /// Execute the decision.
    #[default]
    Run,
    /// Place the decision of an `AskFirst` Automation in its Inbox; nothing runs until the user confirms.
    Hold,
}

/// What the user confirmed for a decision that waited in the Inbox, frozen at confirmation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationAdmission {
    /// The Inbox message whose reviewed text became the run's instructions.
    pub page_id: Option<String>,
    /// The instructions for this run, frozen from the reviewed message.
    pub prompt: String,
    /// What this run uses instead of the Automation's own Agent selection.
    pub agent: Option<crate::inbox::ProjectWorkspaceInboxChatAgent>,
    pub admitted_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationLeaseStatus {
    Claimed,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationLease {
    #[serde(default)]
    pub execution_automation: Option<Box<Automation>>,
    pub lease_id: String,
    pub dispatch_id: String,
    pub automation_revision: i64,
    pub automation_id: String,
    pub scheduled_for_ms: i64,
    pub attempt: u32,
    pub status: AutomationLeaseStatus,
    pub claimed_at_ms: i64,
    pub expires_at_ms: i64,
    pub settled_at_ms: Option<i64>,
    pub retry_at_ms: Option<i64>,
    pub reason_code: Option<String>,
    #[serde(default)]
    pub purpose: AutomationLeasePurpose,
    /// Present when the lease executes a decision the user confirmed in the Inbox.
    #[serde(default)]
    pub admission: Option<AutomationAdmission>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AutomationRunStatus {
    InProgress,
    PendingReview,
    Accepted,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationRun {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_selection: Option<crate::library::AgentWorkSelection>,
    pub page_id: Option<String>,
    pub run_id: String,
    pub session_id: Option<String>,
    pub automation_id: String,
    /// The decision this Run executes.
    pub dispatch_id: Option<String>,
    pub run_revision: i64,
    pub status: AutomationRunStatus,
    /// This run settled without asking for attention.
    #[serde(default)]
    pub quiet: bool,
    pub read_at_ms: Option<i64>,
    pub session_title: Option<String>,
    pub source_cwd: Option<String>,
    pub inbox_title: Option<String>,
    pub inbox_summary: Option<String>,
    pub archived_user_message: Option<String>,
    pub archived_assistant_message: Option<String>,
    pub archived_reason: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationInboxItem {
    pub automation_id: String,
    pub automation_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived_assistant_message: Option<String>,
    pub archived_user_message: Option<String>,
    pub archived_reason: Option<String>,
    pub source_cwd: Option<String>,
    pub run_id: String,
    pub session_id: Option<String>,
    /// This run settled without asking for attention.
    #[serde(default)]
    pub quiet: bool,
    pub read_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub status: AutomationRunStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationRunUnreadCounts {
    pub total: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationRunBulkResult {
    pub changed_count: u32,
    pub archived_pending_count: u32,
    pub pending_review_count: u32,
    pub has_more: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PageRecurrenceFrequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PageRecurrenceEndCondition {
    Never,
    UntilDate {
        #[serde(rename = "untilDate")]
        until_date: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageRecurrenceConfig {
    pub frequency: PageRecurrenceFrequency,
    pub interval: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_weekdays: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_condition: Option<PageRecurrenceEndCondition>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageReminderConfig {
    pub offset_minutes: i32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ScheduledPageOccurrence {
    pub occurrence_id: String,
    pub page_id: String,
    pub page_key: Option<String>,
    pub status: String,
    pub status_name: String,
    pub archived: bool,
    pub title: String,
    pub rich_title: Value,
    pub description: String,
    pub priority: Option<String>,
    pub estimate: Option<String>,
    pub tags: Vec<String>,
    pub due_date: Option<String>,
    pub occurrence_start_ms: i64,
    pub occurrence_end_ms: i64,
    pub is_all_day: bool,
    pub recurrence: Option<PageRecurrenceConfig>,
    pub reminders: Vec<PageReminderConfig>,
    pub schedule_timezone: Option<String>,
    pub assignee: Option<crate::library::PageAssignee>,
    pub run_in_target: Option<String>,
    pub run_in_local_path: Option<String>,
    pub run_in_base_branch: Option<String>,
    pub run_in_worktree_path: Option<String>,
    pub run_in_environment_path: Option<String>,
    pub metadata_revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub order: i64,
    pub is_recurring: bool,
    pub this_and_future_equivalent_to_all: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderLeaseStatus {
    Claimed,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ReminderLease {
    pub lease_id: String,
    pub project_id: String,
    pub receipt_project_id: String,
    pub page_id: String,
    pub occurrence_start_ms: i64,
    pub reminder_offset_minutes: i32,
    pub due_at_ms: i64,
    pub title: String,
    pub snooze_id: Option<i64>,
    pub attempt: u32,
    pub status: ReminderLeaseStatus,
    pub claimed_at_ms: i64,
    pub expires_at_ms: i64,
    pub settled_at_ms: Option<i64>,
    pub retry_at_ms: Option<i64>,
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ReminderSnooze {
    pub snooze_id: i64,
    pub project_id: String,
    pub page_id: String,
    pub occurrence_start_ms: i64,
    pub due_at_ms: i64,
    pub created_at_ms: i64,
    pub consumed_at_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PageOccurrenceUpdateScope {
    This,
    ThisAndFuture,
    All,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PageOccurrenceSchedulePatch {
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub scheduled_start_ms: Option<Option<i64>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub scheduled_end_ms: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_all_day: Option<bool>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub recurrence: Option<Option<PageRecurrenceConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminders: Option<Vec<PageReminderConfig>>,
    #[serde(
        default,
        deserialize_with = "crate::deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub schedule_timezone: Option<Option<String>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PageOccurrenceMutationCode {
    PageNotFound,
    PageNotScheduled,
    PageNotRecurring,
    InvalidOccurrenceRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PageOccurrenceMutationResult {
    pub success: bool,
    pub operation_id: String,
    pub duplicate: bool,
    pub commit_seq: Option<i64>,
    pub created_page_id: Option<String>,
    pub code: Option<PageOccurrenceMutationCode>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationRead {
    AutomationExecutionAdmission {
        run_id: String,
        lease_id: String,
        dispatch_id: String,
    },
    AutomationNotificationPolicy {
        message_id: String,
    },
    AutomationDecisions {
        automation_id: String,
        window: CollectionWindowRequest,
    },
    AgentAutomations {
        provenance: crate::agent::AgentTurnProvenance,
        search_query: Option<String>,
        window: CollectionWindowRequest,
    },
    AgentAutomation {
        provenance: crate::agent::AgentTurnProvenance,
        automation_id: String,
    },
    DueWork {
        lane: AutomationDueWorkLane,
    },
    Automations {
        include_deleted: Option<bool>,
        search_query: Option<String>,
        window: CollectionWindowRequest,
    },
    Automation {
        automation_id: String,
    },
    AutomationForExecution {
        automation_id: String,
    },
    Leases {
        automation_id: Option<String>,
        include_settled: Option<bool>,
        window: CollectionWindowRequest,
    },
    Run {
        run_id: String,
    },
    Runs {
        automation_id: Option<String>,
        include_archived: Option<bool>,
        window: CollectionWindowRequest,
    },
    Inbox {
        window: CollectionWindowRequest,
    },
    Occurrences {
        window_start_ms: i64,
        window_end_ms: i64,
        search_query: Option<String>,
        window: CollectionWindowRequest,
    },
    ReminderLeases {
        include_settled: Option<bool>,
        window: CollectionWindowRequest,
    },
    ReminderSnoozes {
        include_consumed: Option<bool>,
        window: CollectionWindowRequest,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationReadValue {
    AutomationExecutionAdmission {
        valid: bool,
    },
    AutomationNotificationPolicy {
        policy: Option<AutomationNotificationPolicy>,
    },
    AutomationDecisions {
        window: CollectionWindow<AutomationDecision>,
    },
    DueWork {
        plan: AutomationDueWorkPlan,
    },
    Automations {
        window: CollectionWindow<Automation>,
    },
    Automation {
        item: Option<Box<Automation>>,
    },
    Leases {
        window: CollectionWindow<AutomationLease>,
    },
    Run {
        item: Option<Box<AutomationRun>>,
    },
    Runs {
        window: CollectionWindow<AutomationRun>,
    },
    Inbox {
        window: CollectionWindow<AutomationInboxItem>,
        unread_counts: AutomationRunUnreadCounts,
    },
    Occurrences {
        window: CollectionWindow<ScheduledPageOccurrence>,
    },
    ReminderLeases {
        window: CollectionWindow<ReminderLease>,
    },
    ReminderSnoozes {
        window: CollectionWindow<ReminderSnooze>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationIntent {
    AgentCommand {
        provenance: Box<crate::agent::AgentTurnProvenance>,
        #[schema(no_recursion)]
        intent: Box<AutomationIntent>,
    },
    CreateAutomation {
        automation_id: String,
        automation: AutomationInput,
    },
    UpdateAutomation {
        automation_id: String,
        expected_revision: i64,
        status: AutomationStatus,
        automation: AutomationInput,
    },
    DeleteAutomation {
        automation_id: String,
        expected_revision: i64,
    },
    SetAutomationStatus {
        automation_id: String,
        expected_revision: i64,
        status: AutomationStatus,
    },
    DispatchNow {
        automation_id: String,
    },
    RescheduleAutomation {
        automation_id: String,
        expected_revision: i64,
        not_before_ms: Option<i64>,
        retry_within_ms: Option<u64>,
    },
    ClaimDue {
        work_token: String,
        limit: u32,
        lease_duration_ms: u64,
    },
    CompleteLease {
        lease_id: String,
    },
    FailLease {
        lease_id: String,
        retry_delay_ms: Option<u64>,
        reason_code: String,
    },
    BeginRun {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_selection: Option<crate::library::AgentWorkSelection>,
        #[serde(default)]
        message_id: Option<String>,
        #[serde(default)]
        notification_policy: Option<AutomationNotificationPolicy>,
        run_id: String,
        automation_id: String,
        #[serde(default)]
        dispatch_id: Option<String>,
        session_id: Option<String>,
        session_title: Option<String>,
        source_cwd: Option<String>,
    },
    BindRunSession {
        run_id: String,
        session_id: String,
        expected_revision: i64,
    },
    SetRunSessionTitle {
        run_id: String,
        expected_revision: i64,
        session_title: Option<String>,
    },
    CompleteRunForReview {
        run_id: String,
        expected_revision: i64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        quiet: bool,
        inbox_title: Option<String>,
        inbox_summary: Option<String>,
    },
    SetRunInboxItem {
        run_id: String,
        expected_revision: i64,
        inbox_title: Option<String>,
        inbox_summary: Option<String>,
    },
    AcceptRun {
        run_id: String,
        expected_revision: i64,
    },
    SetRunReadState {
        run_id: String,
        expected_revision: i64,
        read: bool,
    },
    MarkAllRunsRead,
    ArchiveRun {
        run_id: String,
        expected_revision: i64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        quiet: bool,
        archived_user_message: Option<String>,
        archived_assistant_message: Option<String>,
        archived_reason: Option<String>,
    },
    UnarchiveRun {
        run_id: String,
        expected_revision: i64,
    },
    DeleteRun {
        run_id: String,
        expected_revision: i64,
    },
    SettleInterruptedRuns,
    SnoozeReminder {
        page_id: String,
        occurrence_start_ms: i64,
        snooze_minutes: u32,
    },
    ClaimDueReminders {
        work_token: String,
        limit: u32,
        lease_duration_ms: u64,
    },
    CompleteReminderLease {
        lease_id: String,
    },
    FailReminderLease {
        lease_id: String,
        retry_delay_ms: Option<u64>,
        reason_code: String,
    },
    CompletePageOccurrence {
        page_id: String,
        occurrence_start_ms: i64,
        created_page_id: String,
    },
    SkipPageOccurrence {
        page_id: String,
        occurrence_start_ms: i64,
    },
    UpdatePageOccurrence {
        page_id: String,
        occurrence_start_ms: i64,
        scope: PageOccurrenceUpdateScope,
        created_page_id: Option<String>,
        updates: PageOccurrenceSchedulePatch,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationCommitValue {
    pub affected_automation_ids: Vec<String>,
    pub automations: Vec<Automation>,
    pub claimed_leases: Vec<AutomationLease>,
    pub runs: Vec<AutomationRun>,
    pub deleted_run_ids: Vec<String>,
    pub run_bulk: Option<AutomationRunBulkResult>,
    pub reminder_leases: Vec<ReminderLease>,
    pub reminder_snoozes: Vec<ReminderSnooze>,
    pub page_occurrence_mutation: Option<PageOccurrenceMutationResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub affected_automation_ids: Vec<String>,
    pub affected_lease_ids: Vec<String>,
    pub affected_run_ids: Vec<String>,
    pub affected_reminder_lease_ids: Vec<String>,
    pub affected_snooze_ids: Vec<i64>,
    pub affected_page_ids: Vec<String>,
    pub affected_document_ids: Vec<String>,
    pub affected_database_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct AutomationEvent {
    pub kind: AutomationEventKind,
    pub automation_ids: Vec<String>,
    pub lease_ids: Vec<String>,
    pub run_ids: Vec<String>,
    pub reminder_lease_ids: Vec<String>,
    pub snooze_ids: Vec<i64>,
    pub page_ids: Vec<String>,
    pub document_ids: Vec<String>,
    pub database_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationEventKind {
    AutomationChanged,
}

pub struct AutomationContract;

impl VersionedModuleContract for AutomationContract {
    type Read = AutomationRead;
    type Snapshot = AutomationReadValue;
    type Intent = AutomationIntent;
    type Receipt = AutomationReceipt;
    type Event = AutomationEvent;

    const VERSION: u32 = AUTOMATION_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::Automation;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_clock_fields_are_not_caller_authored() {
        let claim = serde_json::to_value(AutomationIntent::ClaimDue {
            work_token: "automation-due:1".to_owned(),
            limit: 3,
            lease_duration_ms: 60_000,
        })
        .expect("claim serializes");
        assert_eq!(claim["kind"], "claim_due");
        assert!(claim.get("due_before").is_none());

        let complete = serde_json::to_value(AutomationIntent::CompleteLease {
            lease_id: "lease-1".to_owned(),
        })
        .expect("completion serializes");
        assert!(complete.get("completed_at").is_none());

        let read = serde_json::to_value(AutomationIntent::SetRunReadState {
            run_id: "run-1".to_owned(),
            expected_revision: 3,
            read: true,
        })
        .expect("read transition serializes");
        assert!(read.get("read_at_ms").is_none());

        let snooze = serde_json::to_value(AutomationIntent::SnoozeReminder {
            page_id: "page-1".to_owned(),
            occurrence_start_ms: 42,
            snooze_minutes: 5,
        })
        .expect("snooze serializes");
        assert!(snooze.get("due_at_ms").is_none());
        assert!(snooze.get("created_at_ms").is_none());

        let reminder_claim = serde_json::to_value(AutomationIntent::ClaimDueReminders {
            work_token: "reminder-due:1".to_owned(),
            limit: 3,
            lease_duration_ms: 60_000,
        })
        .expect("reminder claim serializes");
        assert!(reminder_claim.get("now_ms").is_none());
    }

    #[test]
    fn definition_status_preserves_the_product_wire_values() {
        assert_eq!(
            serde_json::to_value(AutomationStatus::Active).expect("status"),
            "ACTIVE"
        );
        assert_eq!(
            serde_json::to_value(AutomationRunStatus::PendingReview).expect("run status"),
            "PENDING_REVIEW"
        );
    }

    #[test]
    fn page_recurrence_uses_the_existing_camel_case_shape_without_null_fillers() {
        let recurrence = serde_json::to_value(PageRecurrenceConfig {
            frequency: PageRecurrenceFrequency::Daily,
            interval: 1,
            by_weekdays: Vec::new(),
            end_condition: None,
        })
        .expect("recurrence serializes");
        assert_eq!(
            recurrence,
            serde_json::json!({
                "frequency": "daily",
                "interval": 1,
            })
        );
        let until = serde_json::to_value(PageRecurrenceEndCondition::UntilDate {
            until_date: "2026-07-31".to_owned(),
        })
        .expect("end condition serializes");
        assert_eq!(
            until,
            serde_json::json!({
                "type": "untilDate",
                "untilDate": "2026-07-31",
            })
        );
    }

    #[test]
    fn occurrence_patch_preserves_omitted_and_explicit_null_fields() {
        let patch = serde_json::from_value::<PageOccurrenceSchedulePatch>(serde_json::json!({
            "scheduled_start_ms": null,
            "schedule_timezone": "UTC"
        }))
        .expect("patch");
        assert_eq!(patch.scheduled_start_ms, Some(None));
        assert_eq!(patch.scheduled_end_ms, None);
        assert_eq!(patch.schedule_timezone, Some(Some("UTC".to_owned())));

        let serialized = serde_json::to_value(patch).expect("patch serializes");
        assert!(
            serialized
                .get("scheduled_start_ms")
                .is_some_and(Value::is_null)
        );
        assert!(serialized.get("scheduled_end_ms").is_none());
    }
}
