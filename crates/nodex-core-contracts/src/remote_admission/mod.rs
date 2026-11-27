//! Fail-closed semantic admission for the remote Member adapter. Each Module command type
//! decides every one of its variants in an exhaustive match, so a new variant does not compile
//! until it is explicitly admitted or refused for remote Members. Clippy, which CI runs with
//! warnings denied, rejects a wildcard arm that would decide a future variant silently.
#![deny(clippy::wildcard_enum_match_arm)]
#![allow(
    clippy::unneeded_struct_pattern,
    reason = "`Self::Variant { .. }` keeps each decision independent of the variant's fields"
)]

use crate::library::MemberRole;
use crate::{AdapterKind, BoundModuleContext, CoreError, CoreErrorCode, CoreErrorRecovery};

mod administration;
mod automation;
mod database;
mod document;
mod library;
mod query;
mod workspace;

#[cfg(test)]
mod tests;

/// Decides whether a remote Member may invoke a command. Core's handlers still
/// decide whose data an admitted command may touch.
pub trait RemoteAdmission {
    fn remote_access(&self) -> RemoteAccess;
}

/// The remote roles permitted to invoke a command before its domain-specific checks.
pub enum RemoteAccess {
    Denied,
    Member,
    Participant,
}

impl RemoteAccess {
    fn allows(self, role: MemberRole) -> bool {
        match self {
            Self::Denied => false,
            Self::Member => matches!(role, MemberRole::Owner | MemberRole::Member),
            Self::Participant => true,
        }
    }
}

pub fn authorize(
    context: &BoundModuleContext,
    command: &impl RemoteAdmission,
) -> Result<(), CoreError> {
    if context.adapter != AdapterKind::RemoteMember {
        return Ok(());
    }
    let Some(principal) = &context.principal else {
        return Err(denied());
    };
    if principal.space_id != context.library_id.0 {
        return Err(denied());
    }
    if !command.remote_access().allows(principal.role) {
        return Err(denied());
    }
    Ok(())
}

/// Returns the common error for operations outside remote Member admission.
pub fn denied() -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: "This operation is not admitted for remote membership".into(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}
