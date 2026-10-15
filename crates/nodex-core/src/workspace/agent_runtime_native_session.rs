//! A native connection can identify its Session without providing a causal Run.
//! Its opaque credential survives ordinary Runs and is retired with the physical connection.
use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{
    ProjectWorkspaceAgentRuntimeNativeSessionIdentity, ProjectWorkspaceTurnAuthority,
    ProjectWorkspaceTurnAuthorityResolution,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::ProjectWorkspaceApplyOutcome;
use super::agent_runtime_authority::{
    authority_thread_id, finish_authority_mutation, require_host,
};
use super::agent_runtime_binding::read_binding;
use super::execution::{
    persist_turn_authority, require_authority_coordinates, resolve_turn_authority,
};
use super::session_mutation::{require_session, validate_id};
use crate::document::sha256;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

type Identity = ProjectWorkspaceAgentRuntimeNativeSessionIdentity;

#[allow(clippy::too_many_arguments)]
pub(super) fn admit(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    identity: &Identity,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    let binding = read_binding(connection, context, library_id, session_id)?
        .ok_or_else(|| denied("Native connection's Session binding is unavailable"))?;
    if binding.runtime_id != identity.runtime_id
        || require_session(connection, library_id, session_id)?.archived
    {
        return Err(denied("Native connection cannot acquire this Session"));
    }
    if let Some((existing_session, existing_identity, active)) =
        read_admission(connection, identity)?
        && (existing_session != session_id || existing_identity != *identity || !active)
    {
        return Err(denied(
            "Native connection admission cannot be replaced or reactivated",
        ));
    }
    let coordinates =
        require_authority_coordinates(connection, library_id, binding.project_id.as_deref())?;
    let authority = ProjectWorkspaceTurnAuthority {
        thread_id: authority_thread_id(&identity.runtime_id, &identity.thread_id),
        turn_id: credential_id(identity),
        root_thread_id: authority_thread_id(&binding.runtime_id, &binding.runtime_thread_id),
        actor_project_id: binding.project_id.clone(),
        library_id: coordinates.library_id.clone(),
        store_epoch: coordinates.store_epoch.clone(),
    };
    persist_turn_authority(connection, &coordinates.profile_id, &authority)?;
    connection.execute(
        "INSERT INTO nodex_agent_runtime_native_session_admissions(\
           runtime_id,runtime_thread_id,runtime_lease_id,provider_session_id,native_generation,incarnation_id,\
           authority_thread_id,authority_turn_id,session_id,active\
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1) \
         ON CONFLICT(runtime_id,incarnation_id) DO NOTHING",
        params![identity.runtime_id,identity.thread_id,identity.lease_id,identity.provider_session_id,
            identity.native_generation,identity.incarnation_id,authority.thread_id,authority.turn_id,session_id],
    )?;
    finish_authority_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "admit_agent_runtime_native_session_authority",
        binding.project_id.as_deref(),
    )
}

pub(super) fn read_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    identity: &Identity,
) -> Result<ProjectWorkspaceTurnAuthorityResolution, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    let Some((session_id, captured, active)) = read_admission(connection, identity)? else {
        return Ok(unavailable(false));
    };
    if !active || captured != *identity {
        return Ok(unavailable(true));
    }
    let Some(binding) = read_binding(connection, context, library_id, &session_id)? else {
        return Ok(unavailable(true));
    };
    if binding.runtime_id != identity.runtime_id {
        return Ok(unavailable(true));
    }
    resolve_turn_authority(
        connection,
        library_id,
        &authority_thread_id(&identity.runtime_id, &identity.thread_id),
        &credential_id(identity),
        &authority_thread_id(&binding.runtime_id, &binding.runtime_thread_id),
        binding.project_id.as_deref(),
    )
}

