//! Application organization writes retain exact Turn provenance through commit.
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::workspace::{ProjectSessionIntent, ProjectWorkspaceIntent};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) fn admit<'a>(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    intent: &'a ProjectWorkspaceIntent,
) -> Result<&'a ProjectWorkspaceIntent, StoreError> {
    let ProjectWorkspaceIntent::AgentCommand { provenance, intent } = intent else {
        if matches!(context.adapter, AdapterKind::Agent) {
            return Err(denied("Agent Workspace commands require Turn provenance"));
        }
        return Ok(intent);
    };
    admit_read_caller(connection, library_id, context, provenance)?;
    if super::turn_is_read_only(
        connection,
        &provenance.authority.thread_id,
        &provenance.authority.turn_id,
    )? {
        return Err(denied("Read-only Turns cannot change application state"));
    }
    if let ProjectWorkspaceIntent::AdmitSessionLaunch { project_id, .. } = intent.as_ref() {
        if provenance.authority.scope
            != nodex_core_contracts::workspace::ProjectWorkspaceTurnAuthorityScope::Library
            && project_id.as_deref() != provenance.authority.actor_project_id.as_deref()
        {
            return Err(denied(
                "Session launch is outside the Turn's authorized Project",
            ));
        }
        return Ok(intent);
    }
    if let ProjectWorkspaceIntent::AdmitSessionMessage {
        session_id,
        thread_id,
        ..
    }
    | ProjectWorkspaceIntent::AdmitSessionHandoff {
        session_id,
        thread_id,
        ..
    } = intent.as_ref()
    {
        require_turn_session(connection, library_id, provenance, session_id, thread_id)?;
        if thread_id == &provenance.authority.thread_id {
            return Err(denied(
                "A Turn cannot dispatch a message or handoff to its own Session",
            ));
        }
        return Ok(intent);
    }
    if let ProjectWorkspaceIntent::AdmitSessionFork {
        source_session_id,
        source_thread_id,
        ..
    } = intent.as_ref()
    {
        require_turn_session(
            connection,
            library_id,
            provenance,
            source_session_id,
            source_thread_id,
        )?;
        return Ok(intent);
    }
    if !matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::CreateSidebarSection { .. }
            | ProjectWorkspaceIntent::RenameSidebarSection { .. }
            | ProjectWorkspaceIntent::DeleteSidebarSection { .. }
            | ProjectWorkspaceIntent::RestoreSidebarSection { .. }
            | ProjectWorkspaceIntent::MoveSidebarSectionItem { .. }
            | ProjectWorkspaceIntent::ReorderSidebarSectionSessions { .. }
            | ProjectWorkspaceIntent::ReorderSidebarSectionItems { .. }
            | ProjectWorkspaceIntent::ReorderBuiltinSidebarItems { .. }
            | ProjectWorkspaceIntent::PrioritizeBuiltinSidebarProjects { .. }
            | ProjectWorkspaceIntent::ReorderSidebarSections { .. }
            | ProjectWorkspaceIntent::ReorderProjects { .. }
            | ProjectWorkspaceIntent::ReorderPinnedProjects { .. }
            | ProjectWorkspaceIntent::SetProjectPinned { .. }
            | ProjectWorkspaceIntent::MutateSession {
                intent: ProjectSessionIntent::Rename { .. }
                    | ProjectSessionIntent::SetPinned { .. }
                    | ProjectSessionIntent::SetArchived { .. },
                ..
            }
    ) {
        return Err(denied("This Workspace command is not available to Agents"));
    }
    Ok(intent)
}

