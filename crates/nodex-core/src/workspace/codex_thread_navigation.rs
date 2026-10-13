use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::AgentBackendBinding;
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectWorkspaceCodexThreadBinding,
    ProjectWorkspaceCodexThreadObservation, ProjectWorkspaceThread, ProjectWorkspaceThreadPatch,
};
use rusqlite::Connection;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

fn root(thread: &ProjectWorkspaceThread, expected_host: &str) -> Result<(), StoreError> {
    if thread.backend_binding != AgentBackendBinding::Codex
        || thread.execution_host_id != expected_host
    {
        return Err(conflict("Conversation execution binding changed"));
    }
    if thread.parent_thread_id.is_some() {
        return Err(conflict("Child conversations open in their parent context"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn observe_metadata(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    expected_host: &str,
    expected: &ProjectWorkspaceCodexThreadBinding,
    expected_parent: Option<&str>,
    observation: &ProjectWorkspaceCodexThreadObservation,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    super::thread::validate_id("thread_id", thread_id)?;
    let current = super::thread::read_thread(connection, library_id, thread_id)?
        .ok_or_else(|| conflict("Conversation metadata target disappeared"))?;
    let ProjectWorkspaceCodexThreadBinding::Existing {
        project_id,
        session_id,
    } = expected
    else {
        return Err(conflict(
            "Conversation metadata requires an existing binding",
        ));
    };
    if current.backend_binding != AgentBackendBinding::Codex
        || current.execution_host_id != expected_host
        || &current.project_id != project_id
        || &current.session_id != session_id
        || current.parent_thread_id.as_deref() != expected_parent
        || observation.project_id != current.project_id
    {
        return Err(conflict(
            "Conversation binding changed before metadata admission",
        ));
    }
    if let Some(parent_id) = expected_parent {
        let parent = super::thread::read_thread(connection, library_id, parent_id)?
            .ok_or_else(|| conflict("Conversation parent disappeared before metadata admission"))?;
        if parent.backend_binding != AgentBackendBinding::Codex
            || parent.execution_host_id != expected_host
        {
            return Err(conflict("Conversation parent execution binding changed"));
        }
    }
    super::thread::upsert_thread(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        thread_id,
        &ProjectWorkspaceThreadPatch {
            cwd: Some(observation.cwd.clone()),
            thread_name: Some(observation.thread_name.clone()),
            thread_source: Some(observation.thread_source.clone()),
            thread_preview: Some(observation.thread_preview.clone()),
            status: Some(observation.status.clone()),
            updated_at: Some(observation.updated_at),
            recency_at: Some(observation.recency_at),
            ..ProjectWorkspaceThreadPatch::default()
        },
    )
}

/// A replayed navigation receipt is usable only while its actual link still belongs to this host.
pub(super) fn validate_replayed_session(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    expected_host: &str,
    session_ids: &[String],
) -> Result<(), StoreError> {
    let thread = super::thread::read_thread(connection, library_id, thread_id)?
        .ok_or_else(|| conflict("Conversation is no longer available"))?;
    root(&thread, expected_host)?;
    let [session_id] = session_ids else {
        return Err(conflict("Conversation receipt has no unique Session"));
    };
    if thread.session_id.as_ref() != Some(session_id) {
        return Err(conflict("Conversation Session link changed"));
    }
    let session = super::session_mutation::require_session(connection, library_id, session_id)?;
    if session.thread_id.as_deref() != Some(thread_id) || session.project_id != thread.project_id {
        return Err(conflict("Conversation Session binding changed"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn ensure_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    expected_host: &str,
    expected: &ProjectWorkspaceCodexThreadBinding,
    session_id: &str,
    title: &str,
    observation: Option<&ProjectWorkspaceCodexThreadObservation>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    super::thread::validate_id("thread_id", thread_id)?;
    super::thread::validate_id("session_id", session_id)?;
    if expected_host.trim().is_empty() || expected_host.trim() != expected_host {
        return Err(conflict("Conversation host must be explicit"));
    }
    let current = super::thread::read_thread(connection, library_id, thread_id)?;
    match (expected, current.as_ref()) {
        (ProjectWorkspaceCodexThreadBinding::Absent, None) => {}
        (
            ProjectWorkspaceCodexThreadBinding::Existing {
                project_id,
                session_id,
            },
            Some(thread),
        ) if &thread.project_id == project_id && &thread.session_id == session_id => {}
        _ => return Err(conflict("Conversation binding changed before navigation")),
    }
    if let Some(thread) = &current {
        root(thread, expected_host)?;
        if let Some(linked_session_id) = &thread.session_id {
            validate_replayed_session(
                connection,
                library_id,
                thread_id,
                expected_host,
                std::slice::from_ref(linked_session_id),
            )?;
            return super::mutation::finish_no_op(
                connection,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "ensure_codex_thread_session",
                thread.project_id.iter().cloned().collect(),
                vec![linked_session_id.clone()],
                &super::session_mutation::sqlite_now(connection)?,
            );
        }
        if thread.archived {
            return Err(conflict(
                "Archived conversations cannot create a new Session",
            ));
        }
    }
    let observation =
        observation.ok_or_else(|| conflict("Conversation metadata is unavailable"))?;
    let project_id = current
        .as_ref()
        .map_or(observation.project_id.as_deref(), |thread| {
            thread.project_id.as_deref()
        });
    if let Some(project_id) = project_id {
        super::session_lifecycle::require_project(connection, library_id, project_id, true)?;
    }
    let title = super::session_lifecycle::normalize_session_title(title)?;
    if current.is_none() {
        super::thread::upsert_thread_records(
            connection,
            library_id,
            thread_id,
            &ProjectWorkspaceThreadPatch {
                project_id: Some(project_id.map(str::to_owned)),
                backend_binding: Some(AgentBackendBinding::Codex),
                execution_host_id: Some(expected_host.to_owned()),
                cwd: Some(observation.cwd.clone()),
                thread_name: Some(observation.thread_name.clone()),
                thread_source: Some(observation.thread_source.clone()),
                thread_preview: Some(observation.thread_preview.clone()),
                status: Some(observation.status.clone()),
                created_at: Some(observation.created_at),
                updated_at: Some(observation.updated_at),
                recency_at: Some(observation.recency_at),
                ..ProjectWorkspaceThreadPatch::default()
            },
        )?;
    }
    // Both helpers write records inside the caller's single Workspace transaction.
    // Link owns unread/default-draft/pin projection and is the only receipt/commit.
    super::session_lifecycle::insert_session_records(
        connection, session_id, project_id, &title, false,
    )?;
    super::session_mutation::mutate_session(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        session_id,
        &ProjectSessionIntent::LinkThread {
            thread_id: thread_id.to_owned(),
            expected_project_id: project_id.map(str::to_owned),
            thread_patch: None,
            execution_location: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{apply, context, read, request, seeded_workspace};
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::workspace::{
        CodexThreadStatusType, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceThreadStatus,
    };

    fn intent(expected: ProjectWorkspaceCodexThreadBinding) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::EnsureCodexThreadSession {
            thread_id: "root".into(),
            expected_execution_host_id: "ssh:owner".into(),
            expected_binding: expected,
            session_id: "new-session".into(),
            title: "Created chat".into(),
            observation: Some(Box::new(ProjectWorkspaceCodexThreadObservation {
                project_id: None,
                cwd: Some("/remote/work".into()),
                thread_name: Some("Remote title".into()),
                thread_source: Some("appServer".into()),
                thread_preview: "Native preview".into(),
                status: ProjectWorkspaceThreadStatus {
                    status_type: CodexThreadStatusType::Idle,
                    active_flags: vec![],
                },
                created_at: 1,
                updated_at: 2,
                recency_at: 2,
            })),
        }
    }
    fn thread(module: &crate::workspace::ProjectWorkspaceModule) -> ProjectWorkspaceThread {
        let ProjectWorkspaceReadValue::Thread { thread } = read(
            module,
            ProjectWorkspaceRead::Thread {
                thread_id: "root".into(),
            },
        ) else {
            panic!("Thread read");
        };
        *thread
    }
    fn seed(module: &crate::workspace::ProjectWorkspaceModule, patch: ProjectWorkspaceThreadPatch) {
        apply(
            module,
            "seed-root",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "root".into(),
                patch: Box::new(patch),
            },
        );
    }
    fn head(workspace: &crate::workspace::test_support::TestWorkspace) -> i64 {
        workspace
            .kernel
            .writer()
            .call(|connection| crate::infrastructure::local_commit::head(connection))
            .unwrap()
    }

    #[test]
    fn missing_root_creates_and_links_in_one_commit_then_reuses_without_metadata_mutation() {
        let workspace = seeded_workspace();
        let before = head(&workspace);
        let result = workspace
            .module
            .apply(
                &context(),
                request("open", intent(ProjectWorkspaceCodexThreadBinding::Absent)),
            )
            .unwrap();
        assert_eq!(result.committed.commit_seq, before + 1);
        assert_eq!(result.committed.value.affected_session_ids, ["new-session"]);
        let original = thread(&workspace.module);
        assert_eq!(original.execution_host_id, "ssh:owner");
        assert_eq!(original.session_id.as_deref(), Some("new-session"));
        let reuse = intent(ProjectWorkspaceCodexThreadBinding::Existing {
            project_id: None,
            session_id: Some("new-session".into()),
        });
        let result = workspace
            .module
            .apply(&context(), request("reuse", reuse))
            .unwrap();
        assert_eq!(result.committed.commit_seq, before + 1);
        assert!(result.event.is_none());
        assert_eq!(thread(&workspace.module), original);
    }

    #[test]
    fn foreign_host_backend_and_real_parent_reject_before_any_record_or_commit() {
        for patch in [
            ProjectWorkspaceThreadPatch {
                execution_host_id: Some("ssh:foreign".into()),
                ..Default::default()
            },
            ProjectWorkspaceThreadPatch {
                backend_binding: Some(AgentBackendBinding::OpenCode {
                    instance_config_id: "other".into(),
                }),
                execution_host_id: Some("ssh:owner".into()),
                ..Default::default()
            },
            ProjectWorkspaceThreadPatch {
                parent_thread_id: Some(Some("parent".into())),
                execution_host_id: Some("ssh:owner".into()),
                ..Default::default()
            },
        ] {
            let workspace = seeded_workspace();
            if patch.parent_thread_id.is_some() {
                apply(
                    &workspace.module,
                    "parent",
                    ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "parent".into(),
                        patch: Box::new(ProjectWorkspaceThreadPatch::default()),
                    },
                );
            }
            seed(&workspace.module, patch);
            let original = thread(&workspace.module);
            let before = head(&workspace);
            let error = workspace
                .module
                .apply(
                    &context(),
                    request(
                        "reject",
                        intent(ProjectWorkspaceCodexThreadBinding::Existing {
                            project_id: original.project_id.clone(),
                            session_id: original.session_id.clone(),
                        }),
                    ),
                )
                .unwrap_err();
            assert_eq!(error.code, CoreErrorCode::Conflict);
            assert_eq!(head(&workspace), before);
            assert_eq!(thread(&workspace.module), original);
            assert!(
                workspace
                    .module
                    .read(
                        &context(),
                        nodex_core_contracts::ModuleReadRequest {
                            contract_version:
                                nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                            read: ProjectWorkspaceRead::Session {
                                session_id: "new-session".into()
                            }
                        }
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn independent_writer_between_observation_and_admission_cannot_be_overwritten() {
        let workspace = seeded_workspace();
        // This is a second client of the same durable store, not a Main-only lane.
        let external = crate::workspace::ProjectWorkspaceModule::new(
            "profile-1",
            "library-1",
            &workspace.kernel,
        )
        .unwrap();
        seed(
            &external,
            ProjectWorkspaceThreadPatch {
                execution_host_id: Some("ssh:foreign".into()),
                thread_name: Some(Some("Foreign title".into())),
                ..Default::default()
            },
        );
        let before = head(&workspace);
        let original = thread(&workspace.module);
        let error = workspace
            .module
            .apply(
                &context(),
                request(
                    "stale-absent",
                    intent(ProjectWorkspaceCodexThreadBinding::Absent),
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Conflict);
        assert_eq!(head(&workspace), before);
        assert_eq!(thread(&workspace.module), original);
    }

    #[test]
    fn receipt_replay_rechecks_live_host_and_link() {
        let workspace = seeded_workspace();
        let command = intent(ProjectWorkspaceCodexThreadBinding::Absent);
        workspace
            .module
            .apply(&context(), request("open", command.clone()))
            .unwrap();
        let duplicate = workspace
            .module
            .apply(&context(), request("open", command.clone()))
            .unwrap();
        assert!(duplicate.committed.receipt.mutation.duplicate);
        apply(
            &workspace.module,
            "move-host",
            ProjectWorkspaceIntent::UpdateThread {
                thread_id: "root".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    execution_host_id: Some("ssh:foreign".into()),
                    ..Default::default()
                }),
            },
        );
        let before = head(&workspace);
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("open", command))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        assert_eq!(head(&workspace), before);
    }

    #[test]
    fn existing_root_created_as_subagent_keeps_its_actual_session_and_unread_state() {
        let workspace = seeded_workspace();
        workspace
            .module
            .apply(
                &context(),
                request("open", intent(ProjectWorkspaceCodexThreadBinding::Absent)),
            )
            .unwrap();
        apply(
            &workspace.module,
            "created-source",
            ProjectWorkspaceIntent::UpdateThread {
                thread_id: "root".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    thread_source: Some(Some("subagent".into())),
                    ..Default::default()
                }),
            },
        );
        apply(
            &workspace.module,
            "unread",
            ProjectWorkspaceIntent::SetThreadUnread {
                thread_id: "root".into(),
                unread: true,
            },
        );
        let original = thread(&workspace.module);
        let before = head(&workspace);
        let result = workspace
            .module
            .apply(
                &context(),
                request(
                    "reuse-created",
                    intent(ProjectWorkspaceCodexThreadBinding::Existing {
                        project_id: None,
                        session_id: Some("new-session".into()),
                    }),
                ),
            )
            .unwrap();
        assert_eq!(head(&workspace), before);
        assert_eq!(result.committed.value.affected_session_ids, ["new-session"]);
        assert_eq!(thread(&workspace.module), original);
        let ProjectWorkspaceReadValue::CodexThreadSession { session, thread } = read(
            &workspace.module,
            ProjectWorkspaceRead::CodexThreadSession {
                thread_id: "root".into(),
                expected_execution_host_id: "ssh:owner".into(),
            },
        ) else {
            panic!("Confirmed link")
        };
        assert_eq!(session.thread_id.as_deref(), Some("root"));
        assert_eq!(thread.session_id.as_deref(), Some(session.id.as_str()));
        assert!(session.unread);
    }

    #[test]
    fn same_host_unlink_invalidates_both_captured_binding_and_replayed_receipt() {
        let workspace = seeded_workspace();
        let command = intent(ProjectWorkspaceCodexThreadBinding::Absent);
        workspace
            .module
            .apply(&context(), request("open", command.clone()))
            .unwrap();
        let captured = intent(ProjectWorkspaceCodexThreadBinding::Existing {
            project_id: None,
            session_id: Some("new-session".into()),
        });
        apply(
            &workspace.module,
            "unlink",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "new-session".into(),
                intent: ProjectSessionIntent::UnlinkThread {
                    thread_id: "root".into(),
                },
            },
        );
        let before = head(&workspace);
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("captured-link", captured))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("open", command))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        assert_eq!(head(&workspace), before);
        assert!(thread(&workspace.module).session_id.is_none());
    }

    #[test]
    fn guarded_metadata_rejects_external_host_link_and_parent_races_without_wrong_commit() {
        for race in ["host", "link", "parent"] {
            let workspace = seeded_workspace();
            workspace
                .module
                .apply(
                    &context(),
                    request("open", intent(ProjectWorkspaceCodexThreadBinding::Absent)),
                )
                .unwrap();
            let captured = thread(&workspace.module);
            let ProjectWorkspaceIntent::EnsureCodexThreadSession {
                observation: Some(mut observation),
                ..
            } = intent(ProjectWorkspaceCodexThreadBinding::Absent)
            else {
                panic!("observation");
            };
            observation.thread_name = Some("Delayed metadata".into());
            let command = ProjectWorkspaceIntent::ObserveCodexThreadMetadata {
                thread_id: "root".into(),
                expected_execution_host_id: "ssh:owner".into(),
                expected_binding: ProjectWorkspaceCodexThreadBinding::Existing {
                    project_id: captured.project_id,
                    session_id: captured.session_id,
                },
                expected_parent_thread_id: None,
                observation,
            };
            let external = crate::workspace::ProjectWorkspaceModule::new(
                "profile-1",
                "library-1",
                &workspace.kernel,
            )
            .unwrap();
            match race {
                "host" => {
                    apply(
                        &external,
                        "move",
                        ProjectWorkspaceIntent::UpdateThread {
                            thread_id: "root".into(),
                            patch: Box::new(ProjectWorkspaceThreadPatch {
                                execution_host_id: Some("ssh:foreign".into()),
                                ..Default::default()
                            }),
                        },
                    );
                }
                "link" => {
                    apply(
                        &external,
                        "unlink",
                        ProjectWorkspaceIntent::MutateSession {
                            session_id: "new-session".into(),
                            intent: ProjectSessionIntent::UnlinkThread {
                                thread_id: "root".into(),
                            },
                        },
                    );
                }
                _ => {
                    apply(
                        &external,
                        "parent",
                        ProjectWorkspaceIntent::UpsertThread {
                            thread_id: "parent".into(),
                            patch: Box::new(ProjectWorkspaceThreadPatch::default()),
                        },
                    );
                    apply(
                        &external,
                        "reparent",
                        ProjectWorkspaceIntent::UpdateThread {
                            thread_id: "root".into(),
                            patch: Box::new(ProjectWorkspaceThreadPatch {
                                parent_thread_id: Some(Some("parent".into())),
                                ..Default::default()
                            }),
                        },
                    );
                }
            };
            let before = head(&workspace);
            let current = thread(&workspace.module);
            assert_eq!(
                workspace
                    .module
                    .apply(&context(), request("delayed-metadata", command))
                    .unwrap_err()
                    .code,
                CoreErrorCode::Conflict
            );
            assert_eq!(head(&workspace), before);
            assert_eq!(thread(&workspace.module), current);
        }
    }

    #[test]
    fn guarded_metadata_keeps_session_identity_parent_and_unread_while_updating_preview() {
        let workspace = seeded_workspace();
        workspace
            .module
            .apply(
                &context(),
                request("open", intent(ProjectWorkspaceCodexThreadBinding::Absent)),
            )
            .unwrap();
        apply(
            &workspace.module,
            "unread",
            ProjectWorkspaceIntent::SetThreadUnread {
                thread_id: "root".into(),
                unread: true,
            },
        );
        let ProjectWorkspaceIntent::EnsureCodexThreadSession {
            observation: Some(mut observation),
            ..
        } = intent(ProjectWorkspaceCodexThreadBinding::Absent)
        else {
            panic!("observation");
        };
        observation.thread_name = Some("Fresh metadata".into());
        let before = head(&workspace);
        let result = workspace
            .module
            .apply(
                &context(),
                request(
                    "metadata",
                    ProjectWorkspaceIntent::ObserveCodexThreadMetadata {
                        thread_id: "root".into(),
                        expected_execution_host_id: "ssh:owner".into(),
                        expected_binding: ProjectWorkspaceCodexThreadBinding::Existing {
                            project_id: None,
                            session_id: Some("new-session".into()),
                        },
                        expected_parent_thread_id: None,
                        observation,
                    },
                ),
            )
            .unwrap();
        assert_eq!(result.committed.commit_seq, before + 1);
        let current = thread(&workspace.module);
        assert_eq!(current.thread_name.as_deref(), Some("Fresh metadata"));
        assert_eq!(current.session_id.as_deref(), Some("new-session"));
        assert!(current.parent_thread_id.is_none());
        assert!(current.has_unread_turn);
    }

    #[test]
    fn guarded_child_metadata_rejects_a_parent_that_moved_to_another_host() {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "parent",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "parent".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    execution_host_id: Some("ssh:owner".into()),
                    ..Default::default()
                }),
            },
        );
        seed(
            &workspace.module,
            ProjectWorkspaceThreadPatch {
                execution_host_id: Some("ssh:owner".into()),
                parent_thread_id: Some(Some("parent".into())),
                ..Default::default()
            },
        );
        let original = thread(&workspace.module);
        let ProjectWorkspaceIntent::EnsureCodexThreadSession {
            observation: Some(observation),
            ..
        } = intent(ProjectWorkspaceCodexThreadBinding::Absent)
        else {
            panic!("observation");
        };
        apply(
            &workspace.module,
            "parent-handoff",
            ProjectWorkspaceIntent::UpdateThread {
                thread_id: "parent".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    execution_host_id: Some("ssh:foreign".into()),
                    ..Default::default()
                }),
            },
        );
        let before = head(&workspace);
        let result = workspace.module.apply(
            &context(),
            request(
                "child-metadata",
                ProjectWorkspaceIntent::ObserveCodexThreadMetadata {
                    thread_id: "root".into(),
                    expected_execution_host_id: "ssh:owner".into(),
                    expected_binding: ProjectWorkspaceCodexThreadBinding::Existing {
                        project_id: original.project_id.clone(),
                        session_id: original.session_id.clone(),
                    },
                    expected_parent_thread_id: Some("parent".into()),
                    observation,
                },
            ),
        );
        assert_eq!(result.unwrap_err().code, CoreErrorCode::Conflict);
        assert_eq!(head(&workspace), before);
        assert_eq!(thread(&workspace.module), original);
    }
}
