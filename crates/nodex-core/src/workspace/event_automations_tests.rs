use super::*;
use crate::automation::AutomationModule;
use nodex_core_contracts::{
    CoreErrorCode, ModuleApplyRequest, StoreEpoch, agent::AgentTurnProvenance, automation::*,
    automation_assessment::*,
};
use rusqlite::params;

fn automation(w: &TestWorkspace, id: &str, mode: AutomationMode) -> Automation {
    configured_automation(w, id, mode, None)
}
fn configured_automation(
    w: &TestWorkspace,
    id: &str,
    mode: AutomationMode,
    runbook: Option<&str>,
) -> Automation {
    apply(
        &w.module,
        &format!("root-{id}"),
        ProjectWorkspaceIntent::UpdateProject {
            project_id: "project:default".into(),
            expected_binding_revision: match read(
                &w.module,
                ProjectWorkspaceRead::Project {
                    project_id: "project:default".into(),
                },
            ) {
                ProjectWorkspaceReadValue::Project { project: p } => p.binding_revision,
                _ => panic!("Project"),
            },
            name: None,
            description: None,
            appearance: None,
            source_roots: Some(vec![
                nodex_platform::fixture_path!("/workspace/event-automations").into(),
            ]),
        },
    );
    let input:AutomationInput=serde_json::from_value(json!({"kind":"cron","name":id,"condition_text":"When CI fails, investigate this Project","prompt":"Investigate the failure and propose a fix","mode":mode,"runbook_page_id":runbook,"project_id":"project:default","cwds":[nodex_platform::fixture_path!("/workspace/event-automations")],"execution_environment":"local","model":"test-model","source_condition":{"source_id":"github","repositories":["alice/repo"],"kinds":["check_failed"],"labels":[],"actor_class":"any"}})).unwrap();
    AutomationModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: format!("automation-{id}"),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: AutomationIntent::CreateAutomation {
                    automation_id: id.into(),
                    automation: input,
                },
            },
        )
        .unwrap()
        .committed
        .value
        .automations
        .remove(0)
}
fn event(w: &TestWorkspace, n: i64) {
    let mut batch = ingest(w, n - 1, "lease");
    if let SourceCommand::IngestSourceBatch { triggers, .. } = &mut batch {
        triggers[0].semantic_key = format!("github:github.com:10:check:{n}:failure");
        triggers[0].kind = "check".into();
        triggers[0].actor_class = SourceActorClass::Ci;
        triggers[0].metadata = json!({"state":"failure"});
    }
    apply(&w.module, &format!("event-{n}"), command(batch));
}
fn pending(w: &TestWorkspace) -> Vec<AutomationAssessmentRequest> {
    let ProjectWorkspaceReadValue::AutomationAssessments {
        value: AutomationAssessmentReadValue::Pending { requests },
    } = read(
        &w.module,
        ProjectWorkspaceRead::AutomationAssessments {
            read: AutomationAssessmentRead::Pending { limit: 8 },
        },
    )
    else {
        panic!("requests")
    };
    requests
}
fn coordinator(w: &TestWorkspace) {
    apply(
        &w.module,
        "coordinator",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: true,
            session_id: "nodex".into(),
            project_id: None,
            title: "Nodex".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:nodex".into(),
            launch_request_id: "launch:nodex".into(),
            side_chat_source_session_id: None,
        },
    );
}
fn begin(w: &TestWorkspace, r: &AutomationAssessmentRequest) {
    coordinator(w);
    apply(
        &w.module,
        &format!("begin-{}-{}", r.request_id, r.generation),
        ProjectWorkspaceIntent::AutomationAssessment {
            command: AutomationAssessmentCommand::Begin {
                request_id: r.request_id.clone(),
                generation: r.generation,
                coordinator_session_id: "nodex".into(),
            },
        },
    );
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    apply(
        &w.module,
        &format!("start-{}-{}", r.request_id, r.generation),
        ProjectWorkspaceIntent::AutomationAssessment {
            command: AutomationAssessmentCommand::StartRun {
                request_id: r.request_id.clone(),
                generation: r.generation,
                coordinator_session_id: "nodex".into(),
                started_at_ms: at,
            },
        },
    );
}
fn submit(r: &AutomationAssessmentRequest, matched: bool) -> ProjectWorkspaceIntent {
    let assessments = r
        .automations
        .iter()
        .map(|automation| AutomationAssessment {
            automation_id: automation.automation_id.clone(),
            revision: automation.automation_revision,
            matched,
            reason: if matched {
                "CI failed on this Project"
            } else {
                "The check does not establish the requested condition"
            }
            .into(),
            evidence_ids: r.trigger_ids.clone(),
        })
        .collect();
    let proposed = if matched {
        r.automations
            .iter()
            .map(|automation| AutomationProposedAction {
                automation_ids: vec![automation.automation_id.clone()],
                scope: AutomationActionScope::Project {
                    project_id: "project:default".into(),
                },
                title: "Investigate CI failure".into(),
                body: "Investigate the failing check and propose a fix".into(),
                execution_target: crate::automation::clock::agent_selection(automation).unwrap(),
                thread_id: r.thread_id.clone(),
            })
            .collect()
    } else {
        vec![]
    };
    ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:nodex".into(),
                root_thread_id: "thread:nodex".into(),
                turn_id: "run:nodex".into(),
                actor_project_id: None,
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: "nodex".into(),
                    runtime_id: "runtime".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }),
        intent: Box::new(ProjectWorkspaceIntent::AutomationAssessment {
            command: AutomationAssessmentCommand::Submit {
                request_id: r.request_id.clone(),
                generation: r.generation,
                policy_hash: r.policy_hash.clone(),
                automation_assessments: assessments,
                proposed_actions: proposed,
            },
        }),
    }
}
#[test]
fn filters_select_event_kind_repository_source_actor_and_labels() {
    let f = AutomationSourceFilter {
        source_id: Some("github".into()),
        repositories: vec!["alice/repo".into()],
        kinds: vec![AutomationSourceEventKind::CheckFailed],
        labels: vec![],
        actor_class: Some(AutomationActorFilter::Person),
    };
    let w = setup();
    let SourceCommand::IngestSourceBatch { mut triggers, .. } = ingest(&w, 0, "lease") else {
        panic!()
    };
    let e = &mut triggers[0];
    e.kind = "check".into();
    e.metadata = json!({"state":"failure"});
    assert!(crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
    e.actor_class = SourceActorClass::Ci;
    assert!(!crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
    let mut f = AutomationSourceFilter {
        actor_class: Some(AutomationActorFilter::Any),
        ..f
    };
    assert!(crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
    assert!(!crate::automation::event_filter::matches(
        &f,
        "other",
        &thread(),
        e
    ));
    f.repositories = vec!["other/repo".into()];
    assert!(!crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
    f.repositories.clear();
    f.kinds = vec![AutomationSourceEventKind::LabelAdded];
    f.labels = vec!["typo".into()];
    e.kind = "labeled".into();
    e.metadata = json!({"label":"feature","labels":["typo"]});
    assert!(!crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
    e.metadata = json!({"label":"typo"});
    assert!(crate::automation::event_filter::matches(
        &f,
        "github",
        &thread(),
        e
    ));
}
#[test]
fn one_unsettled_thread_request_coalesces_before_delivery_and_queues_later_evidence() {
    let w = setup();
    automation(&w, "observe", AutomationMode::DryRun);
    event(&w, 1);
    event(&w, 2);
    let r = pending(&w).remove(0);
    assert_eq!(r.trigger_ids.len(), 2);
    begin(&w, &r);
    event(&w, 3);
    assert_eq!(pending(&w).len(), 1);
    assert_eq!(pending(&w)[0].trigger_ids, r.trigger_ids);
    apply(&w.module, "submit", submit(&r, false));
    let next = pending(&w);
    assert_eq!(next.len(), 1);
    assert_ne!(next[0].request_id, r.request_id);
    assert_eq!(next[0].trigger_ids.len(), 1);
}
#[test]
fn observe_records_positive_and_negative_judgements_without_work() {
    for matched in [false, true] {
        let w = setup();
        automation(&w, "observe", AutomationMode::DryRun);
        event(&w, 1);
        let r = pending(&w).remove(0);
        begin(&w, &r);
        apply(&w.module, "submit", submit(&r, matched));
        assert!(pending(&w).is_empty());
        w.kernel.readers().read_default(move|c|{let (count,pages):(i64,i64)=c.query_row("SELECT count(*),count(page_id) FROM automation_decisions WHERE json_extract(assessment_json,'$.matched')=?1",[matched],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!((count,pages),(1,0));assert_eq!(c.query_row("SELECT count(*) FROM page_work_launches",[],|r|r.get::<_,i64>(0))?,0);assert_eq!(c.query_row("SELECT count(*) FROM change_log WHERE operation_id='submit' AND kind='automation.changed'",[],|r|r.get::<_,i64>(0))?,1);Ok(())}).unwrap();
    }
}
#[test]
fn full_automation_coverage_rejects_missing_duplicate_and_unknown_judgements() {
    let w = setup();
    automation(&w, "observe", AutomationMode::DryRun);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    for (index, kind) in ["missing", "duplicate", "unknown"].iter().enumerate() {
        let mut intent = submit(&r, false);
        if let ProjectWorkspaceIntent::AgentCommand { intent, .. } = &mut intent
            && let ProjectWorkspaceIntent::AutomationAssessment {
                command:
                    AutomationAssessmentCommand::Submit {
                        automation_assessments,
                        ..
                    },
            } = intent.as_mut()
        {
            match *kind {
                "missing" => automation_assessments.clear(),
                "duplicate" => automation_assessments.push(automation_assessments[0].clone()),
                _ => automation_assessments[0].automation_id = "unknown".into(),
            }
        }
        let error = w
            .module
            .apply(&context(), request(&format!("bad-{index}"), intent))
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(pending(&w).len(), 1);
    }
}
#[test]
fn ask_proposes_and_auto_starts_one_page_with_origin_and_owner_grant() {
    for mode in [AutomationMode::AskFirst, AutomationMode::Run] {
        let w = setup();
        automation(&w, "automation", mode);
        event(&w, 1);
        let r = pending(&w).remove(0);
        begin(&w, &r);
        apply(&w.module, "submit", submit(&r, true));
        let auto = mode == AutomationMode::Run;
        w.kernel
            .readers()
            .read_default(move |c| {
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM automation_decisions WHERE page_id IS NOT NULL",
                        [],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
                assert_eq!(
                    c.query_row("SELECT count(*) FROM page_work_launches", [], |r| r
                        .get::<_, i64>(0))?,
                    i64::from(auto)
                );
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM page_thread_follows WHERE role='origin'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )?,
                    i64::from(auto)
                );
                Ok(())
            })
            .unwrap();
    }
}
#[test]
fn external_bots_cannot_submit_an_automation_judgement() {
    let w = setup();
    automation(&w, "automation", AutomationMode::Run);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    let ProjectWorkspaceIntent::AgentCommand { intent, .. } = submit(&r, true) else {
        panic!()
    };
    let error = w
        .module
        .apply(&context(), request("bot-submit", *intent))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Unauthorized);
}

#[test]
fn a_changed_automation_requeues_the_same_trigger_with_a_new_generation_and_policy() {
    let w = setup();
    automation(&w, "automation", AutomationMode::DryRun);
    event(&w, 1);
    let old = pending(&w).remove(0);
    begin(&w, &old);
    let input:AutomationInput=serde_json::from_value(json!({"kind":"cron","name":"Automation","condition_text":"Investigate failed checks","prompt":"Investigate the failure","mode":"ask_first","project_id":"project:default","cwds":[nodex_platform::fixture_path!("/workspace/event-automations")],"execution_environment":"local","model":"test-model","source_condition":{"source_id":"github","repositories":["alice/repo"],"kinds":["check_failed"],"labels":[],"actor_class":"any"}})).unwrap();
    AutomationModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: "edit-automation".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: AutomationIntent::UpdateAutomation {
                    automation_id: "automation".into(),
                    expected_revision: 1,
                    status: AutomationStatus::Active,
                    automation: input,
                },
            },
        )
        .unwrap();
    let current = pending(&w).remove(0);
    assert_eq!(current.request_id, old.request_id);
    assert_eq!(current.generation, old.generation + 1);
    assert_eq!(current.trigger_ids, old.trigger_ids);
    assert_ne!(current.policy_hash, old.policy_hash);
    assert!(current.coordinator_session_id.is_none());
    assert!(
        w.module
            .apply(&context(), request("stale-answer", submit(&old, true)))
            .is_err()
    );
}
#[test]
fn equivalent_matched_actions_start_once_and_later_followed_events_are_never_assessed() {
    let w = setup();
    automation(&w, "one", AutomationMode::Run);
    automation(&w, "two", AutomationMode::Run);
    event(&w, 1);
    let r = pending(&w).remove(0);
    assert_eq!(r.automations.len(), 2);
    begin(&w, &r);
    apply(&w.module, "submit", submit(&r, true));
    w.kernel.readers().read_default(|c|{assert_eq!(c.query_row("SELECT count(*) FROM page_work_launches",[],|r|r.get::<_,i64>(0))?,1);assert_eq!(c.query_row("SELECT count(*) FROM automation_decisions WHERE json_array_length(json_extract(assessment_json,'$.contributing_automation_ids'))=2",[],|r|r.get::<_,i64>(0))?,2);Ok(())}).unwrap();
    event(&w, 2);
    assert!(pending(&w).is_empty());
}
#[test]
fn incompatible_actions_require_owner_confirmation_instead_of_auto() {
    let w = setup();
    automation(&w, "one", AutomationMode::Run);
    automation(&w, "two", AutomationMode::Run);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    let mut answer = submit(&r, true);
    if let ProjectWorkspaceIntent::AgentCommand { intent, .. } = &mut answer
        && let ProjectWorkspaceIntent::AutomationAssessment {
            command:
                AutomationAssessmentCommand::Submit {
                    proposed_actions, ..
                },
        } = intent.as_mut()
    {
        proposed_actions[1].body = "Repair the unrelated release job instead".into();
    }
    apply(&w.module, "submit", answer);
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM page_work_launches", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM automation_decisions WHERE status='held' AND mode='ask_first'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                2
            );
            Ok(())
        })
        .unwrap();
}
#[test]
fn confirming_ask_starts_its_reviewed_page_and_follows_the_thread() {
    use nodex_core_contracts::{collection::CollectionWindowRequest, inbox::*};
    let w = setup();
    automation(&w, "automation", AutomationMode::AskFirst);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    apply(&w.module, "submit", submit(&r, true));
    let ProjectWorkspaceReadValue::InboxWindow { items: window } = read(
        &w.module,
        ProjectWorkspaceRead::InboxWindow {
            scope: ProjectWorkspaceInboxScope::All,
            filter: ProjectWorkspaceInboxWindowFilter::Inbox,
            window: CollectionWindowRequest {
                first: Some(10),
                after: None,
            },
        },
    ) else {
        panic!("Inbox")
    };
    let proposal = window.items[0].proposal.clone().unwrap();
    event(&w, 2);
    assert_eq!(pending(&w).len(), 1);
    apply(
        &w.module,
        "confirm",
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            skill_invocations: vec![],
            confirmed_by: InboxConfirmedBy::User,
            expected_store_epoch: "epoch-1".into(),
            basis: proposal.basis,
            execution_selection: None,
            proposal_id: proposal.proposal_id,
            expected_revision: proposal.revision,
            action: None,
            session_id: None,
        },
    );
    assert!(pending(&w).is_empty());
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM page_work_launches", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM page_thread_follows WHERE role='origin'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM thread_deliveries", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn auto_launch_requires_its_current_standing_grant() {
    let w = setup();
    automation(&w, "automation", AutomationMode::Run);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    apply(&w.module, "submit", submit(&r, true));
    let decision = crate::domain::identity::stable_uuid_v7(
        "automation-assessment-decision",
        &r.request_id,
        &format!("{}:automation", r.generation),
    );
    let valid = || match read(
        &w.module,
        ProjectWorkspaceRead::AutomationAssessments {
            read: AutomationAssessmentRead::LaunchAuthority {
                decision_id: decision.clone(),
            },
        },
    ) {
        ProjectWorkspaceReadValue::AutomationAssessments {
            value: AutomationAssessmentReadValue::LaunchAuthority { valid, .. },
        } => valid,
        _ => panic!("authority"),
    };
    assert!(valid());
    AutomationModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: "pause-automation".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: AutomationIntent::SetAutomationStatus {
                    automation_id: "automation".into(),
                    expected_revision: 1,
                    status: AutomationStatus::Paused,
                },
            },
        )
        .unwrap();
    assert!(!valid());
}

