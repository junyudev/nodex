use super::test_support::*;
use nodex_core_contracts::{CoreErrorCode, library::AgentWorkSelection, workspace::*};
const PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn setup() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project:create", "project:work");
    apply(
        &w.module,
        "page:create",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Turn".into(),
        },
    );
    apply(
        &w.module,
        "start",
        ProjectWorkspaceIntent::StartPageWork {
            page_id: PAGE.into(),
            selection: Some(AgentWorkSelection {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: None,
            }),
            session_id: "chat".into(),
            launch_id: "launch".into(),
            message_id: "message".into(),
            brief: "Work".into(),
            again: false,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    );
    w
}
fn turn(w: &TestWorkspace) -> PageTurn {
    let ProjectWorkspaceReadValue::PageTurn { turn, .. } = read(
        &w.module,
        ProjectWorkspaceRead::PageTurn {
            page_id: PAGE.into(),
        },
    ) else {
        panic!()
    };
    turn
}
fn observation(state: SessionExecutionState) -> SessionExecutionObservation {
    serde_json::from_value(serde_json::json!({"state":state,"runId":"run","runStartedAt":0,"pendingRequestIds":[],"pendingRequests":[],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"p1","progressSince":0})).unwrap()
}
fn capture(w: &TestWorkspace, revision: i64, observation: SessionExecutionObservation) {
    apply(
        &w.module,
        &format!("capture:{revision}"),
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id: "chat".into(),
            expected_revision: revision,
            observation,
            events: vec![],
            resolved_request_ids: vec![],
        },
    );
}
#[test]
fn episodes_survive_repeated_observation_and_change_on_actor_reason_and_return() {
    let w = setup();
    let before = turn(&w);
    capture(&w, 0, observation(SessionExecutionState::Working));
    let working = turn(&w);
    assert_eq!(working.reason, Some(TurnReason::Working));
    assert_ne!(working.episode, before.episode);
    capture(&w, 1, observation(SessionExecutionState::Working));
    assert_eq!(turn(&w), working);
    let mut queued = observation(SessionExecutionState::Queued);
    queued.queue = Some(SessionExecutionQueue {
        run_id: "run".into(),
        class: SessionExecutionQueueClass::Person,
        position: 2,
        waiting_since: "now".into(),
    });
    capture(&w, 2, queued.clone());
    let second = turn(&w);
    assert_eq!(
        second.actor,
        TurnActor::Agent {
            assignee: nodex_core_contracts::library::PageAssignee::Agent {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: None
            }
        }
    );
    assert_ne!(second.episode, working.episode);
    queued.queue.as_mut().unwrap().position = 1;
    capture(&w, 3, queued);
    assert_eq!(turn(&w).episode, second.episode);
    capture(&w, 4, observation(SessionExecutionState::Working));
    assert_ne!(turn(&w).episode, working.episode);
    let old = turn(&w);
    let mut progress = observation(SessionExecutionState::Working);
    progress.progress_fingerprint = Some("p2".into());
    capture(&w, 5, progress);
    assert_eq!(turn(&w), old);
}
#[test]
fn observations_are_revisioned_host_facts_and_unavailable_is_not_failure_or_a_person_stop() {
    let w = setup();
    capture(&w, 0, observation(SessionExecutionState::Unavailable));
    assert_eq!(turn(&w).reason, None);
    capture(&w, 1, observation(SessionExecutionState::Failed));
    assert_eq!(turn(&w).reason, Some(TurnReason::Failed));
    let mut stopped = observation(SessionExecutionState::Failed);
    stopped.person_stopped = true;
    capture(&w, 2, stopped);
    assert_eq!(turn(&w).reason, None);
    let result = w.module.apply(
        &context(),
        request(
            "stale",
            ProjectWorkspaceIntent::RecordSessionExecution {
                session_id: "chat".into(),
                expected_revision: 0,
                observation: observation(SessionExecutionState::Working),
                events: vec![],
                resolved_request_ids: vec![],
            },
        ),
    );
    assert_eq!(result.unwrap_err().code, CoreErrorCode::RevisionConflict);
    let mut caller = context();
    caller.adapter = nodex_core_contracts::AdapterKind::NativeCli;
    let rejected = w.module.apply(
        &caller,
        request(
            "forge-observation",
            ProjectWorkspaceIntent::RecordSessionExecution {
                session_id: "chat".into(),
                expected_revision: 3,
                observation: observation(SessionExecutionState::Working),
                events: vec![],
                resolved_request_ids: vec![],
            },
        ),
    );
    assert_eq!(rejected.unwrap_err().code, CoreErrorCode::Unauthorized);
    let ProjectWorkspaceReadValue::SessionExecutionObserver {
        observer: Some(observer),
    } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObserver {
            session_id: "chat".into(),
        },
    )
    else {
        panic!()
    };
    assert_eq!(observer.revision, 3);
    assert!(observer.observation.unwrap().person_stopped);
    let result = w.module.read(
        &context(),
        nodex_core_contracts::ModuleReadRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            read: ProjectWorkspaceRead::PageTurns {
                page_ids: vec![PAGE.into(); 201],
            },
        },
    );
    assert!(result.is_err());
}
#[test]
fn unavailable_execution_preserves_the_managed_notification_baseline() {
    let w = setup();
    let baseline = || {
        let ProjectWorkspaceReadValue::SessionExecutionObserver {
            observer: Some(observer),
        } = read(
            &w.module,
            ProjectWorkspaceRead::SessionExecutionObserver {
                session_id: "chat".into(),
            },
        )
        else {
            panic!()
        };
        observer.managed.unwrap()
    };
    capture(&w, 0, observation(SessionExecutionState::Unavailable));
    assert!(baseline().observed_json.is_none());
    capture(&w, 1, observation(SessionExecutionState::Working));
    let working = baseline();
    assert!(working.observed_json.is_some());
    capture(&w, 2, observation(SessionExecutionState::Unavailable));
    assert_eq!(baseline(), working);
}
#[test]
fn unmanaged_active_chats_are_observed_without_becoming_managed() {
    let w = setup();
    apply(
        &w.module,
        "unmanage",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "chat".into(),
            managed: false,
        },
    );
    let ProjectWorkspaceReadValue::SessionExecutionObservers { observers } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObservers {
            after_session_id: None,
            limit: 50,
        },
    ) else {
        panic!()
    };
    assert_eq!(observers.len(), 1);
    assert!(observers[0].managed.is_none());
    capture(&w, 0, observation(SessionExecutionState::Working));
    assert_eq!(turn(&w).reason, Some(TurnReason::Working));
}

