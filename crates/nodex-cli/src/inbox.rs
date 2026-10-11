use std::path::Path;

use nodex_core_contracts::workspace::{PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;
use sha2::{Digest, Sha256};

use crate::cli::InboxSendArgs;
use crate::error::{CliError, CliErrorCode};
use crate::page_mutation::read_content_input;
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, selected_project,
};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct InboxSendResult {
    operation_id: String,
    duplicate: bool,
    page_id: String,
    /// The Project the message is labeled with; null when sent from outside every Project.
    project_id: Option<String>,
}

/// Sends from inside a Project carry that Project as their source; anywhere else the
/// message is still accepted, labeled only as coming from the command line.
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
    let operation_id = operation_id(arguments.idempotency_key.as_deref())?;
    let page_id = stable_uuid(&operation_id, "inbox-page");
    let response = client
        .workspace_apply(
            project.as_deref(),
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: operation_id.clone(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::SendInboxMessage {
                    page_id: page_id.clone(),
                    document_id: stable_uuid(&operation_id, "inbox-document"),
                    text,
                    title: arguments.title,
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

/// A retry with the same idempotency key must name the same Page, so identities derive from it.
fn stable_uuid(operation_id: &str, role: &str) -> String {
    let hex = Sha256::digest(format!("{role}\0{operation_id}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-7{}-8{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..15],
        &hex[15..18],
        &hex[18..30],
    )
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