pub(super) fn validate_admission(
    connection: &Connection,
    library_id: &str,
    authority: &ProjectWorkspaceTurnAuthority,
) -> Result<Option<String>, StoreError> {
    let (session_id,runtime_id,root_id) = connection.query_row(
        "SELECT admission.session_id,binding.runtime_id,binding.runtime_thread_id \
         FROM nodex_agent_runtime_native_session_admissions admission \
         JOIN project_session_execution_bindings binding ON binding.session_id=admission.session_id \
           AND binding.runtime_id=admission.runtime_id \
         WHERE admission.authority_thread_id=?1 AND admission.authority_turn_id=?2 AND admission.active=1",
        params![authority.thread_id,authority.turn_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)),
    ).optional()?.ok_or_else(|| denied("Native connection identity is unavailable or retired"))?;
    let session = require_session(connection, library_id, &session_id)?;
    if session.archived || authority.root_thread_id != authority_thread_id(&runtime_id, &root_id) {
        return Err(denied("Native connection no longer matches its Session"));
    }
    Ok(session.project_id)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn revoke(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    identity: &Identity,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    connection.execute(
        "UPDATE nodex_agent_runtime_native_session_admissions SET active=0 \
         WHERE runtime_id=?1 AND runtime_thread_id=?2 AND runtime_lease_id=?3 \
           AND provider_session_id=?4 AND native_generation=?5 AND incarnation_id=?6 AND active=1",
        params![
            identity.runtime_id,
            identity.thread_id,
            identity.lease_id,
            identity.provider_session_id,
            identity.native_generation,
            identity.incarnation_id
        ],
    )?;
    finish_authority_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "revoke_agent_runtime_native_session_authority",
        None,
    )
}

pub(super) fn retire_session(connection: &Connection, session_id: &str) -> Result<(), StoreError> {
    connection.execute("UPDATE nodex_agent_runtime_native_session_admissions SET active=0 WHERE session_id=?1 AND active=1", [session_id])?;
    Ok(())
}

pub(super) fn revoke_matching(
    connection: &Connection,
    runtime_id: &str,
    lease_id: Option<&str>,
) -> Result<(), StoreError> {
    if let Some(lease_id) = lease_id {
        connection.execute("UPDATE nodex_agent_runtime_native_session_admissions SET active=0 WHERE runtime_id=?1 AND runtime_lease_id=?2 AND active=1",params![runtime_id,lease_id])?;
    } else {
        connection.execute("UPDATE nodex_agent_runtime_native_session_admissions SET active=0 WHERE runtime_id=?1 AND active=1",[runtime_id])?;
    }
    Ok(())
}

