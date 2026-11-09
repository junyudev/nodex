//! Recheck remote authority inside the writer transaction, after queueing and
//! before replay or canonical writes. Revocation and mutation are serialized.
use super::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CoreErrorRecovery, library::MemberRole,
};
use rusqlite::{Connection, params};
pub(crate) fn require_current(
    connection: &Connection,
    context: &BoundModuleContext,
) -> Result<(), StoreError> {
    if context.adapter != AdapterKind::RemoteMember {
        return Ok(());
    }
    let Some(p) = &context.principal else {
        return Err(denied());
    };
    require_principal(connection, &context.library_id.0, p)
}

pub(crate) fn require_principal(
    connection: &Connection,
    library: &str,
    p: &nodex_core_contracts::RemotePrincipal,
) -> Result<(), StoreError> {
    if p.space_id != library {
        return Err(denied());
    }
    let role = if p.role == MemberRole::Owner {
        "owner"
    } else {
        "member"
    };
    let present:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM member_sessions s JOIN member_devices d ON d.id=s.device_id JOIN members m ON m.id=d.member_id AND m.library_id=d.library_id WHERE s.id=?1 AND s.expires_at>unixepoch() AND d.id=?2 AND d.member_id=?3 AND d.library_id=?4 AND d.revoked_at IS NULL AND m.lifecycle='active' AND m.role=?5)",params![p.session_id,p.device_id,p.member_id,p.space_id,role],|r|r.get(0))?;
    if !present {
        // Writer admission cannot prove withdrawal to a Desktop. Renew the Device
        // credential, then replay this operation under the resulting session.
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Remote session requires renewal",
            true,
        )
        .with_recovery(CoreErrorRecovery::RenewRemoteSession));
    }
    Ok(())
}
fn denied() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "Remote operation is not authorized",
        false,
    )
}

/// A retained receipt belongs to its initiating Member, independently of a
/// command's domain-specific semantic fingerprint or its transport attempt.
pub(crate) fn require_operation_owner(
    connection: &Connection,
    context: &BoundModuleContext,
    module: &str,
    operation: &str,
) -> Result<(), StoreError> {
    let Some(principal) = &context.principal else {
        return Ok(());
    };
    use rusqlite::OptionalExtension;
    let owner:Option<String>=connection.query_row(
        "SELECT COALESCE(member.member_id,'') FROM (SELECT module_name,operation_id FROM core_module_receipts WHERE module_name=?1 AND operation_id=?2 UNION ALL SELECT module_name,operation_id FROM detached_module_receipts WHERE module_name=?1 AND operation_id=?2) receipt LEFT JOIN remote_operation_members member USING(module_name,operation_id) LIMIT 1",
        params![module,operation],|row|row.get(0),
    ).optional()?;
    if owner.is_some_and(|owner| owner != principal.member_id) {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "This operation belongs to another Member",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn admit_operation(
    connection: &Connection,
    context: &BoundModuleContext,
    module: &str,
    operation: &str,
) -> Result<(), StoreError> {
    require_current(connection, context)?;
    require_operation_owner(connection, context, module, operation)
}
