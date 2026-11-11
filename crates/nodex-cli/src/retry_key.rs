use nodex_core_contracts::ModuleName;
use nodex_core_contracts::workspace::{
    AppToolOperationReplay, AppToolOperationRequest, RETRY_KEY_MAX_SCALARS,
};
use nodex_core_protocol::client::{ClientError, CoreClient};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{CliError, CliErrorCode};
use crate::runtime::{fresh_operation_id, map_client_error, map_core_error};

pub(crate) fn admit(
    client: &CoreClient,
    project: Option<&str>,
    command: &str,
    key: Option<&str>,
    arguments: impl Serialize,
) -> Result<String, CliError> {
    Ok(admit_with_replay(client, project, command, key, arguments, None)?.operation_id)
}

pub(crate) struct AdmittedOperation {
    pub operation_id: String,
    pub replay: Option<AppToolOperationReplay>,
}

pub(crate) fn admit_with_replay(
    client: &CoreClient,
    project: Option<&str>,
    command: &str,
    key: Option<&str>,
    arguments: impl Serialize,
    replay_module: Option<ModuleName>,
) -> Result<AdmittedOperation, CliError> {
    let Some(key) = key else {
        return Ok(AdmittedOperation {
            operation_id: fresh_operation_id()?,
            replay: None,
        });
    };
    if !(1..=RETRY_KEY_MAX_SCALARS).contains(&key.chars().count()) {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Idempotency key must contain 1 to 128 Unicode scalar values",
        ));
    }
    // Hash typed mutation input, excluding input paths and presentation flags. Serialize through
    // Value so object field order does not depend on how the caller supplied a JSON payload.
    let canonical = serde_json::to_value((project, &client.handshake.store_epoch, arguments))
        .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))?;
    let request = AppToolOperationRequest {
        provenance: None,
        tool_name: command.to_owned(),
        idempotency_key: key.to_owned(),
        replay_module,
        request_hash: hex::encode(Sha256::digest(canonical.to_string().as_bytes())),
    };
    client
        .admit_app_tool_operation(project, request)
        .map(|identity| AdmittedOperation {
            operation_id: identity.operation_id,
            replay: identity.replay,
        })
        .map_err(|error| match error {
            ClientError::Http {
                core_error: Some(error),
                ..
            } => map_core_error(*error),
            error => map_client_error(error),
        })
}
