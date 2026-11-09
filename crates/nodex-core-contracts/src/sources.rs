//! Library-owned external observations. Network access and secrets belong to the Host.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceRepository {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceDiscovery {
    pub assigned: bool,
    pub review_requests: bool,
    pub mentions: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GitHubSourceConfig {
    pub host: String,
    pub account_login: String,
    pub account_id: String,
    pub credential_ref: String,
    pub repositories: Vec<SourceRepository>,
    pub discovery: SourceDiscovery,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct Source {
    pub id: String,
    pub library_id: String,
    pub kind: String,
    pub revision: i64,
    pub enabled: bool,
    pub enabled_at_ms: Option<i64>,
    pub config: GitHubSourceConfig,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourceObservation {
    pub fingerprint: String,
    pub revision: i64,
}
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourceCursor {
    pub baseline_at_ms: i64,
    pub watermark_ms: i64,
    pub validators: BTreeMap<String, String>,
    pub continuation: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourcePosition {
    pub source_id: String,
    pub partition: String,
    pub revision: i64,
    pub baseline: bool,
    pub cursor: SourceCursor,
    pub lease_token: Option<String>,
    pub lease_expires_at_ms: Option<i64>,
    pub next_poll_at_ms: i64,
    pub consecutive_failures: i64,
    pub last_success_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalThreadKind {
    Issue,
    PullRequest,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourcePullRequestHead {
    pub repository_id: String,
    pub repository: String,
    pub branch: String,
    pub sha: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ExternalThread {
    pub id: String,
    pub host: String,
    pub repository_id: String,
    pub repository: String,
    pub number: i64,
    pub kind: ExternalThreadKind,
    pub url: String,
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub head: Option<SourcePullRequestHead>,
    #[serde(default)]
    pub draft: bool,
    /// Shared observation fence across every Source watching this external thread.
    pub observation_revision: i64,
    pub observations: BTreeMap<String, SourceObservation>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceActorClass {
    Person,
    Bot,
    Ci,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourceTriggerInput {
    pub semantic_key: String,
    pub kind: String,
    pub occurred_at_ms: i64,
    pub actor_login: String,
    pub actor_class: SourceActorClass,
    pub thread_id: String,
    pub text: Option<String>,
    pub metadata: serde_json::Value,
    pub url: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourceTrigger {
    pub id: String,
    pub source_id: String,
    pub received_at_ms: i64,
    pub disposition: String,
    pub event: SourceTriggerInput,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SourceProblem {
    pub id: String,
    pub library_id: String,
    pub source_id: Option<String>,
    pub page_id: Option<String>,
    pub project_id: Option<String>,
    pub scope: String,
    pub kind: String,
    pub first_failure_at_ms: i64,
    pub last_failure_at_ms: i64,
    pub consecutive_failures: i64,
    pub summary: String,
    pub fix: ProblemFix,
    pub evidence: serde_json::Value,
    pub opened_at_ms: Option<i64>,
    pub resolved_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProblemFix {
    Reconnect,
    Retry,
    OpenCard,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ChannelOutboxItem {
    pub id: String,
    pub page_id: String,
    pub source: Source,
    pub thread: ExternalThreadReference,
    pub body: String,
    pub body_hash: String,
    pub marker: String,
    pub episode: String,
    pub thread_order: i64,
    pub state: String,
    pub attempts: i64,
    pub lease_token: Option<String>,
    pub lease_expires_at_ms: Option<i64>,
    pub retry_at_ms: i64,
    pub remote_comment_id: Option<String>,
    pub remote_url: Option<String>,
    pub terminal_reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ChannelReceipt {
    pub comment_id: String,
    pub url: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityFilter {
    All,
    /// Handled messages: sent to a chat, filed, kept, done or returned to the Inbox.
    Messages,
    /// What Nodex, Automations and Sources decided, including messages Nodex handled.
    Decisions,
    Problems,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ActivityRow {
    pub id: String,
    pub at: String,
    pub subject: Option<ActivitySubject>,
    pub description: String,
    pub reason: Option<String>,
    pub page_id: Option<String>,
    pub session_id: Option<String>,
    pub url: Option<String>,
    pub evidence: serde_json::Value,
    pub category: String,
    /// The handled message a message fact is about, as it stands now; only on message facts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<crate::inbox::ProjectWorkspaceInboxItem>,
}
/// The primary evidence link, named by its subject rather than its resource type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActivitySubject {
    Automation {
        automation_id: String,
        label: String,
    },
    Page {
        page_id: String,
        label: String,
    },
    Chat {
        session_id: String,
    },
    Thread {
        url: String,
        label: String,
    },
    Source {
        source_id: String,
        label: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadFollowRole {
    OwnPr,
    Origin,
    Context,
}

/// Presentation and delivery reference; polling observations remain on the Source's thread read.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ExternalThreadReference {
    pub id: String,
    pub host: String,
    pub repository_id: String,
    pub repository: String,
    pub number: i64,
    pub kind: ExternalThreadKind,
    pub url: String,
    pub title: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct PageThreadFollow {
    pub page_id: String,
    pub thread: ExternalThreadReference,
    pub role: ThreadFollowRole,
    pub provenance: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ThreadDelivery {
    pub target_current: bool,
    pub id: String,
    pub trigger: SourceTrigger,
    pub page_id: String,
    pub thread: ExternalThreadReference,
    pub session_id: Option<String>,
    pub binding_revision: Option<i64>,
    pub execution_ref: Option<crate::workspace::ProjectWorkspaceSessionExecutionRef>,
    pub state: String,
    pub reason: Option<String>,
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct ThreadDeliveryBatch {
    pub attempts: i64,
    pub eligible: bool,
    pub held: bool,
    pub message_id: String,
    pub session_id: String,
    pub execution_ref: crate::workspace::ProjectWorkspaceSessionExecutionRef,
    pub body: String,
    pub body_hash: String,
    pub created_at_ms: i64,
    pub state: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRead {
    EventAutomationWatching {
        source_id: String,
        repository: String,
    },
    ChannelOutbox {
        #[serde(default)]
        include_terminal: bool,
        after_id: Option<String>,
        limit: u32,
    },
    PageFollows {
        page_id: String,
        after_thread_id: Option<String>,
        limit: u32,
    },
    Deliveries {
        page_id: Option<String>,
        state: Option<String>,
        after_id: Option<String>,
        limit: u32,
    },
    DeliveryBatches {
        after_message_id: Option<String>,
        limit: u32,
    },
    Sources {
        after_id: Option<String>,
        limit: u32,
    },
    Positions {
        source_id: String,
        after_partition: Option<String>,
        limit: u32,
    },
    Threads {
        host: String,
        repository_id: String,
        after_id: Option<String>,
        limit: u32,
    },
    Triggers {
        thread_url: String,
        before_id: Option<String>,
        limit: u32,
    },
    OpenProblems {
        source_id: Option<String>,
        after_id: Option<String>,
        limit: u32,
    },
    KnownPullRequests {
        after_page_id: Option<String>,
        limit: u32,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceReadValue {
    EventAutomationWatching {
        enabled: bool,
    },
    ChannelOutbox {
        items: Vec<ChannelOutboxItem>,
    },
    PageFollows {
        follows: Vec<PageThreadFollow>,
    },
    Deliveries {
        deliveries: Vec<ThreadDelivery>,
    },
    DeliveryBatches {
        batches: Vec<ThreadDeliveryBatch>,
    },
    Sources {
        sources: Vec<Source>,
    },
    Positions {
        positions: Vec<SourcePosition>,
    },
    Threads {
        threads: Vec<ExternalThread>,
    },
    Triggers {
        triggers: Vec<SourceTrigger>,
    },
    OpenProblems {
        problems: Vec<SourceProblem>,
    },
    KnownPullRequests {
        pull_requests: Vec<crate::workspace::PagePullRequest>,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceCommand {
    ReplyToOrigin {
        page_id: String,
        body: String,
    },
    ClaimChannelSend {
        id: String,
        lease_token: String,
        lease_duration_ms: i64,
    },
    SettleChannelSend {
        id: String,
        lease_token: String,
        receipt: Option<ChannelReceipt>,
        failure: Option<String>,
        permanent: bool,
        credential_invalid: bool,
    },
    RecordThreadDeliveryFailure {
        message_id: String,
        reason: String,
    },
    RetryProblem {
        problem_id: String,
    },
    /// Only a verified managed-chat tool may request a context follow. The Host supplies remote evidence.
    FollowThread {
        source_id: String,
        config_revision: i64,
        thread: ExternalThread,
    },
    PrepareThreadDeliveryBatch {
        message_id: String,
        delivery_ids: Vec<String>,
        body: String,
    },
    BeginThreadDeliveryBatch {
        message_id: String,
    },
    SettleThreadDeliveryBatch {
        message_id: String,
        accepted: bool,
        receipt: String,
    },
    InvalidateThreadDelivery {
        delivery_id: String,
        reason: String,
    },
    ConfigureSource {
        source_id: String,
        expected_revision: i64,
        enabled: bool,
        config: GitHubSourceConfig,
    },
    ClaimSourcePartition {
        source_id: String,
        config_revision: i64,
        partition: String,
        lease_token: String,
        lease_duration_ms: i64,
    },
    IngestSourceBatch {
        source_id: String,
        config_revision: i64,
        partition: String,
        expected_position: i64,
        lease_token: String,
        threads: Vec<ExternalThread>,
        triggers: Vec<SourceTriggerInput>,
        next_position: SourceCursor,
        next_poll_at_ms: i64,
        quarantine: Vec<serde_json::Value>,
    },
    RecordSourceFailure {
        source_id: String,
        config_revision: i64,
        partition: Option<String>,
        lease_token: Option<String>,
        problem_kind: String,
        evidence: serde_json::Value,
        retry_at_ms: i64,
    },
    RecordSourceSuccess {
        source_id: String,
        config_revision: i64,
        partition: Option<String>,
        lease_token: Option<String>,
    },
}