fn read_admission(
    connection: &Connection,
    identity: &Identity,
) -> Result<Option<(String, Identity, bool)>, StoreError> {
    connection
        .query_row(
            "SELECT session_id,runtime_thread_id,provider_session_id,native_generation,runtime_lease_id,active \
         FROM nodex_agent_runtime_native_session_admissions \
         WHERE runtime_id=?1 AND incarnation_id=?2",
            params![identity.runtime_id, identity.incarnation_id],
            |row| {
                Ok((
                    row.get(0)?,
                    Identity {
                        runtime_id: identity.runtime_id.clone(),
                        thread_id: row.get(1)?,
                        lease_id: row.get(4)?,
                        provider_session_id: row.get(2)?,
                        native_generation: row.get(3)?,
                        incarnation_id: identity.incarnation_id.clone(),
                    },
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(Into::into)
}
fn credential_id(identity: &Identity) -> String {
    let coordinate = serde_json::to_vec(&(
        identity.provider_session_id.as_str(),
        identity.native_generation,
        identity.incarnation_id.as_str(),
        identity.lease_id.as_str(),
    ))
    .expect("Native identity serialization");
    format!("runtime-native-session:{}", sha256(&coordinate))
}
fn validate_identity(identity: &Identity) -> Result<(), StoreError> {
    for (name, value) in [
        ("runtime_id", &identity.runtime_id),
        ("runtime_thread_id", &identity.thread_id),
        ("runtime_lease_id", &identity.lease_id),
        ("provider_session_id", &identity.provider_session_id),
        ("incarnation_id", &identity.incarnation_id),
    ] {
        validate_id(name, value)?;
    }
    if identity.native_generation == 0 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Native generation must be positive",
            false,
        ));
    }
    Ok(())
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
fn unavailable(persisted: bool) -> ProjectWorkspaceTurnAuthorityResolution {
    ProjectWorkspaceTurnAuthorityResolution {
        authority: None,
        persisted,
        admitted_at_ms: None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        TestWorkspace, apply, context, create_project, read, request, seeded_workspace,
    };
    use super::*;
    use nodex_core_contracts::agent::AgentTurnProvenance;
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceAgentRuntimeTurnIdentity, ProjectWorkspaceIntent,
        ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
        StoreEpoch,
    };
    fn identity(incarnation: &str) -> Identity {
        Identity {
            runtime_id: "engine:one".into(),
            thread_id: "thread:root".into(),
            lease_id: "lease:one".into(),
            provider_session_id: "native-session:one".into(),
            native_generation: 1,
            incarnation_id: incarnation.into(),
        }
    }
    fn setup() -> TestWorkspace {
        let w = seeded_workspace();
        apply(
            &w.module,
            "launch",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                session_id: "session:root".into(),
                replacement_default_session_id: "session:replacement".into(),
                project_id: Some("project:default".into()),
                title: "Task".into(),
                initial_page_ids: vec![],
                runtime_id: "engine:one".into(),
                runtime_thread_id: "thread:root".into(),
                launch_request_id: "launch:root".into(),
            },
        );
        w
    }
    fn admission(identity: Identity) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AdmitAgentRuntimeNativeSessionAuthority {
            session_id: "session:root".into(),
            identity,
        }
    }
    fn resolution(
        w: &TestWorkspace,
        identity: Identity,
    ) -> ProjectWorkspaceTurnAuthorityResolution {
        let ProjectWorkspaceReadValue::AgentRuntimeNativeSessionAuthority { resolution } = read(
            &w.module,
            ProjectWorkspaceRead::AgentRuntimeNativeSessionAuthority { identity },
        ) else {
            panic!("native identity")
        };
        resolution
    }
    fn credential(w: &TestWorkspace, identity: Identity) -> AgentTurnProvenance {
        AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: resolution(w, identity).authority.unwrap(),
        }
    }
    fn preflight(w: &TestWorkspace, provenance: AgentTurnProvenance) -> Result<(), CoreErrorCode> {
        w.module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentAuthority { provenance },
                },
            )
            .map(|_| ())
            .map_err(|e| e.code)
    }
    #[test]
    fn native_actor_survives_successive_runs_without_becoming_any_run() {
        let w = setup();
        let native = identity("incarnation:one");
        apply(&w.module, "native", admission(native.clone()));
        let original = credential(&w, native.clone());
        for name in ["first", "second"] {
            apply(
                &w.module,
                &format!("run:{name}"),
                ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
                    session_id: "session:root".into(),
                    identity: ProjectWorkspaceAgentRuntimeTurnIdentity {
                        runtime_id: "engine:one".into(),
                        thread_id: "thread:root".into(),
                        run_id: format!("run:{name}"),
                        lease_id: "lease:one".into(),
                    },
                    native_source:
                        nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeNativeSource {
                            provider_session_id: "native-session:one".into(),
                            native_generation: 1,
                        },
                    parent: None,
                },
            );
            assert_eq!(credential(&w, native.clone()), original);
            preflight(&w, original.clone()).unwrap();
        }
        create_project(&w.module, "other", "project:other");
        apply(
            &w.module,
            "other-session",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                session_id: "session:other".into(),
                replacement_default_session_id: "session:other-draft".into(),
                project_id: Some("project:other".into()),
                title: "Other".into(),
                initial_page_ids: vec![],
                runtime_id: "engine:one".into(),
                runtime_thread_id: "thread:other".into(),
                launch_request_id: "launch:other".into(),
            },
        );
        let caller = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        w.module
            .apply(
                &caller,
                request(
                    "native-write",
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance: Box::new(original),
                        intent: Box::new(ProjectWorkspaceIntent::MutateSession {
                            session_id: "session:other".into(),
                            intent: ProjectSessionIntent::SetFallbackTitle {
                                title: "Native tool edit".into(),
                            },
                        }),
                    },
                ),
            )
            .unwrap();
        let ProjectWorkspaceReadValue::Session { session } = read(
            &w.module,
            ProjectWorkspaceRead::Session {
                session_id: "session:other".into(),
            },
        ) else {
            panic!("edited Session")
        };
        assert_eq!(session.no_thread_fallback_title, "Native tool edit");
        w.kernel
            .writer()
            .call(|c| {
                let runs: i64 = c.query_row(
                    "SELECT count(*) FROM nodex_agent_runtime_turn_admissions",
                    [],
                    |r| r.get(0),
                )?;
                let natives: i64 = c.query_row(
                    "SELECT count(*) FROM nodex_agent_runtime_native_session_admissions",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!((runs, natives), (2, 1));
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn cancellation_is_exact_irreversible_and_does_not_retire_a_live_replacement() {
        let w = setup();
        let old = identity("incarnation:old");
        let fresh = identity("incarnation:new");
        let intent = admission(old.clone());
        apply(&w.module, "old", intent.clone());
        let old_credential = credential(&w, old.clone());
        apply(&w.module, "fresh", admission(fresh.clone()));
        apply(
            &w.module,
            "cancel",
            ProjectWorkspaceIntent::RevokeAgentRuntimeNativeSessionAuthority {
                identity: old.clone(),
            },
        );
        assert!(resolution(&w, old.clone()).authority.is_none());
        assert_eq!(
            preflight(&w, old_credential),
            Err(CoreErrorCode::Unauthorized)
        );
        preflight(&w, credential(&w, fresh)).unwrap();
        assert!(
            w.module
                .apply(&context(), request("old", intent.clone()))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert!(
            w.module
                .apply(&context(), request("reactivate", intent))
                .is_err()
        );
        assert!(resolution(&w, old).authority.is_none());
    }
    #[test]
    fn physical_source_retirement_fences_all_captured_runs_and_native_actors_atomically() {
        use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeNativeSource;
        let w = setup();
        let source = ProjectWorkspaceAgentRuntimeNativeSource {
            provider_session_id: "native-session:one".into(),
            native_generation: 1,
        };
        let native = identity("incarnation:one");
        let replacement = Identity {
            native_generation: 2,
            ..identity("incarnation:replacement")
        };
        apply(&w.module, "native", admission(native.clone()));
        apply(&w.module, "replacement", admission(replacement.clone()));
        let mut runs = Vec::new();
        for run in ["first", "second"] {
            let identity = ProjectWorkspaceAgentRuntimeTurnIdentity {
                runtime_id: "engine:one".into(),
                thread_id: "thread:root".into(),
                run_id: format!("run:{run}"),
                lease_id: "lease:one".into(),
            };
            apply(
                &w.module,
                &format!("admit:{run}"),
                ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
                    session_id: "session:root".into(),
                    identity: identity.clone(),
                    native_source: source.clone(),
                    parent: None,
                },
            );
            let ProjectWorkspaceReadValue::AgentRuntimeTurnAuthority { resolution } = read(
                &w.module,
                ProjectWorkspaceRead::AgentRuntimeTurnAuthority { identity },
            ) else {
                panic!("Run")
            };
            runs.push(AgentTurnProvenance {
                profile_id: "profile-1".into(),
                authority: resolution.authority.unwrap(),
            });
        }
        w.kernel.writer().call(|c|{c.execute_batch("CREATE TRIGGER deny_source_close_receipt BEFORE INSERT ON core_module_receipts WHEN NEW.operation_id='close-failed' BEGIN SELECT RAISE(ABORT,'fixture rejected receipt'); END;")?;Ok(())}).unwrap();
        let close = ProjectWorkspaceIntent::RevokeAgentRuntimeNativeSourceAuthorities {
            runtime_id: "engine:one".into(),
            lease_id: "lease:one".into(),
            native_source: source,
        };
        assert!(
            w.module
                .apply(&context(), request("close-failed", close.clone()))
                .is_err()
        );
        preflight(&w, credential(&w, native.clone())).unwrap();
        for run in &runs {
            preflight(&w, run.clone()).unwrap();
        }
        apply(&w.module, "close", close);
        assert!(resolution(&w, native).authority.is_none());
        for run in runs {
            assert_eq!(preflight(&w, run), Err(CoreErrorCode::Unauthorized));
        }
        preflight(&w, credential(&w, replacement)).unwrap();
    }

    #[test]
    fn native_incarnation_cannot_rebind_and_only_the_host_can_admit_it() {
        let w = setup();
        let native = identity("incarnation:one");
        apply(&w.module, "native", admission(native.clone()));
        for changed in [
            Identity {
                thread_id: "thread:other".into(),
                ..native.clone()
            },
            Identity {
                provider_session_id: "provider:other".into(),
                ..native.clone()
            },
            Identity {
                native_generation: 2,
                ..native.clone()
            },
            Identity {
                lease_id: "lease:other".into(),
                ..native.clone()
            },
        ] {
            assert!(
                w.module
                    .apply(&context(), request("changed", admission(changed.clone())))
                    .is_err()
            );
            assert!(resolution(&w, changed).authority.is_none());
        }
        let caller = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        assert_eq!(
            w.module
                .apply(
                    &caller,
                    request("forged", admission(identity("incarnation:forged")))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert!(
            w.module
                .apply(
                    &context(),
                    request(
                        "invalid-generation",
                        admission(Identity {
                            native_generation: 0,
                            ..native
                        })
                    )
                )
                .is_err()
        );
    }
    #[test]
    fn archive_delete_and_epoch_changes_fence_the_original_native_actor() {
        let w = setup();
        let native = identity("incarnation:one");
        apply(&w.module, "native", admission(native.clone()));
        let captured = credential(&w, native.clone());
        apply(
            &w.module,
            "archive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:root".into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        apply(
            &w.module,
            "unarchive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:root".into(),
                intent: ProjectSessionIntent::SetArchived { archived: false },
            },
        );
        assert!(resolution(&w, native.clone()).authority.is_none());
        assert_eq!(preflight(&w, captured), Err(CoreErrorCode::Unauthorized));
        let replacement = identity("incarnation:two");
        apply(&w.module, "replacement", admission(replacement.clone()));
        let captured = credential(&w, replacement.clone());
        w.kernel
            .writer()
            .call(|c| {
                c.execute(
                    "UPDATE block_store_metadata SET store_epoch='epoch:new' WHERE id=1",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(resolution(&w, replacement).authority.is_none());
        assert_eq!(preflight(&w, captured), Err(CoreErrorCode::Unauthorized));
        let fresh = Identity {
            lease_id: "lease:new".into(),
            ..identity("incarnation:three")
        };
        let mut admit = request("fresh", admission(fresh.clone()));
        admit.store_epoch = StoreEpoch("epoch:new".into());
        w.module.apply(&context(), admit).unwrap();
        let captured = credential(&w, fresh.clone());
        preflight(&w, captured.clone()).unwrap();
        let mut delete = request(
            "delete",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "session:root".into(),
            },
        );
        delete.store_epoch = StoreEpoch("epoch:new".into());
        w.module.apply(&context(), delete).unwrap();
        assert!(resolution(&w, fresh).authority.is_none());
        assert_eq!(preflight(&w, captured), Err(CoreErrorCode::Unauthorized));
    }
    #[test]
    fn bulk_connection_retirement_preserves_another_connection_and_failed_receipts_rollback() {
        let w = setup();
        let first = identity("incarnation:one");
        let other = Identity {
            lease_id: "lease:other".into(),
            ..identity("incarnation:other")
        };
        apply(&w.module, "first", admission(first.clone()));
        apply(&w.module, "other", admission(other.clone()));
        apply(
            &w.module,
            "retire",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: "engine:one".into(),
                lease_id: Some("lease:one".into()),
            },
        );
        assert!(resolution(&w, first).authority.is_none());
        preflight(&w, credential(&w, other)).unwrap();
        w.kernel.writer().call(|c|{c.execute_batch("CREATE TRIGGER deny_native_receipt BEFORE INSERT ON core_module_receipts WHEN NEW.operation_id='rejected' BEGIN SELECT RAISE(ABORT,'fixture rejected receipt'); END;")?;Ok(())}).unwrap();
        let rejected = identity("incarnation:rejected");
        assert!(
            w.module
                .apply(&context(), request("rejected", admission(rejected.clone())))
                .is_err()
        );
        let resolution = resolution(&w, rejected);
        assert!(!resolution.persisted && resolution.authority.is_none());
    }
}
