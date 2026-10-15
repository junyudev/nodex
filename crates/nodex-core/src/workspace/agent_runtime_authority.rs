//! Runtime credentials acquire Core resource authority without projecting runtime execution state.

use nodex_core_contracts::workspace::{
    ProjectWorkspaceAgentRuntimeNativeSource, ProjectWorkspaceAgentRuntimeTurnIdentity,
    ProjectWorkspaceTurnAuthority, ProjectWorkspaceTurnAuthorityResolution,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::document::sha256;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::agent_runtime_binding::read_binding;
use super::execution::{persist_turn_authority, require_authority_coordinates};
use super::session_lifecycle::finish_lifecycle_mutation;
use super::session_mutation::{require_session, sqlite_now, validate_id};

#[allow(clippy::too_many_arguments)]
pub(super) fn admit(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
    native_source: &ProjectWorkspaceAgentRuntimeNativeSource,
    parent: Option<&ProjectWorkspaceAgentRuntimeTurnIdentity>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    validate_native_source(native_source)?;
    let binding = read_binding(connection, context, library_id, session_id)?
        .ok_or_else(|| denied("Session has no Agent Runtime execution binding"))?;
    if require_session(connection, library_id, session_id)?.archived {
        return Err(denied("Archived Sessions cannot admit execution authority"));
    }
    if binding.runtime_id != identity.runtime_id {
        return Err(denied(
            "Runtime Turn does not match the bound execution scope",
        ));
    }
    let coordinates =
        require_authority_coordinates(connection, library_id, binding.project_id.as_deref())?;
    let root_thread_id = authority_thread_id(&binding.runtime_id, &binding.runtime_thread_id);
    if let Some(parent) = parent {
        validate_identity(parent)?;
        if parent.runtime_id != identity.runtime_id {
            return Err(denied(
                "Parent and child executions must belong to the same runtime",
            ));
        }
    }
    let authority = ProjectWorkspaceTurnAuthority {
        thread_id: authority_thread_id(&identity.runtime_id, &identity.thread_id),
        turn_id: authority_turn_id(identity),
        root_thread_id,
        actor_project_id: binding.project_id.clone(),
        library_id: coordinates.library_id,
        store_epoch: coordinates.store_epoch,
    };
    let existing_admission = read_admission(connection, identity)?;
    if existing_admission.is_none()
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodex_agent_turn_authorities WHERE thread_id = ?1 AND turn_id = ?2)",
            params![authority.thread_id, authority.turn_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(denied("Retired Runtime Turn identity cannot acquire another Session"));
    }
    if let Some((existing_session, existing_parent, source, active)) = existing_admission
        && (existing_session != session_id
            || existing_parent.as_ref() != parent
            || source.as_ref() != Some(native_source)
            || !active)
    {
        return Err(denied(
            "Runtime Run admission cannot be replaced or reactivated",
        ));
    }
    persist_turn_authority(connection, &coordinates.profile_id, &authority)?;
    connection.execute(
        "INSERT INTO nodex_agent_runtime_turn_admissions(\
           runtime_id, runtime_thread_id, runtime_run_id, runtime_lease_id, authority_thread_id, authority_turn_id, session_id, \
           parent_runtime_thread_id, parent_runtime_run_id, parent_runtime_lease_id, native_provider_session_id, native_generation, active\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1) \
         ON CONFLICT(runtime_id, runtime_thread_id, runtime_run_id, runtime_lease_id) DO NOTHING",
        params![
            identity.runtime_id,
            identity.thread_id,
            identity.run_id,
            identity.lease_id,
            authority.thread_id,
            authority.turn_id,
            session_id,
            parent.map(|parent| parent.thread_id.as_str()),
            parent.map(|parent| parent.run_id.as_str()),
            parent.map(|parent| parent.lease_id.as_str()),
            native_source.provider_session_id,
            native_source.native_generation,
        ],
    )?;
    finish_authority_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "admit_agent_runtime_turn_authority",
        binding.project_id.as_deref(),
    )
}

