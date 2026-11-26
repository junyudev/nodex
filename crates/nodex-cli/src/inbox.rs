use std::path::Path;

use crate::identity::stable_entity_id as stable_uuid;
use nodex_core_contracts::inbox::{
    InboxActionDetails, InboxConfirmedBy, InboxMessageSource, InboxReadSuggestionState, PageIntake,
    PageIntakeMetadata, ProjectWorkspaceInboxEntryKind, ProjectWorkspaceInboxProposal,
    ProjectWorkspaceInboxProposalOrigin,
};
use nodex_core_contracts::workspace::{PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;

use crate::cli::InboxSendArgs;
use crate::error::{CliError, CliErrorCode};
use crate::page_mutation::read_content_input;
use crate::runtime::{CommandOutput, map_client_error, map_core_error, selected_project};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct InboxSendResult {
    operation_id: String,
    duplicate: bool,
    page_id: String,
    /// The Project whose Inbox received the message; null for the Library Inbox.
    project_id: Option<String>,
}

/// Sends from inside a Project land in that Project's Inbox; anywhere else the message
/// waits in the Library Inbox, labeled as coming from the command line.
pub(crate) fn send(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: InboxSendArgs,
) -> Result<CommandOutput, CliError> {
    let text = match arguments.text {
        Some(text) if text != "-" => text,
        _ => read_content_input(None, MAX_MESSAGE_BYTES, "Inbox message")?,
    };
    if text.trim().is_empty() {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Inbox message is empty",
        ));
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("Inbox message exceeds {MAX_MESSAGE_BYTES} bytes"),
        ));
    }
    let project = match selected_project(client, explicit_project, cwd) {
        Ok(project) => Some(project.id),
        Err(error) if explicit_project.is_none() && error.code == CliErrorCode::ProjectNotFound => {
            None
        }
        Err(error) => return Err(error),
    };
    let operation_id = crate::retry_key::admit(
        client,
        project.as_deref(),
        "inbox send",
        arguments.idempotency_key.as_deref(),
        (&text, &arguments.title),
    )?;
    let page_id = stable_uuid(&operation_id, "inbox-page");
    let response = client
        .workspace_apply(
            project.as_deref(),
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: operation_id.clone(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::SendInboxMessage {
                    reply_to_page_id: None,
                    expected_store_epoch: Some(client.handshake.store_epoch.clone()),
                    page_id: page_id.clone(),
                    document_id: stable_uuid(&operation_id, "inbox-document"),
                    body: text,
                    title: arguments.title,
                    // Core places the message in the Inbox of the Project this connection binds.
                    project_id: None,
                },
            },
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(committed) => committed,
        ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
    };
    let result = InboxSendResult {
        operation_id: committed.receipt().mutation.operation_id.clone(),
        duplicate: committed.receipt().mutation.duplicate,
        page_id,
        project_id: project,
    };
    serde_json::to_value(result)
        .map(CommandOutput::Json)
        .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PageShowIntake<'a> {
    source: &'a InboxMessageSource,
    kind: Option<ProjectWorkspaceInboxEntryKind>,
    important: bool,
    captured_at: &'a str,
    waiting: bool,
    suggestion: Option<PageShowSuggestion<'a>>,
    handoff: Option<PageShowHandoff<'a>>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
struct PageShowSuggestion<'a> {
    state: InboxReadSuggestionState,
    #[serde(flatten)]
    action: Option<InboxActionDetails<'a>>,
    summary: Option<&'a str>,
    rationale: Option<&'a str>,
    suggested_by: Option<&'a str>,
    decision_session_id: Option<&'a str>,
    member_page_keys: Vec<Option<&'a str>>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
struct PageShowHandoff<'a> {
    decided_at: &'a str,
    confirmed_by: Option<InboxConfirmedBy>,
    actor_label: &'a str,
    #[serde(flatten)]
    action: InboxActionDetails<'a>,
    rationale: Option<&'a str>,
    suggested_by: Option<&'a str>,
    origin: &'static str,
    decision_session_id: Option<&'a str>,
    created_page_keys: Vec<Option<&'a str>>,
}

impl<'a> PageShowIntake<'a> {
    pub(crate) fn new(intake: &'a PageIntake, metadata: &'a PageIntakeMetadata) -> Self {
        let proposal = intake
            .message
            .as_ref()
            .and_then(|message| message.proposal.as_ref())
            .filter(|proposal| {
                proposal.confirmed_by.is_none()
                    && metadata
                        .suggestion
                        .as_ref()
                        .is_some_and(|summary| summary.action_type.is_some())
            });
        let page_keys = |ids: &'a [String]| {
            ids.iter()
                .map(|id| metadata.page_keys.get(id).and_then(Option::as_deref))
                .collect()
        };
        Self {
            source: &metadata.source,
            kind: metadata.kind,
            important: metadata.important,
            captured_at: &metadata.captured_at,
            waiting: intake.message.is_some(),
            suggestion: metadata
                .suggestion
                .as_ref()
                .map(|summary| PageShowSuggestion {
                    state: summary.state,
                    action: proposal.map(ProjectWorkspaceInboxProposal::action_details),
                    summary: summary.summary.as_deref(),
                    rationale: proposal.and_then(|proposal| proposal.rationale.as_deref()),
                    suggested_by: proposal.and_then(|proposal| proposal.produced_by.as_deref()),
                    decision_session_id: metadata.suggestion_decision_session_id.as_deref(),
                    member_page_keys: proposal
                        .filter(|proposal| proposal.page_ids.len() > 1)
                        .map_or_else(Vec::new, |proposal| page_keys(&proposal.page_ids)),
                }),
            handoff: intake.handoff.as_ref().map(|handoff| PageShowHandoff {
                decided_at: &handoff.decided_at,
                confirmed_by: handoff.proposal.confirmed_by,
                actor_label: &handoff.actor_label,
                action: handoff.proposal.action_details(),
                rationale: handoff.proposal.rationale.as_deref(),
                suggested_by: handoff.proposal.produced_by.as_deref(),
                origin: match handoff.proposal.origin {
                    ProjectWorkspaceInboxProposalOrigin::Agent => "nodex",
                    ProjectWorkspaceInboxProposalOrigin::User => "user",
                    ProjectWorkspaceInboxProposalOrigin::Automation => "automation",
                },
                decision_session_id: handoff.proposal.decision_session_id.as_deref(),
                created_page_keys: page_keys(&handoff.proposal.created_page_ids),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::stable_uuid;

    #[test]
    fn retried_sends_name_the_same_page() {
        let page = stable_uuid("cli:retry", "inbox-page");
        assert_eq!(page, stable_uuid("cli:retry", "inbox-page"));
        assert_ne!(page, stable_uuid("cli:retry", "inbox-document"));
        assert_ne!(page, stable_uuid("cli:other", "inbox-page"));
        assert_eq!(page.len(), 36);
        assert_eq!(&page[14..15], "7");
    }
}
