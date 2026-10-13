//! Runtime credentials acquire Core resource authority without projecting runtime execution state.

use nodex_core_contracts::workspace::{
    CodexPermissionMode, ProjectWorkspaceAgentRuntimeTurnIdentity, ProjectWorkspaceTurnAuthority,
    ProjectWorkspaceTurnAuthorityResolution, ProjectWorkspaceTurnAuthorityScope,
    ProjectWorkspaceTurnAuthoritySource,
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
use super::thread::{read_permission_mode, read_projectless_permission_mode};

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
    source: ProjectWorkspaceTurnAuthoritySource,
    mut read_only: bool,
    parent: Option<&ProjectWorkspaceAgentRuntimeTurnIdentity>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    let binding = read_binding(connection, context, library_id, session_id)?
        .ok_or_else(|| denied("Session has no Agent Runtime execution binding"))?;
    if binding.runtime_id != identity.runtime_id
        || context.project_id.as_ref().map(|id| id.0.as_str()) != binding.project_id.as_deref()
    {
        return Err(denied(
            "Runtime Turn does not match the bound execution scope",
        ));
    }
    let coordinates =
        require_authority_coordinates(connection, library_id, binding.project_id.as_deref())?;
    let root_thread_id = authority_thread_id(&binding.runtime_id, &binding.runtime_thread_id);
    let scope = match parent {
        Some(parent) => {
            validate_identity(parent)?;
            if parent.runtime_id != identity.runtime_id {
                return Err(denied("Child authority cannot cross Agent Runtimes"));
            }
            let (parent_session, _, _) = read_admission(connection, parent)?
                .ok_or_else(|| denied("Child authority requires an admitted parent Run"))?;
            if parent_session != session_id {
                return Err(denied(
                    "Child authority requires its current parent execution scope",
                ));
            }
            // A completed parent's credential can be revoked while its verified child continues.
            // Inheritance uses immutable parent provenance; the Host verifies live child lineage.
            let parent_resolution = super::execution::resolve_retained_turn_restrictions(
                connection,
                library_id,
                &authority_thread_id(&parent.runtime_id, &parent.thread_id),
                &authority_turn_id(parent),
                &root_thread_id,
                binding.project_id.as_deref(),
            )?;
            let parent_authority = parent_resolution
                .authority
                .ok_or_else(|| denied("Parent Run authority is stale"))?;
            read_only |= parent_resolution.read_only;
            match source {
                ProjectWorkspaceTurnAuthoritySource::ProjectTurn
                    if binding.project_id.is_some() =>
                {
                    ProjectWorkspaceTurnAuthorityScope::Project
                }
                ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess
                    if parent_authority.scope == ProjectWorkspaceTurnAuthorityScope::Library =>
                {
                    ProjectWorkspaceTurnAuthorityScope::Library
                }
                _ => return Err(denied("Child authority cannot broaden its parent scope")),
            }
        }
        None => {
            if identity.thread_id != binding.runtime_thread_id {
                return Err(denied(
                    "A child Runtime Thread requires exact parent authority",
                ));
            }
            root_scope(connection, binding.project_id.as_deref(), source)?
        }
    };
    // A fresh physical credential cannot widen the stable Run's frozen policy.
    if let Some(previous) = read_parent_admission(
        connection,
        context,
        library_id,
        &identity.runtime_id,
        &identity.thread_id,
        &identity.run_id,
    )? {
        let previous = read_authority(connection, context, library_id, &previous, true)?;
        let previous_authority = previous
            .authority
            .ok_or_else(|| denied("Previous Run authority is stale"))?;
        if previous_authority.scope == ProjectWorkspaceTurnAuthorityScope::Project
            && scope == ProjectWorkspaceTurnAuthorityScope::Library
        {
            return Err(denied("A resumed Run cannot broaden its frozen scope"));
        }
        read_only |= previous.read_only;
    }
    let authority = ProjectWorkspaceTurnAuthority {
        thread_id: authority_thread_id(&identity.runtime_id, &identity.thread_id),
        turn_id: authority_turn_id(identity),
        root_thread_id,
        actor_project_id: binding.project_id.clone(),
        library_id: coordinates.library_id,
        store_epoch: coordinates.store_epoch,
        scope,
        source,
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
    if let Some((existing_session, existing_parent, active)) = existing_admission
        && (existing_session != session_id || existing_parent.as_ref() != parent || !active)
    {
        return Err(denied(
            "Runtime Run admission cannot be replaced or reactivated",
        ));
    }
    persist_turn_authority(connection, &coordinates.profile_id, &authority, read_only)?;
    connection.execute(
        "INSERT INTO nodex_agent_runtime_turn_admissions(\
           runtime_id, runtime_thread_id, runtime_run_id, runtime_lease_id, authority_thread_id, authority_turn_id, session_id, \
           parent_runtime_thread_id, parent_runtime_run_id, parent_runtime_lease_id, active\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1) \
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

/// Revoked parent evidence remains readable without restoring its tool credential.
pub(super) fn read_parent_admission(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    runtime_id: &str,
    thread_id: &str,
    run_id: &str,
) -> Result<Option<ProjectWorkspaceAgentRuntimeTurnIdentity>, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_thread_id", thread_id)?;
    validate_id("runtime_run_id", run_id)?;
    let record = connection
        .query_row(
            "SELECT session_id, runtime_lease_id FROM nodex_agent_runtime_turn_admissions \
         INDEXED BY nodex_agent_runtime_parent_admissions \
         WHERE runtime_id = ?1 AND runtime_thread_id = ?2 AND runtime_run_id = ?3 \
         ORDER BY admission_sequence DESC LIMIT 1",
            params![runtime_id, thread_id, run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((session_id, lease_id)) = record else {
        return Ok(None);
    };
    let binding = read_binding(connection, context, library_id, &session_id)?
        .ok_or_else(|| denied("Parent Run's Session binding is unavailable"))?;
    if binding.runtime_id != runtime_id {
        return Err(denied("Parent Run's engine identity is stale"));
    }
    Ok(Some(ProjectWorkspaceAgentRuntimeTurnIdentity {
        runtime_id: runtime_id.to_owned(),
        thread_id: thread_id.to_owned(),
        run_id: run_id.to_owned(),
        lease_id,
    }))
}

pub(super) fn read_authority(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
    include_revoked: bool,
) -> Result<ProjectWorkspaceTurnAuthorityResolution, StoreError> {
    require_host(context)?;
    validate_identity(identity)?;
    let Some((session_id, _, active)) = read_admission(connection, identity)? else {
        return Ok(unavailable_resolution(false));
    };
    if !active && !include_revoked {
        return Ok(unavailable_resolution(true));
    }
    let binding = read_binding(connection, context, library_id, &session_id)?
        .ok_or_else(|| denied("Runtime Turn's Session binding is unavailable"))?;
    if binding.runtime_id != identity.runtime_id {
        return Err(denied("Runtime Turn's engine identity is stale"));
    }
    let resolve = if include_revoked {
        super::execution::resolve_retained_turn_restrictions
    } else {
        super::execution::resolve_turn_authority
    };
    resolve(
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
) -> Result<(), StoreError> {
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
    if session.project_id != authority.actor_project_id
        || authority.root_thread_id != authority_thread_id(&binding.1, &binding.2)
    {
        return Err(denied(
            "Runtime Turn content authority no longer matches its Session",
        ));
    }
    Ok(())
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

fn root_scope(
    connection: &Connection,
    project_id: Option<&str>,
    source: ProjectWorkspaceTurnAuthoritySource,
) -> Result<ProjectWorkspaceTurnAuthorityScope, StoreError> {
    match source {
        ProjectWorkspaceTurnAuthoritySource::ProjectTurn if project_id.is_some() => {
            Ok(ProjectWorkspaceTurnAuthorityScope::Project)
        }
        ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess => {
            let mode = match project_id {
                Some(project_id) => read_permission_mode(connection, project_id)?,
                None => read_projectless_permission_mode(connection)?,
            };
            if mode != Some(CodexPermissionMode::FullAccess) {
                return Err(denied(
                    "Library authority requires the persisted full-access mode",
                ));
            }
            Ok(ProjectWorkspaceTurnAuthorityScope::Library)
        }
        _ => Err(denied("Runtime root authority has an invalid source")),
    }
}

type Admission = (
    String,
    Option<ProjectWorkspaceAgentRuntimeTurnIdentity>,
    bool,
);

fn read_admission(
    connection: &Connection,
    identity: &ProjectWorkspaceAgentRuntimeTurnIdentity,
) -> Result<Option<Admission>, StoreError> {
    connection
        .query_row(
            "SELECT session_id, parent_runtime_thread_id, parent_runtime_run_id, parent_runtime_lease_id, active \
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
                Ok((row.get(0)?, parent, row.get(4)?))
            },
        )
        .optional()
        .map_err(Into::into)
}

fn authority_thread_id(runtime_id: &str, thread_id: &str) -> String {
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

fn require_host(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(denied(
        "Runtime Turn authority admission requires the Desktop Host",
    ))
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn unavailable_resolution(persisted: bool) -> ProjectWorkspaceTurnAuthorityResolution {
    ProjectWorkspaceTurnAuthorityResolution {
        authority: None,
        persisted,
        read_only: true,
        frozen_at_ms: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_authority_mutation(
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
    use nodex_core_contracts::agent::{
        AgentAuthorizationTarget, AgentProjectResourceAction, AgentResourceAccessPlan,
        AgentResourceAuthorizationReason, AgentResourceIntent, AgentTurnProvenance,
    };
    use nodex_core_contracts::library::{LibraryRead, LibraryReadValue};
    use nodex_core_contracts::workspace::{
        ProjectLifecycle, ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };
    use nodex_core_contracts::{
        CoreErrorCode, LIBRARY_CONTRACT_VERSION, ModuleReadRequest,
        PROJECT_WORKSPACE_CONTRACT_VERSION,
    };

    use super::super::test_support::{
        TestWorkspace, apply, context, create_page_with_project_access, create_project, read,
        request, seeded_workspace,
    };
    use super::*;

    fn setup() -> TestWorkspace {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "runtime-session",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                session_id: "session:root".into(),
                replacement_default_session_id: "replacement:authority".into(),
                project_id: Some("project:default".into()),
                title: "Task".into(),
                initial_page_ids: Vec::new(),
                runtime_id: "engine:one".into(),
                runtime_thread_id: "thread:root".into(),
                launch_request_id: "launch:root".into(),
                launch_request_hash: "a".repeat(64),
            },
        );
        workspace
    }

    fn identity(thread: &str, run: &str) -> ProjectWorkspaceAgentRuntimeTurnIdentity {
        ProjectWorkspaceAgentRuntimeTurnIdentity {
            runtime_id: "engine:one".into(),
            thread_id: thread.into(),
            run_id: run.into(),
            lease_id: "lease:one".into(),
        }
    }

    fn admission(
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
        read_only: bool,
        parent: Option<ProjectWorkspaceAgentRuntimeTurnIdentity>,
    ) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
            session_id: "session:root".into(),
            identity,
            source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            read_only,
            parent,
        }
    }

    fn resolution(
        workspace: &TestWorkspace,
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
    ) -> ProjectWorkspaceTurnAuthorityResolution {
        let ProjectWorkspaceReadValue::AgentRuntimeTurnAuthority { resolution } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeTurnAuthority {
                identity,
                include_revoked: None,
            },
        ) else {
            panic!("runtime authority")
        };
        resolution
    }

    fn provenance(
        workspace: &TestWorkspace,
        identity: ProjectWorkspaceAgentRuntimeTurnIdentity,
    ) -> AgentTurnProvenance {
        AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: resolution(workspace, identity)
                .authority
                .expect("admitted authority"),
        }
    }

    fn resource_plan(
        workspace: &TestWorkspace,
        provenance: AgentTurnProvenance,
        page_id: &str,
        action: AgentProjectResourceAction,
    ) -> Result<AgentResourceAccessPlan, nodex_core_contracts::CoreError> {
        let library =
            crate::library::LibraryModule::new("profile-1", "library-1", &workspace.kernel);
        let agent_context = BoundModuleContext {
            adapter: AdapterKind::ElectronHost,
            project_id: provenance
                .authority
                .actor_project_id
                .clone()
                .map(nodex_core_contracts::ProjectId),
            ..context()
        };
        let result = library.read(
            &agent_context,
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PlanAgentResourceAccess {
                    provenance: Box::new(provenance),
                    call_id: "call:resource".into(),
                    intents: vec![AgentResourceIntent {
                        target: AgentAuthorizationTarget::Page {
                            page_id: page_id.into(),
                        },
                        action,
                    }],
                    task_access: None,
                },
            },
        )?;
        let LibraryReadValue::AgentResourceAccessPlan { value } = result.value else {
            panic!("resource plan")
        };
        Ok(*value)
    }

    #[test]
    fn authority_preflight_authenticates_current_lease_and_frozen_read_only_policy() {
        let workspace = setup();
        let root = identity("thread:root", "run:readonly");
        apply(
            &workspace.module,
            "admit",
            admission(root.clone(), true, None),
        );
        let credential = provenance(&workspace, root.clone());
        let preflight = |credential: AgentTurnProvenance| {
            workspace.module.read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentAuthority {
                        provenance: credential,
                    },
                },
            )
        };
        let ProjectWorkspaceReadValue::AgentAuthority { resolution } =
            preflight(credential.clone()).unwrap().value
        else {
            panic!("authenticated authority")
        };
        assert_eq!(resolution.authority, Some(credential.authority.clone()));
        assert!(resolution.persisted && resolution.read_only);
        let mut forged = credential.clone();
        forged.authority.scope = ProjectWorkspaceTurnAuthorityScope::Library;
        assert_eq!(
            preflight(forged).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let mut stale = credential.clone();
        stale.authority.store_epoch = "old-epoch".into();
        assert_eq!(
            preflight(stale).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        apply(
            &workspace.module,
            "revoke",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority { identity: root },
        );
        assert_eq!(
            preflight(credential).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
    }

    #[test]
    fn runtime_authority_reuses_project_grants_and_revocation_invalidates_the_exact_run() {
        let workspace = setup();
        create_project(&workspace.module, "other-project", "project:other");
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        create_page_with_project_access(&workspace, "page:private", "project:other");
        let root = identity("thread:root", "run:one");
        apply(
            &workspace.module,
            "admit",
            admission(root.clone(), false, None),
        );
        let provenance = provenance(&workspace, root.clone());
        assert!(provenance.authority.thread_id.starts_with("runtime:"));
        assert!(matches!(
            resource_plan(
                &workspace,
                provenance.clone(),
                "page:allowed",
                AgentProjectResourceAction::Write
            )
            .unwrap(),
            AgentResourceAccessPlan::Authorized { .. }
        ));
        assert!(matches!(
            resource_plan(
                &workspace,
                provenance.clone(),
                "page:private",
                AgentProjectResourceAction::Read
            )
            .unwrap(),
            AgentResourceAccessPlan::ConsentRequired { .. }
        ));
        let mut forged = provenance.clone();
        forged.authority.actor_project_id = Some("project:other".into());
        assert!(
            resource_plan(
                &workspace,
                forged,
                "page:private",
                AgentProjectResourceAction::Read
            )
            .is_err()
        );
        apply(
            &workspace.module,
            "revoke",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: root.clone(),
            },
        );
        assert!(resolution(&workspace, root.clone()).authority.is_none());
        let ProjectWorkspaceReadValue::AgentRuntimeTurnAuthority {
            resolution: retained,
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeTurnAuthority {
                identity: root.clone(),
                include_revoked: Some(true),
            },
        )
        else {
            panic!("retained inheritance evidence")
        };
        assert_eq!(retained.authority.as_ref(), Some(&provenance.authority));
        assert_eq!(
            resource_plan(
                &workspace,
                provenance,
                "page:allowed",
                AgentProjectResourceAction::Read
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request("reactivate", admission(root, false, None))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM codex_threads", [], |row| row
                        .get::<_, i64>(0))?,
                    0
                );
                assert!(
                    connection
                        .execute(
                            "UPDATE nodex_agent_runtime_turn_admissions SET active=1",
                            []
                        )
                        .is_err()
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn children_cannot_broaden_parent_scope_or_escape_the_read_only_ceiling() {
        let workspace = setup();
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        let root = identity("thread:root", "run:root");
        apply(
            &workspace.module,
            "root",
            admission(root.clone(), true, None),
        );
        let child = identity("thread:child", "run:child");
        apply(
            &workspace.module,
            "child",
            admission(child.clone(), false, Some(root.clone())),
        );
        assert!(resolution(&workspace, child.clone()).read_only);
        assert!(matches!(
            resource_plan(
                &workspace,
                provenance(&workspace, child),
                "page:allowed",
                AgentProjectResourceAction::Write
            )
            .unwrap(),
            AgentResourceAccessPlan::Denied {
                reason: AgentResourceAuthorizationReason::TurnReadOnly,
                ..
            }
        ));
        apply(
            &workspace.module,
            "full-access",
            ProjectWorkspaceIntent::SetProjectPermissionMode {
                project_id: "project:default".into(),
                mode: CodexPermissionMode::FullAccess,
            },
        );
        for source in [
            ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
            ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess,
        ] {
            let mut attempted = admission(
                identity("thread:broadened", "run:broadened"),
                false,
                Some(root.clone()),
            );
            let ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority { source: target, .. } =
                &mut attempted
            else {
                unreachable!()
            };
            *target = source;
            assert_eq!(
                workspace
                    .module
                    .apply(&context(), request("broadened", attempted))
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "missing-parent",
                        admission(identity("thread:unparented", "run:unparented"), false, None)
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
    }

    #[test]
    fn library_children_inherit_current_authority_and_read_only_without_a_native_thread() {
        let workspace = setup();
        apply(
            &workspace.module,
            "full-access",
            ProjectWorkspaceIntent::SetProjectPermissionMode {
                project_id: "project:default".into(),
                mode: CodexPermissionMode::FullAccess,
            },
        );
        let root = identity("thread:root", "run:library");
        let child = identity("thread:child", "run:library-child");
        for (op, identity, source, parent) in [
            (
                "root",
                root.clone(),
                ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
                None,
            ),
            (
                "child",
                child.clone(),
                ProjectWorkspaceTurnAuthoritySource::InheritedBuiltinFullAccess,
                Some(root),
            ),
        ] {
            apply(
                &workspace.module,
                op,
                ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
                    session_id: "session:root".into(),
                    identity,
                    source,
                    read_only: op == "root",
                    parent,
                },
            );
        }
        let resolution = resolution(&workspace, child);
        assert!(resolution.read_only);
        assert_eq!(
            resolution.authority.unwrap().scope,
            ProjectWorkspaceTurnAuthorityScope::Library
        );
    }

    #[test]
    fn stale_runtime_identity_project_archive_and_untrusted_adapters_cannot_admit_authority() {
        let workspace = setup();
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        let root = identity("thread:root", "run:one");
        let mut wrong_engine = root.clone();
        wrong_engine.runtime_id = "engine:replacement".into();
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request("wrong-engine", admission(wrong_engine.clone(), false, None))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert!(resolution(&workspace, wrong_engine).authority.is_none());
        let agent_context = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        assert_eq!(
            workspace
                .module
                .apply(
                    &agent_context,
                    request("agent-admit", admission(root.clone(), false, None))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            workspace
                .module
                .read(
                    &agent_context,
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::AgentRuntimeTurnAuthority {
                            identity: root.clone(),
                            include_revoked: None,
                        }
                    }
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        apply(
            &workspace.module,
            "admit",
            admission(root.clone(), false, None),
        );
        let provenance = provenance(&workspace, root.clone());
        apply(
            &workspace.module,
            "archive",
            ProjectWorkspaceIntent::SetProjectLifecycle {
                project_id: "project:default".into(),
                lifecycle: ProjectLifecycle::Archived,
            },
        );
        assert!(
            resource_plan(
                &workspace,
                provenance,
                "page:allowed",
                AgentProjectResourceAction::Read
            )
            .is_err()
        );
        assert!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "archived-admit",
                        admission(identity("thread:root", "run:after-archive"), false, None)
                    )
                )
                .is_err()
        );
    }

    #[test]
    fn restart_revokes_admissions_without_reusing_or_changing_the_engine_identity() {
        let workspace = setup();
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        let root = identity("thread:root", "run:before-restart");
        let child = identity("thread:child", "run:before-restart");
        apply(
            &workspace.module,
            "root",
            admission(root.clone(), false, None),
        );
        apply(
            &workspace.module,
            "child",
            admission(child.clone(), false, Some(root.clone())),
        );
        let previous_provenance = provenance(&workspace, root.clone());
        apply(
            &workspace.module,
            "restart",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: root.runtime_id.clone(),
                lease_id: None,
            },
        );
        assert!(resolution(&workspace, root.clone()).authority.is_none());
        assert!(resolution(&workspace, child).authority.is_none());
        let mut resumed = root.clone();
        resumed.lease_id = "lease:after-restart".into();
        apply(
            &workspace.module,
            "resumed",
            admission(resumed.clone(), false, None),
        );
        let resumed_provenance = provenance(&workspace, resumed.clone());
        let latest_parent = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeParentAdmission {
                runtime_id: root.runtime_id.clone(),
                thread_id: root.thread_id.clone(),
                run_id: root.run_id.clone(),
            },
        );
        assert!(
            matches!(latest_parent, ProjectWorkspaceReadValue::AgentRuntimeParentAdmission { identity: Some(ref identity) } if identity == &resumed)
        );
        assert_eq!(
            previous_provenance.authority.thread_id,
            resumed_provenance.authority.thread_id
        );
        assert_ne!(
            previous_provenance.authority.turn_id,
            resumed_provenance.authority.turn_id
        );
        assert!(
            resource_plan(
                &workspace,
                previous_provenance,
                "page:allowed",
                AgentProjectResourceAction::Read
            )
            .is_err()
        );
        assert!(matches!(
            resource_plan(
                &workspace,
                resumed_provenance,
                "page:allowed",
                AgentProjectResourceAction::Read
            )
            .unwrap(),
            AgentResourceAccessPlan::Authorized { .. }
        ));
        apply(
            &workspace.module,
            "late-previous-completion",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: root.clone(),
            },
        );
        assert!(resolution(&workspace, resumed.clone()).authority.is_some());
        apply(
            &workspace.module,
            "old-scope-finalizer",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: root.runtime_id,
                lease_id: Some(root.lease_id),
            },
        );
        assert!(resolution(&workspace, resumed).authority.is_some());
    }

    #[test]
    fn resumed_run_credentials_preserve_frozen_scope_and_read_only_ceilings() {
        let workspace = setup();
        let parent = identity("thread:root", "run:plan");
        apply(
            &workspace.module,
            "plan",
            admission(parent.clone(), true, None),
        );
        apply(
            &workspace.module,
            "restart",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: parent.runtime_id.clone(),
                lease_id: None,
            },
        );
        let mut resumed = parent.clone();
        resumed.lease_id = "lease:after-restart".into();
        apply(
            &workspace.module,
            "default-resume",
            admission(resumed.clone(), false, None),
        );
        assert!(resolution(&workspace, resumed.clone()).read_only);
        let child = identity("thread:child", "run:child");
        apply(
            &workspace.module,
            "child",
            admission(child.clone(), false, Some(resumed)),
        );
        assert!(resolution(&workspace, child).read_only);
        apply(
            &workspace.module,
            "new-policy",
            ProjectWorkspaceIntent::SetProjectPermissionMode {
                project_id: "project:default".into(),
                mode: CodexPermissionMode::FullAccess,
            },
        );
        let mut broader = parent;
        broader.lease_id = "lease:broader".into();
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "broader",
                        ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
                            session_id: "session:root".into(),
                            identity: broader,
                            source: ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
                            read_only: false,
                            parent: None,
                        }
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let fresh = identity("thread:root", "run:fresh");
        apply(
            &workspace.module,
            "fresh-policy",
            ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
                session_id: "session:root".into(),
                identity: fresh.clone(),
                source: ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
                read_only: false,
                parent: None,
            },
        );
        let new_policy = resolution(&workspace, fresh.clone());
        assert!(!new_policy.read_only);
        assert_eq!(
            new_policy.authority.unwrap().scope,
            ProjectWorkspaceTurnAuthorityScope::Library
        );
        let mut narrowed = fresh;
        narrowed.lease_id = "lease:narrower".into();
        apply(
            &workspace.module,
            "narrowed-policy",
            admission(narrowed.clone(), false, None),
        );
        assert_eq!(
            resolution(&workspace, narrowed).authority.unwrap().scope,
            ProjectWorkspaceTurnAuthorityScope::Project
        );
    }

    #[test]
    fn a_child_retains_parent_constraints_after_the_parent_credential_expires() {
        let workspace = setup();
        let parent = identity("thread:root", "run:parent");
        apply(
            &workspace.module,
            "parent",
            admission(parent.clone(), true, None),
        );
        apply(
            &workspace.module,
            "parent-completed",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: parent.clone(),
            },
        );
        let recovered = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeParentAdmission {
                runtime_id: parent.runtime_id.clone(),
                thread_id: parent.thread_id.clone(),
                run_id: parent.run_id.clone(),
            },
        );
        assert!(
            matches!(recovered, ProjectWorkspaceReadValue::AgentRuntimeParentAdmission { identity: Some(ref identity) } if identity == &parent)
        );
        let mut forged_context = context();
        forged_context.adapter = AdapterKind::Agent;
        assert!(
            workspace
                .module
                .read(
                    &forged_context,
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::AgentRuntimeParentAdmission {
                            runtime_id: parent.runtime_id.clone(),
                            thread_id: parent.thread_id.clone(),
                            run_id: parent.run_id.clone(),
                        },
                    }
                )
                .is_err()
        );
        let child = identity("thread:child", "run:child");
        apply(
            &workspace.module,
            "child",
            admission(child.clone(), false, Some(parent.clone())),
        );
        assert!(resolution(&workspace, parent).authority.is_none());
        let inherited = resolution(&workspace, child);
        assert!(inherited.authority.is_some());
        assert!(inherited.read_only);
    }

    #[test]
    fn deleting_and_recreating_a_session_cannot_reactivate_its_previous_run() {
        let workspace = setup();
        let previous = identity("thread:root", "run:previous");
        apply(
            &workspace.module,
            "previous",
            admission(previous.clone(), false, None),
        );
        apply(
            &workspace.module,
            "delete",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "session:root".into(),
            },
        );
        assert!(resolution(&workspace, previous.clone()).authority.is_none());
        apply(
            &workspace.module,
            "replacement",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                session_id: "session:root".into(),
                replacement_default_session_id: "replacement:authority".into(),
                project_id: Some("project:default".into()),
                title: "Replacement".into(),
                initial_page_ids: Vec::new(),
                runtime_id: "engine:one".into(),
                runtime_thread_id: "thread:root".into(),
                launch_request_id: "launch:replacement".into(),
                launch_request_hash: "b".repeat(64),
            },
        );
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request("revive-previous", admission(previous, false, None))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let replacement = identity("thread:root", "run:replacement");
        apply(
            &workspace.module,
            "replacement-run",
            admission(replacement.clone(), false, None),
        );
        assert!(resolution(&workspace, replacement).authority.is_some());
    }

    #[test]
    fn restored_store_retains_policy_for_resumed_runs_without_reviving_old_credentials() {
        let workspace = setup();
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        let previous = identity("thread:root", "run:previous");
        apply(
            &workspace.module,
            "admit-before-restore",
            admission(previous.clone(), true, None),
        );
        let stale = provenance(&workspace, previous.clone());
        apply(
            &workspace.module,
            "revoke-before-restore",
            ProjectWorkspaceIntent::RevokeAgentRuntimeAuthorities {
                runtime_id: previous.runtime_id.clone(),
                lease_id: None,
            },
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE block_store_metadata SET store_epoch='epoch:restored' WHERE id=1",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(resolution(&workspace, previous.clone()).authority.is_none());
        assert!(
            resource_plan(
                &workspace,
                stale,
                "page:allowed",
                AgentProjectResourceAction::Read
            )
            .is_err()
        );
        let mut resumed = previous.clone();
        resumed.lease_id = "lease:after-restore".into();
        let mut request = request(
            "resume-after-restore",
            admission(resumed.clone(), false, None),
        );
        request.store_epoch = nodex_core_contracts::StoreEpoch("epoch:restored".into());
        workspace.module.apply(&context(), request).unwrap();
        let policy = resolution(&workspace, resumed);
        assert!(policy.read_only);
        assert_eq!(policy.authority.unwrap().store_epoch, "epoch:restored");
        let child = identity("thread:child", "run:child-after-restore");
        let mut request = super::super::test_support::request(
            "child-after-restore",
            admission(child.clone(), false, Some(previous)),
        );
        request.store_epoch = nodex_core_contracts::StoreEpoch("epoch:restored".into());
        workspace.module.apply(&context(), request).unwrap();
        assert!(resolution(&workspace, child).read_only);
    }

    #[test]
    fn revoking_live_credentials_does_not_scan_the_runtime_history() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let mut measurements = Vec::new();
        for historical_runs in [1_000, 10_000] {
            let workspace = setup();
            let live = identity("thread:root", "run:live");
            apply(
                &workspace.module,
                "live",
                admission(live.clone(), false, None),
            );
            let authority = provenance(&workspace, live.clone()).authority;
            let steps = workspace.kernel.writer().call(move |connection| {
                // History scale is the subject; keep public admission and revocation coverage above.
                crate::infrastructure::sqlite::with_immediate_transaction(connection, |transaction| {
                    for index in 0..historical_runs {
                        let historical_identity = identity("thread:root", &format!("run:historical:{index}"));
                        let mut historical = authority.clone();
                        historical.turn_id = authority_turn_id(&historical_identity);
                        persist_turn_authority(transaction, "profile-1", &historical, false)?;
                        transaction.execute(
                            "INSERT INTO nodex_agent_runtime_turn_admissions(runtime_id,runtime_thread_id,runtime_run_id,runtime_lease_id,authority_thread_id,authority_turn_id,session_id,active) VALUES ('engine:one','thread:root',?1,'lease:one',?2,?3,'session:root',0)",
                            params![historical_identity.run_id, historical.thread_id, historical.turn_id],
                        )?;
                    }
                    Ok(())
                })?;
                let ticks = Arc::new(AtomicUsize::new(0));
                let observed = Arc::clone(&ticks);
                connection.progress_handler(1, Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }))?;
                let result = crate::infrastructure::sqlite::with_immediate_transaction(connection, |transaction| {
                    revoke(transaction, "library-1", &context(), "epoch-1", "measured-revoke", &"e".repeat(64), "engine:one", None, None)
                });
                connection.progress_handler(0, None::<fn() -> bool>)?;
                result?;
                assert_eq!(connection.query_row("SELECT count(*) FROM nodex_agent_runtime_turn_admissions WHERE active=1", [], |row| row.get::<_, i64>(0))?, 0);
                Ok(ticks.load(Ordering::Relaxed))
            }).expect("measured credential revocation");
            measurements.push(steps);
        }
        assert!(
            measurements[1] < measurements[0] * 2,
            "10x completed history must not increase live revocation work: {measurements:?}"
        );
    }
}