pub(super) fn read_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
) -> Result<ProjectWorkspaceTurnAuthorityResolution, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    let Some((session_id, _, _, active)) = read_admission(connection, identity)? else {
        return Ok(unavailable_resolution(false));
    };
    if !active {
        return Ok(unavailable_resolution(true));
    }
    let binding = read_binding(connection, context, library_id, &session_id)?
        .ok_or_else(|| denied("Runtime Turn's Session binding is unavailable"))?;
    if binding.runtime_id != identity.runtime_id {
        return Err(denied("Runtime Turn's engine identity is stale"));
    }
    super::execution::resolve_turn_authority(
        connection,
        library_id,
        &authority_thread_id(&identity.runtime_id, &identity.thread_id),
        &authority_turn_id(identity),
        &authority_thread_id(&binding.runtime_id, &binding.runtime_thread_id),
        binding.project_id.as_deref(),
    )
}

pub(super) fn validate_admission(
    connection: &Connection,
    library_id: &str,
    authority: &ProjectWorkspaceTurnAuthority,
) -> Result<Option<String>, StoreError> {
    if authority.turn_id.starts_with("runtime-native-session:") {
        return super::agent_runtime_native_session::validate_admission(
            connection, library_id, authority,
        );
    }
    let binding = connection
        .query_row(
            "SELECT admission.session_id, binding.runtime_id, binding.runtime_thread_id \
             FROM nodex_agent_runtime_turn_admissions admission \
             JOIN project_session_execution_bindings binding ON binding.session_id = admission.session_id \
               AND binding.runtime_id = admission.runtime_id \
             WHERE admission.authority_thread_id = ?1 AND admission.authority_turn_id = ?2 \
               AND admission.active = 1",
            params![authority.thread_id, authority.turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()?
        .ok_or_else(|| denied("Runtime Turn content authority is unavailable or revoked"))?;
    let session = require_session(connection, library_id, &binding.0)?;
    if session.archived || authority.root_thread_id != authority_thread_id(&binding.1, &binding.2) {
        return Err(denied(
            "Runtime Turn content authority no longer matches its Session",
        ));
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
    runtime_id: &str,
    lease_id: Option<&str>,
    identity: Option<&ProjectWorkspaceAgentRuntimeTurnIdentity>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    if let Some(identity) = identity {
        validate_identity(identity)?;
        connection.execute(
            "UPDATE nodex_agent_runtime_turn_admissions SET active = 0 \
             WHERE runtime_id = ?1 AND runtime_thread_id = ?2 AND runtime_run_id = ?3 AND runtime_lease_id = ?4 AND active = 1",
            params![identity.runtime_id, identity.thread_id, identity.run_id, identity.lease_id],
        )?;
    } else if let Some(lease_id) = lease_id {
        validate_id("runtime_lease_id", lease_id)?;
        connection.execute(
            "UPDATE nodex_agent_runtime_turn_admissions INDEXED BY nodex_agent_runtime_active_admissions \
             SET active = 0 WHERE runtime_id = ?1 AND runtime_lease_id = ?2 AND active = 1",
            params![runtime_id, lease_id],
        )?;
    } else {
        connection.execute(
            "UPDATE nodex_agent_runtime_turn_admissions INDEXED BY nodex_agent_runtime_active_admissions \
             SET active = 0 WHERE runtime_id = ?1 AND active = 1",
            [runtime_id],
        )?;
    }
    if identity.is_none() {
        super::agent_runtime_native_session::revoke_matching(connection, runtime_id, lease_id)?;
    }
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "revoke_agent_runtime_authority",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        None,
        sqlite_now(connection)?,
    )
}

type Admission = (
    String,
    Option<ProjectWorkspaceAgentRuntimeTurnIdentity>,
    Option<ProjectWorkspaceAgentRuntimeNativeSource>,
    bool,
);

fn read_admission(
    connection: &Connection,
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
) -> Result<Option<Admission>, StoreError> {
    connection
        .query_row(
            "SELECT session_id, parent_runtime_thread_id, parent_runtime_run_id, parent_runtime_lease_id, native_provider_session_id, native_generation, active \
             FROM nodex_agent_runtime_turn_admissions \
             WHERE runtime_id = ?1 AND runtime_thread_id = ?2 AND runtime_run_id = ?3 AND runtime_lease_id = ?4",
            params![identity.runtime_id, identity.thread_id, identity.run_id, identity.lease_id],
            |row| {
                let parent_thread: Option<String> = row.get(1)?;
                let parent_run: Option<String> = row.get(2)?;
                let parent_lease: Option<String> = row.get(3)?;
                let parent = parent_thread.zip(parent_run).zip(parent_lease).map(|((thread_id, run_id), lease_id)| {
                    ProjectWorkspaceAgentRuntimeTurnIdentity {
                        runtime_id: identity.runtime_id.clone(),
                        thread_id,
                        run_id,
                        lease_id,
                    }
                });
                let source = row.get::<_, Option<String>>(4)?.zip(row.get::<_,Option<u32>>(5)?).map(|(provider_session_id,native_generation)| ProjectWorkspaceAgentRuntimeNativeSource{provider_session_id,native_generation});
                Ok((row.get(0)?, parent, source, row.get(6)?))
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn authority_thread_id(runtime_id: &str, thread_id: &str) -> String {
    let identity =
        serde_json::to_vec(&(runtime_id, thread_id)).expect("String identity serialization");
    format!("runtime:{}", sha256(&identity))
}

fn authority_turn_id(identity: &ProjectWorkspaceAgentRuntimeTurnIdentity) -> String {
    let coordinate = serde_json::to_vec(&(&identity.run_id, &identity.lease_id))
        .expect("String identity serialization");
    format!("runtime-run:{}", sha256(&coordinate))
}

fn validate_identity(
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
) -> Result<(), StoreError> {
    validate_id("runtime_id", &identity.runtime_id)?;
    validate_id("runtime_thread_id", &identity.thread_id)?;
    validate_id("runtime_run_id", &identity.run_id)?;
    validate_id("runtime_lease_id", &identity.lease_id)
}

pub(super) fn validate_native_source(
    source: &ProjectWorkspaceAgentRuntimeNativeSource,
) -> Result<(), StoreError> {
    validate_id("provider_session_id", &source.provider_session_id)?;
    if source.native_generation == 0 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Native generation must be positive",
            false,
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn revoke_native_source(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    runtime_id: &str,
    lease_id: &str,
    source: &ProjectWorkspaceAgentRuntimeNativeSource,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_lease_id", lease_id)?;
    validate_native_source(source)?;
    connection.execute(
        "UPDATE nodex_agent_runtime_turn_admissions SET active=0 WHERE runtime_id=?1 AND runtime_lease_id=?2 AND native_provider_session_id=?3 AND native_generation=?4 AND active=1",
        params![runtime_id,lease_id,source.provider_session_id,source.native_generation],
    )?;
    connection.execute(
        "UPDATE nodex_agent_runtime_native_session_admissions SET active=0 WHERE runtime_id=?1 AND runtime_lease_id=?2 AND provider_session_id=?3 AND native_generation=?4 AND active=1",
        params![runtime_id,lease_id,source.provider_session_id,source.native_generation],
    )?;
    finish_authority_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "revoke_agent_runtime_native_source_authorities",
        None,
    )
}

pub(super) fn require_host(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(denied("Agent Runtime management requires the Desktop Host"))
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn unavailable_resolution(persisted: bool) -> ProjectWorkspaceTurnAuthorityResolution {
    ProjectWorkspaceTurnAuthorityResolution {
        authority: None,
        persisted,
        admitted_at_ms: None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish_authority_mutation(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    operation: &'static str,
    project_id: Option<&str>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    // Credential admission changes no Session presentation or runtime activity projection.
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        operation,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        project_id,
        sqlite_now(connection)?,
    )
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        TestWorkspace, apply, context, create_project, read, request, seeded_workspace,
    };
    use super::*;
    use nodex_core_contracts::agent::AgentTurnProvenance;
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue,
    };
    use nodex_core_contracts::{
        CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION, StoreEpoch,
    };
    fn identity(thread: &str, run: &str) -> ProjectWorkspaceAgentRuntimeTurnIdentity {
        ProjectWorkspaceAgentRuntimeTurnIdentity {
            runtime_id: "engine:one".into(),
            thread_id: thread.into(),
            run_id: run.into(),
            lease_id: "lease:one".into(),
        }
    }
    fn launch(session: &str, thread: &str, project: Option<&str>) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: session.into(),
            replacement_default_session_id: format!("replacement:{session}"),
            project_id: project.map(str::to_owned),
            title: "Task".into(),
            initial_page_ids: vec![],
            runtime_id: "engine:one".into(),
            runtime_thread_id: thread.into(),
            launch_request_id: format!("launch:{session}"),
        }
    }
    fn setup() -> TestWorkspace {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "session",
            launch("session:root", "thread:root", Some("project:default")),
        );
        workspace
    }
    fn admission(
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
        parent: Option<ProjectWorkspaceAgentRuntimeTurnIdentity>,
    ) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
            session_id: "session:root".into(),
            identity,
            native_source: ProjectWorkspaceAgentRuntimeNativeSource {
                provider_session_id: "native-session:one".into(),
                native_generation: 1,
            },
            parent,
        }
    }
    fn resolution(
        workspace: &TestWorkspace,
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
    ) -> ProjectWorkspaceTurnAuthorityResolution {
        let ProjectWorkspaceReadValue::AgentRuntimeTurnAuthority { resolution } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeTurnAuthority { identity },
        ) else {
            panic!("execution identity")
        };
        resolution
    }
    fn provenance(
        workspace: &TestWorkspace,
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
    ) -> AgentTurnProvenance {
        AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: resolution(workspace, identity).authority.expect("admitted"),
        }
    }
    fn preflight(
        workspace: &TestWorkspace,
        provenance: AgentTurnProvenance,
    ) -> Result<
        nodex_core_contracts::ModuleReadSnapshot<ProjectWorkspaceReadValue>,
        nodex_core_contracts::CoreError,
    > {
        workspace.module.read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::AgentAuthority { provenance },
            },
        )
    }

    #[test]
    fn captured_execution_identity_is_live_until_exact_revocation_and_replay_never_revives_it() {
        let w = setup();
        let root = identity("thread:root", "run:one");
        let intent = admission(root.clone(), None);
        apply(&w.module, "admit", intent.clone());
        let credential = provenance(&w, root.clone());
        let valid = preflight(&w, credential.clone()).unwrap();
        let ProjectWorkspaceReadValue::AgentAuthority { resolution: r } = valid.value else {
            panic!("identity")
        };
        assert!(r.persisted && r.admitted_at_ms.is_some());
        let mut forged = credential.clone();
        forged.authority.turn_id = "turn:other".into();
        assert_eq!(
            preflight(&w, forged).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let mut foreign = credential.clone();
        foreign.profile_id = "profile:foreign".into();
        assert_eq!(
            preflight(&w, foreign).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        apply(
            &w.module,
            "cancel",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: root.clone(),
            },
        );
        let replay = w
            .module
            .apply(&context(), request("admit", intent))
            .unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(resolution(&w, root).authority.is_none());
        assert_eq!(
            preflight(&w, credential).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
    }
    #[test]
    fn child_and_background_execution_do_not_require_a_live_foreground_parent() {
        let w = setup();
        let parent = identity("thread:root", "run:parent");
        apply(&w.module, "parent", admission(parent.clone(), None));
        apply(
            &w.module,
            "parent-ended",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: parent.clone(),
            },
        );
        let child = identity("thread:child", "run:child");
        apply(
            &w.module,
            "child",
            admission(child.clone(), Some(parent.clone())),
        );
        let credential = provenance(&w, child.clone());
        preflight(&w, credential.clone()).unwrap();
        let mut unknown_parent = identity("thread:unknown", "run:past");
        unknown_parent.lease_id = "lease:past".into();
        let background = identity("thread:background", "run:captured");
        apply(
            &w.module,
            "background",
            admission(background.clone(), Some(unknown_parent)),
        );
        assert!(resolution(&w, background).authority.is_some());
        assert!(resolution(&w, parent).authority.is_none());
        preflight(&w, credential).unwrap();
    }
    #[test]
    fn project_context_is_routing_and_does_not_restrict_profile_operations() {
        let w = setup();
        create_project(&w.module, "other", "project:other");
        apply(
            &w.module,
            "other-session",
            launch("session:other", "thread:other", Some("project:other")),
        );
        let run = identity("thread:root", "run:plan");
        apply(&w.module, "admit", admission(run.clone(), None));
        let credential = provenance(&w, run);
        let agent = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        w.module
            .apply(
                &agent,
                request(
                    "rename-other",
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance: Box::new(credential.clone()),
                        intent: Box::new(ProjectWorkspaceIntent::MutateSession {
                            session_id: "session:other".into(),
                            intent: ProjectSessionIntent::Rename {
                                title: "Changed from planning".into(),
                            },
                        }),
                    },
                ),
            )
            .unwrap();
        let response = w
            .module
            .read(
                &agent,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentSession {
                        provenance: credential,
                        session_id: "session:other".into(),
                    },
                },
            )
            .unwrap();
        assert!(
            matches!(response.value,ProjectWorkspaceReadValue::AgentSession{session,..} if session.display_title=="Changed from planning")
        );
    }
    #[test]
    fn session_movement_changes_routing_without_replacing_execution_identity() {
        let w = setup();
        create_project(&w.module, "other", "project:other");
        let run = identity("thread:root", "run:move");
        apply(&w.module, "admit", admission(run.clone(), None));
        let credential = provenance(&w, run.clone());
        apply(
            &w.module,
            "move",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:root".into(),
                project_id: Some("project:other".into()),
            },
        );
        let current = resolution(&w, run).authority.unwrap();
        assert_eq!(current.actor_project_id.as_deref(), Some("project:other"));
        assert_eq!(current.thread_id, credential.authority.thread_id);
        assert_eq!(current.turn_id, credential.authority.turn_id);
        preflight(&w, credential).expect("captured identity remains live after routing changes");
    }
    #[test]
    fn generation_retirement_and_new_store_epoch_require_new_credentials() {
        let w = setup();
        let old = identity("thread:root", "run:resumed");
        apply(&w.module, "admit", admission(old.clone(), None));
        let credential = provenance(&w, old.clone());
        apply(
            &w.module,
            "retire",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: "engine:one".into(),
                lease_id: Some("lease:one".into()),
            },
        );
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
        assert_eq!(
            preflight(&w, credential).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let mut resumed = old.clone();
        resumed.lease_id = "lease:new".into();
        let mut input = request("resume", admission(resumed.clone(), None));
        input.store_epoch = StoreEpoch("epoch:new".into());
        w.module.apply(&context(), input).unwrap();
        assert!(resolution(&w, old).authority.is_none());
        let result = resolution(&w, resumed);
        assert_eq!(result.authority.unwrap().store_epoch, "epoch:new");
    }
    #[test]
    fn session_archive_retires_credentials_without_reactivating_them_on_unarchive() {
        let w = setup();
        let old = identity("thread:root", "run:previous");
        apply(&w.module, "admit", admission(old.clone(), None));
        apply(
            &w.module,
            "archive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:root".into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        assert!(resolution(&w, old.clone()).authority.is_none());
        apply(
            &w.module,
            "unarchive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:root".into(),
                intent: ProjectSessionIntent::SetArchived { archived: false },
            },
        );
        assert!(
            w.module
                .apply(&context(), request("revive", admission(old, None)))
                .is_err()
        );
        let fresh = identity("thread:root", "run:fresh");
        apply(&w.module, "fresh", admission(fresh.clone(), None));
        assert!(resolution(&w, fresh).authority.is_some());
    }
    #[test]
    fn failed_receipt_publication_rolls_back_execution_admission() {
        let w = setup();
        w.kernel.writer().call(|c|{c.execute_batch("CREATE TRIGGER deny_admission_receipt BEFORE INSERT ON core_module_receipts WHEN NEW.operation_id='rejected' BEGIN SELECT RAISE(ABORT,'fixture rejected receipt'); END;")?;Ok(())}).unwrap();
        let run = identity("thread:root", "run:failed");
        assert!(
            w.module
                .apply(
                    &context(),
                    request("rejected", admission(run.clone(), None))
                )
                .is_err()
        );
        assert!(resolution(&w, run).authority.is_none());
    }
}
