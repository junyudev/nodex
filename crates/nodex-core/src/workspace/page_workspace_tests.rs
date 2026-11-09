use super::test_support::*;
use nodex_core_contracts::workspace::*;
fn claim(page: &str, session: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::ClaimPageWorkspace {
        workspace_id: "workspace-1".into(),
        page_id: page.into(),
        project_id: "project:work".into(),
        session_id: session.into(),
        repository_url: Some("https://github.com/acme/repo".into()),
        repository_root: "/repository".into(),
        branch_name: "nodex-1-work".into(),
        base_commit_oid: "a".repeat(40),
        worktree_path: "/worktrees/abcd/repo".into(),
    }
}
#[test]
fn page_workspace_claim_reuse_retry_and_done_cleanup_keep_branch_and_pr() {
    workspace_lifecycle("done");
}
#[test]
fn page_workspace_canceled_cleanup_keeps_branch_and_pr() {
    workspace_lifecycle("canceled");
}
fn workspace_lifecycle(terminal_status: &str) {
    let w = seeded_workspace();
    create_project(&w.module, "project", "project:work");
    let page = "019d0000-0000-7000-8000-000000000091";
    apply(
        &w.module,
        "page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: page.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    for session in ["one", "two"] {
        apply(
            &w.module,
            &format!("session-{session}"),
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                agent_selection: None,
                coordinator: false,
                side_chat_source_session_id: None,
                project_id: Some("project:work".into()),
                session_id: session.into(),
                title: session.into(),
                initial_page_ids: vec![],
                runtime_id: "runtime".into(),
                runtime_thread_id: format!("thread:{session}"),
                launch_request_id: format!("launch:{session}"),
            },
        );
    }
    apply(&w.module, "claim", claim(page, "one"));
    apply(&w.module, "claim", claim(page, "one"));
    apply(
        &w.module,
        "ready",
        ProjectWorkspaceIntent::RecordPageWorkspaceReady {
            workspace_id: "workspace-1".into(),
            allocation_operation_id: "claim".into(),
            branch_name: "nodex-1-work-2".into(),
            worktree_path: "/worktrees/abcd/repo".into(),
        },
    );
    apply(&w.module, "reuse", claim(page, "two"));
    assert_eq!(
        read(
            &w.module,
            ProjectWorkspaceRead::SessionWorkPage {
                session_id: "two".into()
            }
        ),
        ProjectWorkspaceReadValue::SessionWorkPage {
            page_id: Some(page.into())
        }
    );
    let ProjectWorkspaceReadValue::PageWorkspace {
        workspace: Some(value),
        ..
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspace {
            page_id: page.into(),
        },
    )
    else {
        panic!("Workspace")
    };
    assert_eq!(value.branch_name, "nodex-1-work-2");
    assert_eq!(value.revision, 2);
    let ProjectWorkspaceReadValue::PageWorkspaceConsumers { session_ids } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspaceConsumers {
            workspace_id: value.workspace_id.clone(),
            after_session_id: None,
            limit: 100,
        },
    ) else {
        panic!("consumers")
    };
    assert_eq!(session_ids, vec!["one", "two"]);
    apply(
        &w.module,
        "pr",
        ProjectWorkspaceIntent::UpsertPagePullRequest {
            workspace_id: value.workspace_id.clone(),
            head_branch: value.branch_name.clone(),
            repository: value.repository_url.clone().unwrap(),
            number: 42,
            url: "https://github.com/acme/repo/pull/42".into(),
            state: "OPEN".into(),
            observed_at: NOW.into(),
        },
    );
    apply(
        &w.module,
        "cleanup",
        ProjectWorkspaceIntent::RequestPageWorkspaceCleanup {
            workspace_id: value.workspace_id.clone(),
        },
    );
    apply(
        &w.module,
        "removed",
        ProjectWorkspaceIntent::MarkPageWorkspaceRemoved {
            workspace_id: value.workspace_id.clone(),
            expected_revision: 3,
        },
    );
    let ProjectWorkspaceReadValue::PageWorkspace {
        workspace: Some(removed),
        pull_request: Some(pr),
        ..
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspace {
            page_id: page.into(),
        },
    )
    else {
        panic!("retained")
    };
    assert_eq!(removed.lifecycle, PageWorkspaceLifecycle::Removed);
    assert_eq!(removed.branch_name, value.branch_name);
    assert_eq!(pr.number, 42);
    apply(&w.module, "reopen", claim(page, "one"));
    let ProjectWorkspaceReadValue::SessionWorkspace {
        workspace: Some(reopened),
    } = read(
        &w.module,
        ProjectWorkspaceRead::SessionWorkspace {
            session_id: "one".into(),
        },
    )
    else {
        panic!("reopened")
    };
    assert_eq!(reopened.lifecycle, PageWorkspaceLifecycle::Preparing);
    assert_eq!(reopened.allocation_operation_id, "claim");
    let moved = w.module.apply(
        &context(),
        request(
            "move-workspace-chat",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "one".into(),
                project_id: None,
                placement: None,
            },
        ),
    );
    assert!(
        moved.is_err(),
        "a bound chat cannot change Workspace Project"
    );
    apply(
        &w.module,
        "failed",
        ProjectWorkspaceIntent::RecordPageWorkspaceFailed {
            workspace_id: reopened.workspace_id.clone(),
            allocation_operation_id: reopened.allocation_operation_id.clone(),
            failure: "interrupted preparation".into(),
        },
    );
    apply(
        &w.module,
        "failed",
        ProjectWorkspaceIntent::RecordPageWorkspaceFailed {
            workspace_id: reopened.workspace_id.clone(),
            allocation_operation_id: reopened.allocation_operation_id.clone(),
            failure: "interrupted preparation".into(),
        },
    );
    apply(&w.module, "retry", claim(page, "one"));
    let (source,revision)=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT v.data_source_id,v.revision FROM data_source_property_values v JOIN data_source_page_memberships m ON m.id=v.membership_id WHERE m.page_block_id=?1 AND v.property_id='status'",[page],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
    use nodex_core_contracts::database::*;
    crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            nodex_core_contracts::ModuleApplyRequest {
                contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                operation_id: "finish-page".into(),
                store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::EditPropertyValues {
                    edits: vec![DatabasePropertyValueMutation {
                        expected_membership_revision: None,
                        address: DatabasePagePropertyAddress {
                            page_id: page.into(),
                            data_source_id: source,
                            property_id: "status".into(),
                        },
                        edit: DatabasePropertyValueEdit::Replace {
                            expected_value_revision: revision,
                            value: DatabasePropertyValueInput::Select {
                                option_id: terminal_status.into(),
                            },
                        },
                    }],
                }],
            },
        )
        .unwrap();
    let ProjectWorkspaceReadValue::PageWorkspace {
        workspace: Some(finished),
        ..
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspace {
            page_id: page.into(),
        },
    )
    else {
        panic!("finished Workspace")
    };
    assert_eq!(finished.lifecycle, PageWorkspaceLifecycle::CleanupRequested);
    // A terminal stage racing preparation retains the actual allocated branch for cleanup.
    apply(
        &w.module,
        "finish-preparation",
        ProjectWorkspaceIntent::RecordPageWorkspaceReady {
            workspace_id: finished.workspace_id,
            allocation_operation_id: finished.allocation_operation_id,
            branch_name: "nodex-1-work-2".into(),
            worktree_path: "/worktrees/abcd/repo".into(),
        },
    );
    let ProjectWorkspaceReadValue::PageWorkspace {
        workspace: Some(finished),
        ..
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspace {
            page_id: page.into(),
        },
    )
    else {
        panic!("finished Workspace")
    };
    assert_eq!(finished.lifecycle, PageWorkspaceLifecycle::CleanupRequested);
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "stale-cleanup",
                    ProjectWorkspaceIntent::MarkPageWorkspaceRemoved {
                        workspace_id: finished.workspace_id,
                        expected_revision: finished.revision - 1
                    }
                )
            )
            .is_err()
    );
    apply(
        &w.module,
        "delete-two",
        ProjectWorkspaceIntent::DeleteSession {
            session_id: "two".into(),
        },
    );
    let ProjectWorkspaceReadValue::PageWorkspaceConsumers { session_ids } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspaceConsumers {
            workspace_id: "workspace-1".into(),
            after_session_id: None,
            limit: 100,
        },
    ) else {
        panic!("retiring consumers")
    };
    assert_eq!(
        session_ids,
        vec!["one", "two"],
        "Session deletion cannot erase an unretired execution consumer"
    );
    apply(
        &w.module,
        "retire-two",
        ProjectWorkspaceIntent::AcknowledgeAgentRuntimeExecutionCleanup {
            cleanup_id: "delete-two".into(),
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:two".into(),
        },
    );
    let ProjectWorkspaceReadValue::PageWorkspaceConsumers { session_ids } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspaceConsumers {
            workspace_id: "workspace-1".into(),
            after_session_id: None,
            limit: 100,
        },
    ) else {
        panic!("retired consumers")
    };
    assert_eq!(session_ids, vec!["one"]);
}