#[test]
fn updates_queued_during_auto_assessment_reach_the_new_origin_follow() {
    let w = setup();
    automation(&w, "automation", AutomationMode::Run);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    event(&w, 2);
    apply(&w.module, "submit", submit(&r, true));
    assert!(pending(&w).is_empty());
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM thread_deliveries", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM automation_assessment_triggers WHERE request_id IS NULL",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn coordinator_reads_bounded_evidence_with_original_lengths_and_exact_automation_policy() {
    let w = setup();
    automation(&w, "automation", AutomationMode::DryRun);
    let mut batch = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch {
        triggers, threads, ..
    } = &mut batch
    {
        threads[0].title = "t".repeat(9000);
        threads[0].observations.insert(
            "internal-checkpoint".into(),
            SourceObservation {
                fingerprint: "internal polling data".into(),
                revision: 1,
            },
        );
        triggers[0].kind = "check".into();
        triggers[0].text = Some("x".repeat(9000));
        triggers[0].metadata = json!({"state":"failure", "thread_root":{"text":"y".repeat(10000)}});
    }
    apply(&w.module, "long-evidence", command(batch));
    let r = pending(&w).remove(0);
    begin(&w, &r);
    let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = submit(&r, false) else {
        panic!()
    };
    let resource = |kind| {
        let ProjectWorkspaceReadValue::AutomationAssessments {
            value: AutomationAssessmentReadValue::Resource { value, next_cursor },
        } = read(
            &w.module,
            ProjectWorkspaceRead::AutomationAssessments {
                read: AutomationAssessmentRead::Resource {
                    request_id: r.request_id.clone(),
                    generation: r.generation,
                    resource: kind,
                    cursor: None,
                    provenance: provenance.clone(),
                },
            },
        )
        else {
            panic!("Resource")
        };
        assert!(next_cursor.is_none());
        value
    };
    let evidence = resource(AutomationAssessmentResource::Triggers);
    assert!(evidence["thread"].get("observations").is_none());
    assert_eq!(evidence["thread"]["title"]["chars"], 9000);
    assert_eq!(evidence["thread"]["title"]["truncated"], true);
    assert_eq!(evidence["items"][0]["content"]["chars"], 9000);
    assert_eq!(evidence["items"][0]["content"]["truncated"], true);
    assert_eq!(
        evidence["items"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .len(),
        4000
    );
    assert_eq!(
        evidence["items"][0]["metadata"]["thread_root"]["text"]["chars"],
        10000
    );
    let policy = resource(AutomationAssessmentResource::Automations);
    assert_eq!(
        policy["items"][0]["revision"],
        r.automations[0].automation_revision
    );
    assert_eq!(
        policy["items"][0]["condition"],
        r.automations[0].condition_text
    );
    assert_eq!(policy["items"][0]["action"], r.automations[0].prompt);
    assert_eq!(policy["policy_hash"], r.policy_hash);
}

#[test]
fn event_work_keeps_its_frozen_target_and_runbook_without_binding_later_person_starts() {
    let w = setup();
    let page = "019d0000-0000-7000-8000-000000000091";
    apply(
        &w.module,
        "runbook",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:default".into(),
            },
            page_id: page.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Runbook".into(),
        },
    );
    configured_automation(&w, "automation", AutomationMode::Run, Some(page));
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    apply(&w.module, "submit", submit(&r, true));
    let ProjectWorkspaceReadValue::PageWorkOutbox { launches } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkOutbox { limit: 10 },
    ) else {
        panic!("Launch")
    };
    let launch = &launches[0];
    assert!(launch.automation_decision_id.is_some());
    assert!(launch.brief.contains(page));
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM project_session_pages WHERE session_id=?1 AND page_id=?2",
                    params![launch.session_id, page],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            Ok(())
        })
        .unwrap();
    apply(
        &w.module,
        "person-start",
        ProjectWorkspaceIntent::StartPageWork {
            page_id: launch.page_id.clone(),
            selection: Some(launch.selection.clone()),
            session_id: "person-session".into(),
            launch_id: "person-launch".into(),
            message_id: "person-message".into(),
            brief: "Start a reviewed attempt".into(),
            again: true,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    );
    let ProjectWorkspaceReadValue::PageWorkLaunch {
        launch: Some(person),
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkLaunch {
            launch_id: "person-launch".into(),
        },
    )
    else {
        panic!("Person launch")
    };
    assert!(person.automation_decision_id.is_none());
}