#[test]
fn working_and_queued_chats_name_the_executing_agent_without_reassigning_the_page() {
    use nodex_core_contracts::{
        LIBRARY_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch, library::*,
    };
    for member_assigned in [false, true] {
        let w = setup();
        let (encoded, revision) = w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT value_json,revision FROM block_properties WHERE block_id=?1 AND property_key='work'",[PAGE],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
        let mut work: PageWork = serde_json::from_str(&encoded).unwrap();
        work.assignee = member_assigned.then(|| PageAssignee::Member {
            member_id: work.owner.clone(),
        });
        crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel)
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "set-assignee".into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: LibraryIntent::ApplyBlockPropertyMutation {
                        mutation: Box::new(LibraryBlockPropertyMutation {
                            actor: serde_json::json!({"kind":"host"}),
                            client_session_id: None,
                            fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                                block_id: PAGE.into(),
                                property_key: "work".into(),
                                expected_revision: revision,
                                value: serde_json::to_value(&work).unwrap(),
                            }],
                        }),
                    },
                },
            )
            .unwrap();
        let agent = AgentWorkSelection {
            instance_id: "codex".into(),
            model: "active-model".into(),
            effort: Some("high".into()),
        };
        let expected = TurnActor::Agent {
            assignee: PageAssignee::Agent {
                instance_id: agent.instance_id.clone(),
                model: agent.model.clone(),
                effort: agent.effort.clone(),
            },
        };
        let mut working = observation(SessionExecutionState::Working);
        working.agent = Some(agent.clone());
        capture(&w, 0, working);
        assert_eq!(turn(&w).actor, expected);
        assert_eq!(turn(&w).reason, Some(TurnReason::Working));
        let mut queued = observation(SessionExecutionState::Queued);
        queued.queue = Some(SessionExecutionQueue {
            run_id: "run".into(),
            class: SessionExecutionQueueClass::Start,
            position: 2,
            waiting_since: "now".into(),
        });
        capture(&w, 1, queued);
        assert_eq!(turn(&w).actor, expected);
        assert_eq!(turn(&w).reason, Some(TurnReason::Queued));
        let after = w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",[PAGE],|r|r.get::<_,String>(0))?)).unwrap();
        assert_eq!(serde_json::from_str::<PageWork>(&after).unwrap(), work);
    }
}
#[test]
fn reverse_prerequisites_refresh_episode_and_local_commit_invalidation() {
    use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch, database::*};
    let w = setup();
    let prerequisite = "019d0000-0000-7000-8000-000000000093";
    apply(
        &w.module,
        "prerequisite:create",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: prerequisite.into(),
            document_id: "019d0000-0000-7000-8000-000000000094".into(),
            title: "Prerequisite".into(),
        },
    );
    let source = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT parent_id FROM pages WHERE block_id=?1",
                [PAGE],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let db = crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel);
    db.apply(
        &context(),
        ModuleApplyRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            operation_id: "block".into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: vec![DatabaseIntent::EditPropertyValues {
                edits: vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id: PAGE.into(),
                        data_source_id: source.clone(),
                        property_id: "blocked_by".into(),
                    },
                    edit: DatabasePropertyValueEdit::PatchSet {
                        delta: DatabasePropertySetDelta::Relation {
                            add_page_ids: vec![prerequisite.into()],
                            remove_edge_ids: vec![],
                        },
                    },
                }],
            }],
        },
    )
    .unwrap();
    let blocked = turn(&w);
    assert_eq!(blocked.reason, Some(TurnReason::WaitingOnPrerequisite));
    let (database,namespace_revision)=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT source.home_database_block_id,namespace.revision FROM data_sources source JOIN page_key_namespaces namespace ON namespace.database_block_id=source.home_database_block_id WHERE source.id=?1",[&source],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
    db.apply(
        &context(),
        ModuleApplyRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            operation_id: "rename-prerequisite-key".into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: vec![DatabaseIntent::RenamePageKeyPrefix {
                database_id: database,
                expected_revision: namespace_revision,
                prefix: "TURN".into(),
            }],
        },
    )
    .unwrap();
    let renamed = turn(&w);
    assert_eq!(renamed.episode, blocked.episode);
    assert!(matches!(renamed.actor,TurnActor::Page {key:Some(key),..} if key.starts_with("TURN-")));
    let revision=w.kernel.readers().read_default(move|c|Ok(c.query_row("SELECT value.revision FROM data_source_property_values value JOIN data_source_page_memberships membership ON membership.id=value.membership_id WHERE membership.page_block_id=?1 AND value.property_id='status'",[prerequisite],|r|r.get::<_,i64>(0))?)).unwrap();
    let result = db
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "finish-prerequisite".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::EditPropertyValues {
                    edits: vec![DatabasePropertyValueMutation {
                        expected_membership_revision: None,
                        address: DatabasePagePropertyAddress {
                            page_id: prerequisite.into(),
                            data_source_id: source,
                            property_id: "status".into(),
                        },
                        edit: DatabasePropertyValueEdit::Replace {
                            expected_value_revision: revision,
                            value: DatabasePropertyValueInput::Select {
                                option_id: "done".into(),
                            },
                        },
                    }],
                }],
            },
        )
        .unwrap();
    let after = turn(&w);
    assert_eq!(after.reason, None);
    assert_ne!(after.episode, blocked.episode);
    assert!(
        result
            .committed
            .receipt
            .affected_page_ids
            .iter()
            .any(|id| id == prerequisite)
    );
    w.kernel.readers().read_default(|c|{let count:i64=c.query_row("SELECT count(*) FROM local_commit_effects effect,json_each(effect.projection_impact_json,'$.page_ids') page WHERE page.value=?1 AND effect.commit_seq=(SELECT max(commit_seq) FROM local_commits)",[PAGE],|r|r.get(0))?;assert!(count>0);Ok(())}).unwrap();
}

