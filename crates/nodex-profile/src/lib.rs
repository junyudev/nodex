//! Offline Profile provisioning composes persistence owners before publishing a new home.
#![forbid(unsafe_code)]

mod codex;
mod files;
mod goals;

pub use codex::ConversationSnapshotReceipt;
pub use nodex_core::administration::{ProfileCloneBackupSelection, ProfileCloneRequest};
use nodex_core::administration::{
    ProfileStoreCloneReceipt as StoreCloneReceipt, prepare_profile_clone,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ProfileCloneError {
    #[error("{0}")]
    Invalid(String),
    #[error("Profile clone filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Profile conversation database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Profile conversation data is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Store(#[from] nodex_core::infrastructure::sqlite::StoreError),
}

impl ProfileCloneError {
    /// Classifies provisioning failures without exposing Store error handling to Adapters.
    pub fn is_invalid_input(&self) -> bool {
        use nodex_core::infrastructure::sqlite::StoreErrorCode;
        match self {
            Self::Store(error) => matches!(
                error.code,
                StoreErrorCode::AlreadyOwned
                    | StoreErrorCode::InvalidInput
                    | StoreErrorCode::InvalidProfile
                    | StoreErrorCode::NotFound
                    | StoreErrorCode::UnsupportedSchema
            ),
            Self::Io(_) => false,
            _ => true,
        }
    }
}

type Result<T> = std::result::Result<T, ProfileCloneError>;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloneReceipt {
    #[serde(flatten)]
    pub store: StoreCloneReceipt,
    pub conversations: ConversationSnapshotReceipt,
}

/// Captures the selected Store backup and current idle native history as separately dated inputs.
/// Missing history is a rejected clone unless explicitly requested for diagnostic reproduction.
pub fn materialize_profile_clone(
    request: ProfileCloneRequest,
    allow_missing_conversations: bool,
) -> Result<ProfileCloneReceipt> {
    let prepared = prepare_profile_clone(request)?;
    let conversations = codex::capture(
        prepared.source_home(),
        prepared.staging_home(),
        prepared.target_home(),
        prepared.threads(),
    )?;
    if !allow_missing_conversations && !conversations.missing_thread_ids.is_empty() {
        return Err(ProfileCloneError::Invalid(format!(
            "Source Profile has no recoverable native history for {} local Thread(s) (first: {}). Restore the source conversation data, or use --allow-missing-conversations for an explicitly incomplete diagnostic clone",
            conversations.missing_thread_ids.len(),
            conversations.missing_thread_ids[0],
        )));
    }
    let receipt = ProfileCloneReceipt {
        store: prepared.store_receipt().clone(),
        conversations,
    };
    prepared.publish(&receipt)?;
    Ok(receipt)
}