#[test]
fn a_concurrent_context_follow_retires_the_assessment_and_delivers_its_retained_batch() {
    let w = setup();
    automation(&w, "automation", AutomationMode::DryRun);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    event(&w, 2);
    create_project(&w.module, "work-project", "project:work");
    super::follows::card(&w, "019d0000-0000-7000-8000-000000000093", "worker", true);
    super::follows::context_follow(&w, "worker", "follow");
    assert!(pending(&w).is_empty());
    assert!(
        w.module
            .apply(&context(), request("stale", submit(&r, true)))
            .is_err()
    );
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM thread_deliveries", [], |r| r
                    .get::<_, i64>(0))?,
                2
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM automation_decisions", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn follow_updates_wait_for_automation_launch_admission_and_cannot_wake_a_rejected_start() {
    for accepted in [false, true] {
        let w = setup();
        automation(&w, "automation", AutomationMode::Run);
        event(&w, 1);
        let r = pending(&w).remove(0);
        begin(&w, &r);
        apply(&w.module, "submit", submit(&r, true));
        let ProjectWorkspaceReadValue::PageWorkOutbox { launches } = read(
            &w.module,
            ProjectWorkspaceRead::PageWorkOutbox { limit: 10 },
        ) else {
            panic!()
        };
        let launch = &launches[0];
        apply(
            &w.module,
            "prepare-runtime",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                agent_selection: None,
                coordinator: false,
                session_id: launch.session_id.clone(),
                project_id: Some(launch.project_id.clone()),
                title: "Investigate CI failure".into(),
                initial_page_ids: vec![],
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread:work".into(),
                launch_request_id: launch.launch_id.clone(),
                side_chat_source_session_id: None,
            },
        );
        event(&w, 2);
        let SourceReadValue::Deliveries { deliveries } = query(
            &w,
            SourceRead::Deliveries {
                page_id: Some(launch.page_id.clone()),
                state: Some("pending".into()),
                after_id: None,
                limit: 10,
            },
        ) else {
            panic!()
        };
        assert_eq!(deliveries.len(), 1);
        apply(
            &w.module,
            "prepare-update",
            command(SourceCommand::PrepareThreadDeliveryBatch {
                message_id: "source-update".into(),
                delivery_ids: vec![deliveries[0].id.clone()],
                body: "A later check failed".into(),
            }),
        );
        let held = || {
            let SourceReadValue::DeliveryBatches { batches } = query(
                &w,
                SourceRead::DeliveryBatches {
                    after_message_id: None,
                    limit: 10,
                },
            ) else {
                panic!()
            };
            batches[0].held
        };
        assert!(held());
        assert!(
            w.module
                .apply(
                    &context(),
                    request(
                        "premature-update",
                        command(SourceCommand::BeginThreadDeliveryBatch {
                            message_id: "source-update".into()
                        })
                    )
                )
                .is_err()
        );
        apply(
            &w.module,
            "settle-start",
            ProjectWorkspaceIntent::SettlePageWorkLaunch {
                launch_id: launch.launch_id.clone(),
                accepted_at: accepted.then(|| "2026-11-06T00:00:00Z".into()),
                rejection: (!accepted).then(|| "The standing grant changed".into()),
            },
        );
        assert_eq!(held(), !accepted);
        let result = w.module.apply(
            &context(),
            request(
                "update-after-settlement",
                command(SourceCommand::BeginThreadDeliveryBatch {
                    message_id: "source-update".into(),
                }),
            ),
        );
        assert_eq!(result.is_ok(), accepted);
    }
}

