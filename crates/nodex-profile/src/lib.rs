//! Profile provisioning composes persistence owners before publishing a new home.
#![forbid(unsafe_code)]

mod execution;
mod files;
pub use execution::ExecutionSnapshotReceipt;

pub use nodex_core::administration::{
    ProfileCloneBackupSelection, ProfileCloneRequest, ProfileStoreCheck, ProfileStoreStatus,
    check_profile_store,
};
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
    #[error("Profile execution database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Profile execution data is invalid: {0}")]
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
    pub execution: Option<ExecutionSnapshotReceipt>,
}

/// Combines a published content backup with the source's current online execution snapshot.
pub fn materialize_profile_clone(request: ProfileCloneRequest) -> Result<ProfileCloneReceipt> {
    let prepared = prepare_profile_clone(request)?;
    let execution = execution::capture(prepared.source_home(), prepared.staging_home())?;
    let receipt = ProfileCloneReceipt {
        store: prepared.store_receipt().clone(),
        execution,
    };
    prepared.publish(&receipt)?;
    Ok(receipt)
}
