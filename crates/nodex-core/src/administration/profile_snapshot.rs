//! The Store owns Backup publication; the injected participant owns execution capture.
use std::path::Path;

use super::ProfileCloneExecution;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::administration::ProfileSnapshotSource;

pub struct ProfileSnapshotCapture<'a> {
    pub source_profile: &'a Path,
    pub staging_profile: &'a Path,
    pub target_profile: &'a Path,
    pub source: Option<&'a ProfileSnapshotSource>,
    /// References come from the staged Store snapshot, never a caller's claimed roster.
    pub required: &'a [ProfileCloneExecution],
}

pub trait ProfileSnapshotParticipant: Send + Sync {
    /// Metadata-only disk admission; implementations count only their selected durable closure.
    fn estimated_bytes(
        &self,
        _: &Path,
        _: Option<&ProfileSnapshotSource>,
    ) -> Result<u64, StoreError> {
        Ok(0)
    }
    /// Failure aborts publication. Success reports whether an execution closure was staged.
    fn capture(&self, request: ProfileSnapshotCapture<'_>) -> Result<bool, StoreError>;
}

pub(super) struct NoProfileSnapshotParticipant;
impl ProfileSnapshotParticipant for NoProfileSnapshotParticipant {
    fn capture(&self, request: ProfileSnapshotCapture<'_>) -> Result<bool, StoreError> {
        if request.source.is_some()
            || !request.required.is_empty()
            || request
                .source_profile
                .join("agent-runtime/agent-runtime.sqlite")
                .exists()
        {
            return Err(StoreError::new(
                StoreErrorCode::MissingDependencies,
                "Profile backup requires the execution snapshot participant",
                false,
            ));
        }
        Ok(false)
    }
}