#[test]
fn ask_confirmation_uses_the_page_start_pause_guard() {
    use nodex_core_contracts::{collection::CollectionWindowRequest, inbox::*};
    let w = setup();
    automation(&w, "automation", AutomationMode::AskFirst);
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    apply(&w.module, "submit", submit(&r, true));
    let ProjectWorkspaceReadValue::InboxWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::InboxWindow {
            scope: ProjectWorkspaceInboxScope::All,
            filter: ProjectWorkspaceInboxWindowFilter::Inbox,
            window: CollectionWindowRequest {
                first: Some(10),
                after: None,
            },
        },
    ) else {
        panic!()
    };
    let proposal = items.items[0].proposal.clone().unwrap();
    apply(
        &w.module,
        "pause",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    let result = w.module.apply(
        &context(),
        request(
            "confirm-paused",
            ProjectWorkspaceIntent::ConfirmInboxDispatch {
                skill_invocations: vec![],
                confirmed_by: InboxConfirmedBy::User,
                expected_store_epoch: "epoch-1".into(),
                basis: proposal.basis,
                execution_selection: None,
                proposal_id: proposal.proposal_id,
                expected_revision: proposal.revision,
                action: None,
                session_id: None,
            },
        ),
    );
    assert!(result.is_err());
    w.kernel
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM page_work_launches", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM automation_decisions WHERE status='held'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn equivalent_text_with_different_runbooks_requires_separate_owner_review() {
    let w = setup();
    let page = "019d0000-0000-7000-8000-000000000094";
    apply(
        &w.module,
        "runbook",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:default".into(),
            },
            page_id: page.into(),
            document_id: "019d0000-0000-7000-8000-000000000095".into(),
            title: "Runbook".into(),
        },
    );
    automation(&w, "one", AutomationMode::Run);
    configured_automation(&w, "two", AutomationMode::Run, Some(page));
    event(&w, 1);
    let r = pending(&w).remove(0);
    begin(&w, &r);
    let mut intent = submit(&r, true);
    if let ProjectWorkspaceIntent::AgentCommand { intent, .. } = &mut intent
        && let ProjectWorkspaceIntent::AutomationAssessment {
            command:
                AutomationAssessmentCommand::Submit {
                    proposed_actions, ..
                },
        } = intent.as_mut()
    {
        proposed_actions[0].automation_ids.push("two".into());
        proposed_actions.truncate(1);
    }
    apply(&w.module, "submit", intent);
    w.kernel.readers().read_default(|c| {
        assert_eq!(c.query_row("SELECT count(*) FROM page_work_launches",[],|r|r.get::<_,i64>(0))?,0);
        assert_eq!(c.query_row("SELECT count(DISTINCT page_id) FROM automation_decisions WHERE mode='ask_first' AND status='held'",[],|r|r.get::<_,i64>(0))?,2);
        Ok(())
    }).unwrap();
}