#[test]
fn holds_choose_the_most_specific_scope_and_refresh_every_covered_turn() {
    const SIBLING: &str = "019d0000-0000-7000-8000-000000000095";
    const OUTSIDE: &str = "019d0000-0000-7000-8000-000000000096";
    let w = setup();
    capture(&w, 0, observation(SessionExecutionState::Working));
    let working = turn(&w);
    create_project(&w.module, "other-project:create", "project:other");
    for (id, project) in [(SIBLING, "project:work"), (OUTSIDE, "project:other")] {
        apply(
            &w.module,
            &format!("page:{project}:create"),
            ProjectWorkspaceIntent::CreatePageFor {
                target: ProjectWorkspacePageCreationTarget::Project {
                    project_id: project.into(),
                },
                page_id: id.into(),
                document_id: if id == SIBLING {
                    "019d0000-0000-7000-8000-000000000097"
                } else {
                    "019d0000-0000-7000-8000-000000000098"
                }
                .into(),
                title: id.into(),
            },
        );
    }
    let read_page = |id: &str| {
        let ProjectWorkspaceReadValue::PageTurn { turn, .. } = read(
            &w.module,
            ProjectWorkspaceRead::PageTurn { page_id: id.into() },
        ) else {
            panic!()
        };
        turn
    };
    let project = ExecutionHoldScope::Project {
        project_id: "project:work".into(),
    };
    let page = ExecutionHoldScope::Page {
        page_id: PAGE.into(),
    };
    apply(
        &w.module,
        "pause-project",
        ProjectWorkspaceIntent::PauseWork {
            scope: project.clone(),
        },
    );
    let inherited = turn(&w);
    assert_eq!(inherited.reason, Some(TurnReason::Paused));
    let hold = inherited.hold.as_ref().unwrap();
    assert_eq!(hold.scope, project);
    assert_eq!(
        inherited.actor,
        TurnActor::Member {
            member_id: hold.actor.clone()
        }
    );
    assert_eq!(read_page(SIBLING).reason, Some(TurnReason::Paused));
    assert_eq!(read_page(OUTSIDE).reason, None);
    w.kernel.readers().read_default(|c| {
        for id in [PAGE,SIBLING] {
            let count:i64=c.query_row("SELECT count(*) FROM local_commit_effects effect,json_each(effect.projection_impact_json,'$.page_ids') page WHERE page.value=?1 AND effect.commit_seq=(SELECT max(commit_seq) FROM local_commits)",[id],|r|r.get(0))?;
            assert!(count>0,"missing scoped Turn invalidation for {id}");
        }
        Ok(())
    }).unwrap();
    apply(
        &w.module,
        "pause-page",
        ProjectWorkspaceIntent::PauseWork {
            scope: page.clone(),
        },
    );
    let local = turn(&w);
    assert_eq!(local.hold.as_ref().unwrap().scope, page);
    assert_ne!(local.episode, inherited.episode);
    apply(
        &w.module,
        "pause-overlapping-space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    let overlapping = turn(&w);
    assert_eq!(overlapping.hold, local.hold);
    assert_ne!(overlapping.episode, local.episode);
    apply(
        &w.module,
        "resume-overlapping-space",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_ne!(turn(&w).episode, overlapping.episode);
    apply(
        &w.module,
        "resume-page",
        ProjectWorkspaceIntent::ResumeWork { scope: page },
    );
    let still_held = turn(&w);
    assert_eq!(still_held.reason, Some(TurnReason::Paused));
    assert_eq!(still_held.hold.as_ref().unwrap().scope, project);
    assert_ne!(still_held.episode, local.episode);
    apply(
        &w.module,
        "resume-project",
        ProjectWorkspaceIntent::ResumeWork { scope: project },
    );
    let resumed = turn(&w);
    assert_eq!(resumed.reason, Some(TurnReason::Working));
    assert_ne!(resumed.episode, working.episode);
    assert_ne!(resumed.episode, still_held.episode);
    assert!(resumed.hold.is_none());
    w.kernel.readers().read_default(|c| {
        let raw:String=c.query_row("SELECT json_extract(projection_json,'$.requires_read_at_least') FROM local_commits ORDER BY commit_seq DESC LIMIT 1",[],|r|r.get(0))?;
        let scopes:Vec<nodex_core_contracts::events::LocalProjectionScope>=serde_json::from_str(&raw).unwrap();
        assert!(scopes.contains(&nodex_core_contracts::events::LocalProjectionScope::Library {library_id:"library-1".into()}), "Turn changes must publish the Library repair used by Page reads");
        assert!(scopes.iter().any(|scope| matches!(scope,nodex_core_contracts::events::LocalProjectionScope::DatabaseView {project_id,..} if project_id=="project:work")), "Board queries require their exact View repair, not a broad Project repair");
        Ok(())
    }).unwrap();
    apply(
        &w.module,
        "pause-space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_eq!(read_page(OUTSIDE).reason, Some(TurnReason::Paused));
    assert_eq!(turn(&w).hold.unwrap().scope, ExecutionHoldScope::Space);
    apply(
        &w.module,
        "resume-space",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_eq!(read_page(OUTSIDE).reason, None);
    assert_eq!(turn(&w).reason, Some(TurnReason::Working));
}