pub(super) fn admit_read_caller(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::Agent | AdapterKind::ElectronHost | AdapterKind::Test
    ) || provenance.profile_id != context.profile_id.0
        || context.project_id.as_ref().map(|id| id.0.as_str())
            != provenance.authority.actor_project_id.as_deref()
    {
        return Err(denied(
            "Agent Workspace request does not match its bound Project",
        ));
    }
    super::validate_persisted_turn_authority(connection, library_id, provenance)?;
    Ok(())
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn require_turn_session(
    connection: &Connection,
    library_id: &str,
    provenance: &AgentTurnProvenance,
    session_id: &str,
    thread_id: &str,
) -> Result<(), StoreError> {
    let target = super::session_mutation::require_session(connection, library_id, session_id)?;
    if provenance.authority.scope
        != nodex_core_contracts::workspace::ProjectWorkspaceTurnAuthorityScope::Library
        && target.project_id.as_deref() != provenance.authority.actor_project_id.as_deref()
    {
        return Err(denied(
            "Session command is outside the Turn's authorized Project",
        ));
    }
    if target.archived || target.thread_id.as_deref() != Some(thread_id) {
        return Err(denied(
            "Session command requires the current active Thread binding",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{apply, context, request, seeded_workspace};
    use super::*;
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::agent::AgentTurnProvenance;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceThreadPatch, ProjectWorkspaceTurnAuthority,
        ProjectWorkspaceTurnAuthorityScope, ProjectWorkspaceTurnAuthoritySource,
    };

    #[test]
    fn session_dispatch_reservations_revalidate_scope_binding_and_current_turn_before_replay() {
        use super::super::test_support::{create_project, create_session_thread};
        let workspace = seeded_workspace();
        let module = &workspace.module;
        create_project(module, "other", "project:other");
        for (id, project) in [
            ("caller", "project:default"),
            ("target", "project:default"),
            ("other", "project:other"),
        ] {
            create_session_thread(
                module,
                id,
                &format!("session:{id}"),
                &format!("thread:{id}"),
                Some(project),
                1,
            );
        }
        for (turn, read_only) in [("write", false), ("retry", false), ("read", true)] {
            apply(
                module,
                turn,
                ProjectWorkspaceIntent::FreezeTurnAuthority {
                    thread_id: "thread:caller".into(),
                    turn_id: turn.into(),
                    root_thread_id: "thread:caller".into(),
                    actor_project_id: Some("project:default".into()),
                    source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    read_only,
                    inherited_from: None,
                },
            );
        }
        let command = |turn: &str, target: &str, thread: &str, hash: &str| {
            ProjectWorkspaceIntent::AgentCommand {
                provenance: Box::new(AgentTurnProvenance {
                    profile_id: "profile-1".into(),
                    authority: ProjectWorkspaceTurnAuthority {
                        thread_id: "thread:caller".into(),
                        turn_id: turn.into(),
                        root_thread_id: "thread:caller".into(),
                        actor_project_id: Some("project:default".into()),
                        library_id: "library-1".into(),
                        store_epoch: "epoch-1".into(),
                        scope: ProjectWorkspaceTurnAuthorityScope::Project,
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    },
                }),
                intent: Box::new(ProjectWorkspaceIntent::AdmitSessionMessage {
                    session_id: target.into(),
                    thread_id: thread.into(),
                    message_request_hash: hash.into(),
                }),
            }
        };
        let handoff_command = |turn: &str, target: &str, thread: &str, hash: &str| {
            let ProjectWorkspaceIntent::AgentCommand { provenance, .. } =
                command(turn, target, thread, hash)
            else {
                unreachable!()
            };
            ProjectWorkspaceIntent::AgentCommand {
                provenance,
                intent: Box::new(ProjectWorkspaceIntent::AdmitSessionHandoff {
                    session_id: target.into(),
                    thread_id: thread.into(),
                    handoff_request_hash: hash.into(),
                }),
            }
        };
        let handoff = |turn: &str, hash: &str| {
            request(
                "handoff",
                handoff_command(turn, "session:target", "thread:target", hash),
            )
        };
        let agent = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        let hash = "a".repeat(64);
        for (turn, target, thread) in [
            ("read", "session:target", "thread:target"),
            ("write", "session:other", "thread:other"),
            ("write", "session:target", "thread:caller"),
            ("write", "session:caller", "thread:caller"),
        ] {
            assert_eq!(
                module
                    .apply(
                        &agent,
                        request(
                            "denied-handoff",
                            handoff_command(turn, target, thread, &hash)
                        )
                    )
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
            assert_eq!(
                module
                    .apply(
                        &agent,
                        request("denied-message", command(turn, target, thread, &hash))
                    )
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
        let message = |turn: &str, hash: &str| {
            request(
                "message",
                command(turn, "session:target", "thread:target", hash),
            )
        };
        assert!(
            !module
                .apply(&agent, message("write", &hash))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        let fork = |turn: &str, hash: &str| {
            let ProjectWorkspaceIntent::AgentCommand { provenance, .. } =
                command(turn, "session:target", "thread:target", hash)
            else {
                unreachable!()
            };
            request(
                "fork",
                ProjectWorkspaceIntent::AgentCommand {
                    provenance,
                    intent: Box::new(ProjectWorkspaceIntent::AdmitSessionFork {
                        source_session_id: "session:target".into(),
                        source_thread_id: "thread:target".into(),
                        session_id: "session:fork".into(),
                        fork_request_hash: hash.into(),
                    }),
                },
            )
        };
        let forked = module.apply(&agent, fork("write", &hash)).unwrap();
        assert_eq!(
            forked.committed.value.affected_session_ids,
            vec!["session:fork"]
        );
        assert!(!forked.committed.receipt.mutation.duplicate);
        assert!(
            !module
                .apply(&agent, handoff("write", &hash))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        drop(workspace.module);
        drop(workspace.kernel);
        let kernel =
            crate::infrastructure::store::SqliteStoreKernel::open_test(workspace._directory.path())
                .unwrap();
        let module =
            super::super::ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap();
        assert!(
            module
                .apply(&agent, message("retry", &hash))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert_eq!(
            module
                .apply(&agent, message("retry", &"b".repeat(64)))
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
        assert_eq!(
            module
                .apply(&agent, message("read", &hash))
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert!(
            module
                .apply(&agent, handoff("retry", &hash))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert_eq!(
            module
                .apply(&agent, handoff("retry", &"b".repeat(64)))
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
        assert_eq!(
            module
                .apply(&agent, handoff("read", &hash))
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let replayed_fork = module.apply(&agent, fork("retry", &hash)).unwrap();
        assert!(replayed_fork.committed.receipt.mutation.duplicate);
        assert_eq!(forked.committed.value, replayed_fork.committed.value);
        assert_eq!(
            module
                .apply(&agent, fork("retry", &"b".repeat(64)))
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
        assert_eq!(
            module.apply(&agent, fork("read", &hash)).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        apply(
            &module,
            "move-target",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:target".into(),
                project_id: Some("project:other".into()),
            },
        );
        assert_eq!(
            module
                .apply(&agent, message("retry", &hash))
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            module
                .apply(&agent, handoff("retry", &hash))
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            module.apply(&agent, fork("retry", &hash)).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
    }

    #[test]
    fn session_launch_reservation_checks_scope_and_replays_without_recreating_the_session() {
        use super::super::test_support::{create_project, create_session_thread};
        let workspace = seeded_workspace();
        let module = &workspace.module;
        create_project(module, "other", "project:other");
        create_session_thread(
            module,
            "caller",
            "session:caller",
            "thread:caller",
            Some("project:default"),
            1,
        );
        for (turn, read_only) in [("write", false), ("retry", false), ("read", true)] {
            apply(
                module,
                turn,
                ProjectWorkspaceIntent::FreezeTurnAuthority {
                    thread_id: "thread:caller".into(),
                    turn_id: turn.into(),
                    root_thread_id: "thread:caller".into(),
                    actor_project_id: Some("project:default".into()),
                    source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    read_only,
                    inherited_from: None,
                },
            );
        }
        let command =
            |turn: &str, project: Option<&str>, hash: &str| ProjectWorkspaceIntent::AgentCommand {
                provenance: Box::new(AgentTurnProvenance {
                    profile_id: "profile-1".into(),
                    authority: ProjectWorkspaceTurnAuthority {
                        thread_id: "thread:caller".into(),
                        turn_id: turn.into(),
                        root_thread_id: "thread:caller".into(),
                        actor_project_id: Some("project:default".into()),
                        library_id: "library-1".into(),
                        store_epoch: "epoch-1".into(),
                        scope: ProjectWorkspaceTurnAuthorityScope::Project,
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    },
                }),
                intent: Box::new(ProjectWorkspaceIntent::AdmitSessionLaunch {
                    session_id: "session:launched".into(),
                    project_id: project.map(str::to_owned),
                    title: "Research".into(),
                    launch_request_hash: hash.into(),
                }),
            };
        let agent = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        let hash = "a".repeat(64);
        for (turn, project) in [
            ("read", Some("project:default")),
            ("write", Some("project:other")),
            ("write", None),
        ] {
            assert_eq!(
                module
                    .apply(
                        &agent,
                        request("denied-launch", command(turn, project, &hash))
                    )
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
        assert_eq!(
            module
                .apply(
                    &agent,
                    request(
                        "invalid-launch",
                        command("write", Some("project:default"), "bad")
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidInput
        );
        let launch = request("launch", command("write", Some("project:default"), &hash));
        let fresh = module.apply(&agent, launch.clone()).unwrap();
        assert!(!fresh.committed.receipt.mutation.duplicate);
        drop(workspace.module);
        drop(workspace.kernel);
        let kernel =
            crate::infrastructure::store::SqliteStoreKernel::open_test(workspace._directory.path())
                .unwrap();
        let reopened =
            super::super::ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap();
        let module = &reopened;
        let replay = module.apply(&agent, launch.clone()).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(fresh.committed.value, replay.committed.value);
        let cross_turn = request("launch", command("retry", Some("project:default"), &hash));
        let replay = module.apply(&agent, cross_turn).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(fresh.committed.value, replay.committed.value);
        assert_eq!(
            module
                .apply(
                    &agent,
                    request("launch", command("read", Some("project:default"), &hash))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            module
                .apply(
                    &agent,
                    request(
                        "launch",
                        command("write", Some("project:default"), &"b".repeat(64))
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
        apply(
            module,
            "delete-launched",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "session:launched".into(),
            },
        );
        assert!(
            module
                .apply(&agent, launch.clone())
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert!(
            module
                .read(
                    &context(),
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: nodex_core_contracts::workspace::ProjectWorkspaceRead::Session {
                            session_id: "session:launched".into(),
                        },
                    },
                )
                .is_err()
        );
        apply(
            module,
            "move-launch-caller",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:caller".into(),
                project_id: Some("project:other".into()),
            },
        );
        assert_eq!(
            module.apply(&agent, launch).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
    }

    #[test]
    fn session_reads_validate_turn_and_project_scope_without_requiring_write_permission() {
        use super::super::test_support::{create_project, create_session_thread};
        use nodex_core_contracts::workspace::{
            CodexPermissionMode, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        };
        use nodex_core_contracts::{ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION};
        let workspace = seeded_workspace();
        let module = &workspace.module;
        create_project(module, "other-project", "project:other");
        create_session_thread(
            module,
            "own",
            "session:own",
            "thread:own",
            Some("project:default"),
            1,
        );
        create_session_thread(
            module,
            "other",
            "session:other",
            "thread:other",
            Some("project:other"),
            1,
        );
        apply(
            module,
            "draft",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:draft".into(),
                project_id: Some("project:default".into()),
                title: "Draft".into(),
                initial_page_ids: Vec::new(),
            },
        );
        apply(
            module,
            "freeze-read",
            ProjectWorkspaceIntent::FreezeTurnAuthority {
                thread_id: "thread:own".into(),
                turn_id: "turn:read".into(),
                root_thread_id: "thread:own".into(),
                actor_project_id: Some("project:default".into()),
                source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                read_only: true,
                inherited_from: None,
            },
        );
        let provenance = AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:own".into(),
                turn_id: "turn:read".into(),
                root_thread_id: "thread:own".into(),
                actor_project_id: Some("project:default".into()),
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                scope: ProjectWorkspaceTurnAuthorityScope::Project,
                source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            },
        };
        let read = |provenance: AgentTurnProvenance, session_id: &str| {
            module.read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentSession {
                        provenance,
                        session_id: session_id.into(),
                    },
                },
            )
        };
        assert!(matches!(
            read(provenance.clone(), "session:own").unwrap().value,
            ProjectWorkspaceReadValue::AgentSession {
                thread: Some(_),
                ..
            }
        ));
        assert!(matches!(
            read(provenance.clone(), "session:draft").unwrap().value,
            ProjectWorkspaceReadValue::AgentSession { thread: None, .. }
        ));
        assert_eq!(
            read(provenance.clone(), "session:other").unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let mut forged = provenance.clone();
        forged.authority.scope = ProjectWorkspaceTurnAuthorityScope::Library;
        assert_eq!(
            read(forged, "session:other").unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let mut stale = provenance.clone();
        stale.authority.store_epoch = "epoch:old".into();
        assert_eq!(
            read(stale, "session:own").unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        apply(
            module,
            "full-access",
            ProjectWorkspaceIntent::SetProjectPermissionMode {
                project_id: "project:default".into(),
                mode: CodexPermissionMode::FullAccess,
            },
        );
        apply(
            module,
            "freeze-library",
            ProjectWorkspaceIntent::FreezeTurnAuthority {
                thread_id: "thread:own".into(),
                turn_id: "turn:library".into(),
                root_thread_id: "thread:own".into(),
                actor_project_id: Some("project:default".into()),
                source: ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess,
                read_only: true,
                inherited_from: None,
            },
        );
        let mut library = provenance.clone();
        library.authority.turn_id = "turn:library".into();
        library.authority.scope = ProjectWorkspaceTurnAuthorityScope::Library;
        library.authority.source = ProjectWorkspaceTurnAuthoritySource::BuiltinFullAccess;
        assert!(matches!(
            read(library, "session:other").unwrap().value,
            ProjectWorkspaceReadValue::AgentSession {
                thread: Some(_),
                ..
            }
        ));
        apply(
            module,
            "move-caller",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:own".into(),
                project_id: Some("project:other".into()),
            },
        );
        assert!(read(provenance, "session:own").is_err());
    }

    #[test]
    fn organization_commands_require_writable_exact_turn_and_keep_receipt_identity() {
        let workspace = seeded_workspace();
        let module = &workspace.module;
        apply(
            module,
            "thread",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:agent".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(Some("project:default".into())),
                    ..Default::default()
                }),
            },
        );
        for (turn_id, read_only) in [("turn:read", true), ("turn:write", false)] {
            apply(
                module,
                turn_id,
                ProjectWorkspaceIntent::FreezeTurnAuthority {
                    thread_id: "thread:agent".into(),
                    turn_id: turn_id.into(),
                    root_thread_id: "thread:agent".into(),
                    actor_project_id: Some("project:default".into()),
                    source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    read_only,
                    inherited_from: None,
                },
            );
        }
        let provenance = |turn_id: &str| AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:agent".into(),
                turn_id: turn_id.into(),
                root_thread_id: "thread:agent".into(),
                actor_project_id: Some("project:default".into()),
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                scope: ProjectWorkspaceTurnAuthorityScope::Project,
                source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
            },
        };
        let section = || ProjectWorkspaceIntent::CreateSidebarSection {
            section_id: "section:agent".into(),
            name: "Research".into(),
            initial_item: None,
        };
        let agent = BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        };
        let command = |provenance, intent| ProjectWorkspaceIntent::AgentCommand {
            provenance: Box::new(provenance),
            intent: Box::new(intent),
        };
        let rejected = |intent| {
            assert!(matches!(
                module
                    .apply(&agent, request("rejected", intent))
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized | CoreErrorCode::NotFound
            ));
        };
        rejected(section());
        rejected(command(provenance("turn:read"), section()));
        for field in ["thread", "turn", "root", "project", "epoch", "profile"] {
            let mut forged = provenance("turn:write");
            match field {
                "thread" => forged.authority.thread_id = "other".into(),
                "turn" => forged.authority.turn_id = "other".into(),
                "root" => forged.authority.root_thread_id = "other".into(),
                "project" => forged.authority.actor_project_id = Some("other".into()),
                "epoch" => forged.authority.store_epoch = "other".into(),
                _ => forged.profile_id = "other".into(),
            }
            rejected(command(forged, section()));
        }
        rejected(command(
            provenance("turn:write"),
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "any-session".into(),
            },
        ));
        rejected(command(
            provenance("turn:write"),
            command(provenance("turn:write"), section()),
        ));
        let valid = request(
            "create-section",
            command(provenance("turn:write"), section()),
        );
        assert!(
            !module
                .apply(&agent, valid.clone())
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert!(
            module
                .apply(&agent, valid)
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        let changed = command(
            provenance("turn:write"),
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:other".into(),
                name: "Other".into(),
                initial_item: None,
            },
        );
        assert_eq!(
            module
                .apply(&agent, request("create-section", changed))
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
        let cli = BoundModuleContext {
            adapter: AdapterKind::NativeCli,
            ..context()
        };
        assert_eq!(
            module
                .apply(
                    &cli,
                    request("cli", command(provenance("turn:write"), section()))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
    }
}
