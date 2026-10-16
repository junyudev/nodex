//! Agent Runtime executions name their engine coordinates and bound Session. The Host proves each
//! call live against the engine; Core validates the Session binding inside every use and keeps no
//! per-Run record, so cancellation, restart and native-connection close need no Core write.

use nodex_core_contracts::workspace::{
    ProjectWorkspaceAgentRuntimeAuthority, ProjectWorkspaceTurnAuthority,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::session_mutation::validate_id;

/// Returns the Session's current Project, which routes the call without restricting it.
pub(super) fn validate(
    connection: &Connection,
    library_id: &str,
    authority: &ProjectWorkspaceTurnAuthority,
    runtime: &ProjectWorkspaceAgentRuntimeAuthority,
) -> Result<Option<String>, StoreError> {
    validate_id("session_id", &runtime.session_id)?;
    validate_id("runtime_id", &runtime.runtime_id)?;
    let (project_id, archived) = connection
        .query_row(
            "SELECT session.project_id, session.archived \
             FROM project_session_execution_bindings binding \
             JOIN project_sessions session ON session.id = binding.session_id \
             WHERE binding.session_id = ?1 AND binding.runtime_id = ?2 \
               AND binding.runtime_thread_id = ?3 \
               AND (session.project_id IS NULL OR EXISTS(\
                 SELECT 1 FROM projects project \
                 WHERE project.id = session.project_id AND project.library_id = ?4 \
                   AND project.lifecycle = 'active'))",
            params![
                runtime.session_id,
                runtime.runtime_id,
                authority.root_thread_id,
                library_id
            ],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
        .ok_or_else(|| denied("Agent Runtime execution no longer matches its Session"))?;
    if archived {
        return Err(denied("Archived Sessions cannot execute"));
    }
    Ok(project_id)
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        TestWorkspace, apply, context, create_project, read, seeded_workspace,
    };
    use nodex_core_contracts::agent::AgentTurnProvenance;
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceAgentRuntimeAuthority,
        ProjectWorkspaceAgentRuntimeTurnKind, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceTurnAuthority,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, CoreErrorCode, ModuleReadRequest,
        PROJECT_WORKSPACE_CONTRACT_VERSION,
    };

    fn launch(session: &str, thread: &str, project: Option<&str>) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: session.into(),
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
    fn provenance(thread: &str, turn: &str) -> AgentTurnProvenance {
        AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: thread.into(),
                turn_id: turn.into(),
                root_thread_id: "thread:root".into(),
                actor_project_id: Some("project:default".into()),
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: "session:root".into(),
                    runtime_id: "engine:one".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }
    }
    fn preflight(
        workspace: &TestWorkspace,
        provenance: AgentTurnProvenance,
    ) -> Result<ProjectWorkspaceTurnAuthority, CoreErrorCode> {
        let snapshot = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentAuthority { provenance },
                },
            )
            .map_err(|error| error.code)?;
        let ProjectWorkspaceReadValue::AgentAuthority { resolution } = snapshot.value else {
            panic!("authority")
        };
        Ok(resolution.authority.expect("current authority"))
    }
    fn set_archived(workspace: &TestWorkspace, operation: &str, archived: bool) {
        apply(
            &workspace.module,
            operation,
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:root".into(),
                intent: ProjectSessionIntent::SetArchived { archived },
            },
        );
    }

    #[test]
    fn a_bound_execution_is_authorized_without_any_per_run_admission() {
        let w = setup();
        let child = provenance("thread:child", "run:child");
        assert_eq!(preflight(&w, child.clone()).unwrap(), child.authority);
        let mut native = provenance("thread:root", "incarnation:one");
        native.authority.runtime.as_mut().unwrap().turn_kind =
            ProjectWorkspaceAgentRuntimeTurnKind::NativeConnection;
        preflight(&w, native).unwrap();
    }

    #[test]
    fn forged_bindings_and_foreign_coordinates_are_rejected() {
        let w = setup();
        let mut foreign_root = provenance("thread:root", "run:one");
        foreign_root.authority.root_thread_id = "thread:other".into();
        let mut foreign_engine = provenance("thread:root", "run:one");
        foreign_engine
            .authority
            .runtime
            .as_mut()
            .unwrap()
            .runtime_id = "engine:two".into();
        let mut foreign_session = provenance("thread:root", "run:one");
        foreign_session
            .authority
            .runtime
            .as_mut()
            .unwrap()
            .session_id = "session:other".into();
        let mut foreign_profile = provenance("thread:root", "run:one");
        foreign_profile.profile_id = "profile:foreign".into();
        let mut stale_epoch = provenance("thread:root", "run:one");
        stale_epoch.authority.store_epoch = "epoch:old".into();
        for forged in [
            foreign_root,
            foreign_engine,
            foreign_session,
            foreign_profile,
            stale_epoch,
        ] {
            assert_eq!(preflight(&w, forged), Err(CoreErrorCode::Unauthorized));
        }
    }

    #[test]
    fn archive_gates_execution_and_deletion_ends_it() {
        let w = setup();
        let credential = provenance("thread:root", "run:one");
        set_archived(&w, "archive", true);
        assert_eq!(
            preflight(&w, credential.clone()),
            Err(CoreErrorCode::Unauthorized)
        );
        set_archived(&w, "unarchive", false);
        preflight(&w, credential.clone()).unwrap();
        apply(
            &w.module,
            "delete",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "session:root".into(),
            },
        );
        assert_eq!(preflight(&w, credential), Err(CoreErrorCode::Unauthorized));
    }

    #[test]
    fn session_movement_changes_routing_without_replacing_execution_identity() {
        let w = setup();
        create_project(&w.module, "other", "project:other");
        let credential = provenance("thread:root", "run:move");
        apply(
            &w.module,
            "move",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:root".into(),
                project_id: Some("project:other".into()),
            },
        );
        let current = preflight(&w, credential.clone()).unwrap();
        assert_eq!(current.actor_project_id.as_deref(), Some("project:other"));
        assert_eq!(current.thread_id, credential.authority.thread_id);
        assert_eq!(current.turn_id, credential.authority.turn_id);
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
        let credential = provenance("thread:root", "run:plan");
        let agent = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        w.module
            .apply(
                &agent,
                super::super::test_support::request(
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
        let ProjectWorkspaceReadValue::AgentSession { session, .. } = read(
            &w.module,
            ProjectWorkspaceRead::AgentSession {
                provenance: credential,
                session_id: "session:other".into(),
            },
        ) else {
            panic!("Session")
        };
        assert_eq!(session.display_title, "Changed from planning");
    }
}
