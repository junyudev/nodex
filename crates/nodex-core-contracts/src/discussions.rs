use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::Actor;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DiscussionAnchor {
    Page,
    Blocks {
        #[serde(rename = "blockIds")]
        block_ids: Vec<String>,
    },
    Text {
        #[serde(rename = "blockId")]
        block_id: String,
    },
    Datum {
        #[serde(rename = "blockId")]
        block_id: String,
        source: String,
        key: Value,
        field: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionTextRange {
    /// UTF-16 offsets over inline text, with each inline atom counting as one.
    pub from: u32,
    pub to: u32,
    /// The selection observed by the reader. Core fences the selected text.
    pub expected_text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionAnchorState {
    Live,
    Orphaned,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionStatus {
    Open,
    Resolved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionWaiting {
    Nodex,
    Me,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Discussion {
    pub id: String,
    pub page_id: String,
    pub anchor: DiscussionAnchor,
    pub quote: String,
    pub anchor_state: DiscussionAnchorState,
    pub status: DiscussionStatus,
    pub created_by: Actor,
    pub created_at: String,
    pub resolved_by: Option<Actor>,
    pub resolved_at: Option<String>,
    pub last_activity_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDetail {
    #[serde(flatten)]
    pub discussion: Discussion,
    pub comments: Vec<DiscussionComment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionCursor {
    pub last_activity_at: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionWindow {
    pub items: Vec<DiscussionDetail>,
    pub next: Option<DiscussionCursor>,
    pub nodex_answers_questions: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedAskCursor {
    pub queued_at: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedAsk {
    pub page_id: String,
    pub queued_at: String,
    pub comment: DiscussionComment,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedAskWindow {
    pub items: Vec<QueuedAsk>,
    pub next: Option<QueuedAskCursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionComment {
    pub id: String,
    pub discussion_id: String,
    pub author: Actor,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub deleted_at: Option<String>,
    pub body: String,
    pub mentions: Vec<String>,
    pub to_nodex: bool,
    pub ask: Option<DiscussionAsk>,
    pub verdict: Option<DiscussionVerdict>,
    pub suggested_edit: Option<SuggestedEdit>,
    pub question_for: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionAskKind {
    Ask,
    Check,
    CheckPage,
    InPlace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionAskState {
    Queued,
    Working,
    NeedsYou,
    Answered,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionAskAgent {
    pub provider_instance_id: String,
    pub model: String,
    pub options: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionAsk {
    pub kind: DiscussionAskKind,
    pub state: DiscussionAskState,
    pub requested_session_id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub agent: Option<DiscussionAskAgent>,
    #[serde(default)]
    pub requester_id: Option<String>,
    #[serde(default)]
    pub dispatch: Option<DiscussionAskDispatch>,
    #[serde(default)]
    pub discussion_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionAskDispatch {
    pub message_id: String,
    pub launch_id: Option<String>,
    pub stop_requested: bool,
    pub agent: Option<DiscussionAskAgent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionAskContext {
    pub detail: DiscussionDetail,
    pub project_id: Option<String>,
    pub page_key: Option<String>,
    pub title: String,
    pub markdown: String,
    pub pending_block_id: Option<String>,
    pub commenter: bool,
    pub can_dispatch: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionBlockWriter {
    pub block_id: String,
    pub actor: Actor,
    pub written_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInboxEntry {
    pub page_id: String,
    pub discussion_id: String,
    pub comment_id: String,
    pub title: String,
    pub excerpt: String,
    pub occurred_at: String,
    pub reason: DiscussionInboxReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionInboxReason {
    NeedsYou,
    SuggestedEdit,
    Mention,
    Answered,
    Reply,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInboxWindow {
    pub items: Vec<DiscussionInboxEntry>,
    pub next: Option<DiscussionCursor>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscussionVerdictResult {
    True,
    PartlyTrue,
    False,
    Unverifiable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionEvidence {
    pub title: String,
    pub url: Option<String>,
    pub excerpt: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionVerdict {
    pub result: DiscussionVerdictResult,
    pub evidence: Vec<DiscussionEvidence>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedEditState {
    Open,
    Accepted,
    Rejected,
    Stale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestedEditDraft {
    pub block_ids: Vec<String>,
    pub new_markdown: String,
    /// Optional fence for a Suggest-mode client that observed the original range.
    pub expected_old_markdown: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedEdit {
    pub block_ids: Vec<String>,
    pub old_markdown: String,
    pub new_markdown: String,
    pub base_hash: String,
    pub state: SuggestedEditState,
    pub decided_by: Option<Actor>,
    pub decided_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionCommentDraft {
    pub body: String,
    #[serde(default)]
    pub to_nodex: bool,
    pub ask_kind: Option<DiscussionAskKind>,
    pub ask_agent: Option<DiscussionAskAgent>,
    pub requested_session_id: Option<String>,
    pub verdict: Option<DiscussionVerdict>,
    pub suggested_edit: Option<SuggestedEditDraft>,
    pub question_for: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DiscussionCommand {
    Create {
        #[serde(rename = "pageId")]
        page_id: String,
        #[serde(rename = "discussionId")]
        discussion_id: Option<String>,
        #[serde(rename = "firstCommentId")]
        first_comment_id: Option<String>,
        quote: Option<String>,
        anchor: DiscussionAnchor,
        #[serde(rename = "textRange")]
        text_range: Option<DiscussionTextRange>,
        #[serde(rename = "firstComment")]
        first_comment: Box<DiscussionCommentDraft>,
    },
    Reply {
        #[serde(rename = "discussionId")]
        discussion_id: String,
        comment: Box<DiscussionCommentDraft>,
    },
    Edit {
        #[serde(rename = "commentId")]
        comment_id: String,
        body: String,
    },
    Delete {
        #[serde(rename = "commentId")]
        comment_id: String,
    },
    Resolve {
        #[serde(rename = "discussionId")]
        discussion_id: String,
    },
    Reopen {
        #[serde(rename = "discussionId")]
        discussion_id: String,
    },
    Accept {
        #[serde(rename = "commentId")]
        comment_id: String,
    },
    Reject {
        #[serde(rename = "commentId")]
        comment_id: String,
    },
    UpdateAsk {
        #[serde(rename = "commentId")]
        comment_id: String,
        #[serde(rename = "expectedState")]
        expected_state: DiscussionAskState,
        state: DiscussionAskState,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        #[serde(rename = "runId")]
        run_id: Option<String>,
        agent: Option<DiscussionAskAgent>,
    },
    #[serde(rename_all = "camelCase")]
    ReserveAsk {
        comment_id: String,
        message_id: String,
        new_session_id: String,
        agent: Option<DiscussionAskAgent>,
    },
    #[serde(rename_all = "camelCase")]
    ObserveAsk {
        comment_id: String,
        message_id: String,
        run_id: String,
        waiting: bool,
    },
    #[serde(rename_all = "camelCase")]
    SettleAsk {
        comment_id: String,
        message_id: String,
        run_id: Option<String>,
        state: DiscussionAskState,
        fallback: String,
    },
    #[serde(rename_all = "camelCase")]
    StopAsk { comment_id: String },
    SetPageSetting {
        #[serde(rename = "pageId")]
        page_id: String,
        #[serde(rename = "nodexAnswersQuestions")]
        nodex_answers_questions: bool,
    },
    RevertRun {
        #[serde(rename = "pageId")]
        page_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

impl DiscussionCommand {
    pub fn permits_commenter(&self) -> bool {
        matches!(
            self,
            Self::Create { .. }
                | Self::Reply { .. }
                | Self::Edit { .. }
                | Self::Delete { .. }
                | Self::Resolve { .. }
                | Self::Reopen { .. }
                | Self::Reject { .. }
                | Self::StopAsk { .. }
                | Self::UpdateAsk {
                    state: DiscussionAskState::Queued,
                    ..
                }
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunRevertConflict {
    pub block_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiscussionCommandResult {
    Discussion {
        value: Box<Discussion>,
    },
    Comment {
        value: Box<DiscussionComment>,
    },
    PageSetting {
        #[serde(rename = "pageId")]
        page_id: String,
        #[serde(rename = "nodexAnswersQuestions")]
        nodex_answers_questions: bool,
    },
    RunRevert {
        reverted: Vec<String>,
        conflicts: Vec<RunRevertConflict>,
    },
}
