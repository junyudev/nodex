//! Public Automation/Inbox mutations prove the Activity fact projection and its scope.
use super::super::test_support::{TestWorkspace, apply, context, read, seeded_workspace};
use crate::automation::AutomationModule;
use nodex_core_contracts::{
    ModuleApplyRequest, ModuleReadRequest, StoreEpoch,
    automation::{
        AUTOMATION_CONTRACT_VERSION, AutomationInput, AutomationIntent, AutomationLease,
        AutomationMode, AutomationRead, AutomationReadValue, AutomationScope, AutomationStatus,
    },
    collection::{CollectionWindow, CollectionWindowRequest},
    inbox::{ProjectWorkspaceInboxEntryState, ProjectWorkspaceInboxScope},
    sources::{ActivityFilter, ActivityRow, ActivitySubject},
    workspace::{ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue},
};
use serde_json::json;

fn definition(name: &str, mode: AutomationMode, scope: AutomationScope) -> AutomationInput {
    serde_json::from_value(json!({
        "kind":"cron","name":name,"mode":mode,"scope":scope,
        "prompt":"Review the queue","rrule":"FREQ=YEARLY","timezone":"UTC",
        "project_id":null,"cwds":[],"execution_environment":"local"
    }))
    .unwrap()
}
fn automation(
    w: &TestWorkspace,
    id: &str,
    intent: AutomationIntent,
) -> crate::automation::AutomationApplyOutcome {
    AutomationModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                operation_id: id.into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent,
            },
        )
        .unwrap()
}
fn materialize(
    w: &TestWorkspace,
    id: &str,
    name: &str,
    mode: AutomationMode,
    scope: AutomationScope,
) {
    automation(
        w,
        &format!("create-{id}"),
        AutomationIntent::CreateAutomation {
            automation_id: id.into(),
            automation: definition(name, mode, scope),
        },
    );
    // The fixture advances this Automation's clock; materialization itself uses its public producer.
    let automation_id = id.to_owned();
    w.kernel
        .writer()
        .call(move |c| {
            c.execute(
                "UPDATE automations SET next_run_at=0 WHERE automation_id=?1",
                [&automation_id],
            )?;
            Ok(())
        })
        .unwrap();
    let snapshot = AutomationModule::new("profile-1", "library-1", &w.kernel)
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                read: AutomationRead::DueWork {
                    lane: nodex_core_contracts::automation::AutomationDueWorkLane::Automations,
                },
            },
        )
        .unwrap();
    let AutomationReadValue::DueWork { plan } = snapshot.value else {
        panic!("due plan")
    };
    let leases = automation(
        w,
        &format!("claim-{id}"),
        AutomationIntent::ClaimDue {
            work_token: plan.work_token.expect("due clock"),
            limit: 10,
            lease_duration_ms: 60_000,
        },
    )
    .committed
    .value
    .claimed_leases;
    if mode != AutomationMode::AskFirst {
        return;
    }
    let lease: &AutomationLease = leases
        .iter()
        .find(|lease| lease.automation_id == id)
        .expect("Ask first hold lease");
    apply(
        &w.module,
        &format!("hold-{id}"),
        ProjectWorkspaceIntent::HoldAutomationDecision {
            lease_id: lease.lease_id.clone(),
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            title: format!("{name} · today"),
        },
    );
}
fn activity(
    w: &TestWorkspace,
    scope: ProjectWorkspaceInboxScope,
    filter: ActivityFilter,
    after: Option<String>,
    first: u32,
) -> CollectionWindow<ActivityRow> {
    let ProjectWorkspaceReadValue::ActivityWindow { rows } = read(
        &w.module,
        ProjectWorkspaceRead::ActivityWindow {
            scope,
            filter,
            window: CollectionWindowRequest {
                after,
                first: Some(first),
            },
        },
    ) else {
        panic!("Activity window")
    };
    rows
}
fn decisions(w: &TestWorkspace) -> Vec<ActivityRow> {
    activity(
        w,
        ProjectWorkspaceInboxScope::All,
        ActivityFilter::Decisions,
        None,
        100,
    )
    .items
}
fn messages(w: &TestWorkspace) -> Vec<ActivityRow> {
    activity(
        w,
        ProjectWorkspaceInboxScope::All,
        ActivityFilter::Messages,
        None,
        100,
    )
    .items
}
fn automation_row<'a>(rows: &'a [ActivityRow], id: &str) -> &'a ActivityRow {
    rows.iter()
        .find(|row| row.id.starts_with("automation:") && row.evidence["automation_id"] == id)
        .expect("Automation decision Activity")
}
fn settlement<'a>(rows: &'a [ActivityRow], id: &str) -> &'a ActivityRow {
    rows.iter()
        .find(|row| {
            row.id.starts_with("automation-settlement:") && row.evidence["automation_id"] == id
        })
        .expect("Automation settlement Activity")
}

#[test]
fn clock_modes_share_decisions_filter_scope_and_frozen_name_and_subject() {
    let w = seeded_workspace();
    materialize(
        &w,
        "observe",
        "Daily review",
        AutomationMode::DryRun,
        AutomationScope::Project {
            project_id: "project:default".into(),
        },
    );
    materialize(
        &w,
        "ask",
        "Queue review",
        AutomationMode::AskFirst,
        AutomationScope::Space,
    );
    materialize(
        &w,
        "auto",
        "Release review",
        AutomationMode::Run,
        AutomationScope::Space,
    );
    let rows = decisions(&w);
    assert_eq!(rows.len(), 3);
    for (id, name, description) in [
        (
            "observe",
            "Daily review",
            "Would have started “Daily review”",
        ),
        ("ask", "Queue review", "Proposed “Queue review”"),
        ("auto", "Release review", "Started “Release review”"),
    ] {
        let row = automation_row(&rows, id);
        assert_eq!(row.category, "decisions");
        assert_eq!(row.description, description);
        assert_eq!(
            row.subject,
            Some(ActivitySubject::Automation {
                automation_id: id.into(),
                label: name.into()
            })
        );
        assert!(row.reason.as_ref().is_some_and(|reason| !reason.is_empty()));
        assert!(row.evidence.get("frozen_action").is_none());
        assert!(row.evidence.get("prompt").is_none());
    }
    let observed = automation_row(&rows, "observe").clone();
    assert!(observed.page_id.is_none() && observed.session_id.is_none());
    automation(
        &w,
        "rename",
        AutomationIntent::UpdateAutomation {
            automation_id: "observe".into(),
            expected_revision: 1,
            status: AutomationStatus::Active,
            automation: definition(
                "Renamed review",
                AutomationMode::DryRun,
                AutomationScope::Project {
                    project_id: "project:default".into(),
                },
            ),
        },
    );
    let project = activity(
        &w,
        ProjectWorkspaceInboxScope::Project {
            project_id: "project:default".into(),
        },
        ActivityFilter::Decisions,
        None,
        10,
    );
    assert_eq!(project.items, vec![observed]);
    let library = activity(
        &w,
        ProjectWorkspaceInboxScope::Library,
        ActivityFilter::Decisions,
        None,
        10,
    );
    assert_eq!(library.items.len(), 2);
    assert!(
        library
            .items
            .iter()
            .all(|row| row.evidence["automation_id"] != "observe")
    );
    assert!(
        activity(
            &w,
            ProjectWorkspaceInboxScope::All,
            ActivityFilter::Problems,
            None,
            10
        )
        .items
        .is_empty()
    );
    let first = activity(
        &w,
        ProjectWorkspaceInboxScope::All,
        ActivityFilter::Decisions,
        None,
        1,
    );
    let second = activity(
        &w,
        ProjectWorkspaceInboxScope::All,
        ActivityFilter::Decisions,
        first.next_cursor.clone(),
        1,
    );
    assert_ne!(first.items[0].id, second.items[0].id);
    assert_eq!(first.items.len(), 1);
    let wrong_filter = w.module.read(
        &context(),
        ModuleReadRequest {
            contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            read: ProjectWorkspaceRead::ActivityWindow {
                scope: ProjectWorkspaceInboxScope::All,
                filter: ActivityFilter::Problems,
                window: CollectionWindowRequest {
                    first: Some(1),
                    after: first.next_cursor,
                },
            },
        },
    );
    assert!(wrong_filter.is_err());
}

#[test]
fn held_and_confirmed_automation_work_are_each_one_activity_transition() {
    let w = seeded_workspace();
    materialize(
        &w,
        "ask",
        "Queue review",
        AutomationMode::AskFirst,
        AutomationScope::Space,
    );
    let held = decisions(&w);
    assert_eq!(
        held.len(),
        1,
        "The Automation fact replaces its generic routing proposal"
    );
    let proposal = automation_row(&held, "ask").clone();
    automation(
        &w,
        "confirm-held",
        AutomationIntent::DispatchNow {
            automation_id: "ask".into(),
        },
    );
    let confirmed = decisions(&w);
    assert_eq!(confirmed, vec![proposal]);
    // The person's confirmation is the message's one handled fact, not another decision.
    let handled = messages(&w);
    assert_eq!(handled.len(), 1);
    assert_eq!(handled[0].description, "Started “Queue review”");
    assert_eq!(
        handled[0]
            .message
            .as_ref()
            .map(|item| item.page_id.as_str()),
        Some("page:ask")
    );
}

#[test]
fn a_renamed_automation_keeps_the_original_proposal_label_after_confirmation() {
    let w = seeded_workspace();
    materialize(
        &w,
        "ask",
        "Queue review",
        AutomationMode::AskFirst,
        AutomationScope::Space,
    );
    let proposed = automation_row(&decisions(&w), "ask").clone();
    automation(
        &w,
        "rename-held",
        AutomationIntent::UpdateAutomation {
            automation_id: "ask".into(),
            expected_revision: 1,
            status: AutomationStatus::Active,
            automation: definition(
                "Renamed review",
                AutomationMode::AskFirst,
                AutomationScope::Space,
            ),
        },
    );
    automation(
        &w,
        "confirm-renamed",
        AutomationIntent::DispatchNow {
            automation_id: "ask".into(),
        },
    );
    let rows = decisions(&w);
    let original = automation_row(&rows, "ask");
    assert_eq!(original.id, proposed.id);
    assert_eq!(original.at, proposed.at);
    assert_eq!(original.description, proposed.description);
    assert_eq!(original.subject, proposed.subject);

    let snapshot = AutomationModule::new("profile-1", "library-1", &w.kernel)
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                read: AutomationRead::AutomationDecisions {
                    automation_id: "ask".into(),
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(1),
                    },
                },
            },
        )
        .unwrap();
    let AutomationReadValue::AutomationDecisions { window } = snapshot.value else {
        panic!("Automation decision")
    };
    assert_eq!(window.items[0].frozen_action["name"], "Renamed review");
    assert_eq!(window.items[0].automation_revision, 2);
}

#[test]
fn a_confirmed_automation_start_hydrates_the_bound_runs_chat_and_title() {
    let w = seeded_workspace();
    materialize(
        &w,
        "ask",
        "Queue review",
        AutomationMode::AskFirst,
        AutomationScope::Space,
    );
    let proposed = automation_row(&decisions(&w), "ask").clone();
    let dispatch = proposed.evidence["decision_id"].as_str().unwrap();
    automation(
        &w,
        "confirm-for-chat",
        AutomationIntent::DispatchNow {
            automation_id: "ask".into(),
        },
    );
    apply(
        &w.module,
        "create-run-chat",
        ProjectWorkspaceIntent::CreateSession {
            session_id: "run-chat".into(),
            project_id: None,
            title: "Investigate queue failures".into(),
            initial_page_ids: vec![],
        },
    );
    let run = automation(
        &w,
        "begin-confirmed-run",
        AutomationIntent::BeginRun {
            agent_selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: "codex".into(),
                model: "model".into(),
                effort: None,
            }),
            message_id: None,
            notification_policy: None,
            run_id: "confirmed-run".into(),
            automation_id: "ask".into(),
            dispatch_id: Some(dispatch.into()),
            session_id: None,
            session_title: None,
            source_cwd: None,
        },
    )
    .committed
    .value
    .runs
    .remove(0);
    automation(
        &w,
        "bind-confirmed-run",
        AutomationIntent::BindRunSession {
            run_id: run.run_id,
            session_id: "run-chat".into(),
            expected_revision: run.run_revision,
        },
    );
    let rows = decisions(&w);
    let handled = messages(&w);
    let confirmed = handled
        .iter()
        .find(|row| row.id.starts_with("message:"))
        .expect("Person confirmation");
    assert_eq!(confirmed.evidence["action"]["decision_id"], dispatch);
    assert_eq!(confirmed.session_id.as_deref(), Some("run-chat"));
    // The run is named by its Automation; the chat it reached is the row's link.
    assert_eq!(confirmed.description, "Started “Queue review”");
    assert_eq!(
        confirmed.subject,
        Some(ActivitySubject::Chat {
            session_id: "run-chat".into(),
            label: "Investigate queue failures".into(),
        })
    );
    assert_eq!(
        automation_row(&rows, "ask").session_id.as_deref(),
        Some("run-chat")
    );
    assert_eq!(
        automation_row(&rows, "ask").description,
        proposed.description
    );
    assert_eq!(automation_row(&rows, "ask").subject, proposed.subject);
}

#[test]
fn skipped_and_withdrawn_decisions_override_the_mode_and_keep_the_automation_link() {
    let w = seeded_workspace();
    materialize(
        &w,
        "ask",
        "Queue review",
        AutomationMode::AskFirst,
        AutomationScope::Space,
    );
    let proposed = automation_row(&decisions(&w), "ask").clone();
    apply(
        &w.module,
        "skip",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:ask".into()],
            state: ProjectWorkspaceInboxEntryState::Done,
        },
    );
    let skipped = decisions(&w);
    assert_eq!(
        settlement(&skipped, "ask").description,
        "Skipped “Queue review”"
    );
    assert_eq!(automation_row(&skipped, "ask").id, proposed.id);
    assert_eq!(automation_row(&skipped, "ask").at, proposed.at);
    assert_eq!(
        automation_row(&skipped, "ask").description,
        proposed.description
    );
    apply(
        &w.module,
        "reopen",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:ask".into()],
            state: ProjectWorkspaceInboxEntryState::Open,
        },
    );
    automation(
        &w,
        "delete-automation",
        AutomationIntent::DeleteAutomation {
            automation_id: "ask".into(),
            expected_revision: 1,
        },
    );
    let rows = decisions(&w);
    let row = settlement(&rows, "ask");
    assert_eq!(automation_row(&rows, "ask").id, proposed.id);
    assert_eq!(automation_row(&rows, "ask").at, proposed.at);
    assert_eq!(
        automation_row(&rows, "ask").description,
        proposed.description
    );
    assert_eq!(row.description, "Withdrew “Queue review”");
    assert_eq!(
        row.subject,
        Some(ActivitySubject::Automation {
            automation_id: "ask".into(),
            label: "Queue review".into()
        })
    );
    assert!(row.page_id.is_some());
}

#[test]
fn a_manual_ask_start_is_an_admission_instead_of_a_clock_proposal() {
    let w = seeded_workspace();
    automation(
        &w,
        "create-manual",
        AutomationIntent::CreateAutomation {
            automation_id: "manual".into(),
            automation: definition(
                "Manual review",
                AutomationMode::AskFirst,
                AutomationScope::Space,
            ),
        },
    );
    automation(
        &w,
        "run-manual",
        AutomationIntent::DispatchNow {
            automation_id: "manual".into(),
        },
    );
    let rows = decisions(&w);
    assert_eq!(rows.len(), 1);
    let row = automation_row(&rows, "manual");
    assert_eq!(row.description, "Started “Manual review”");
    assert_eq!(row.evidence["manual"], json!(true));
    assert_eq!(row.evidence["status"], "admitted");
    assert_eq!(
        row.subject,
        Some(ActivitySubject::Automation {
            automation_id: "manual".into(),
            label: "Manual review".into()
        })
    );
}

#[test]
fn terminal_history_without_transition_evidence_never_invents_initial_activity() {
    let w = seeded_workspace();
    for (id, mode) in [
        ("observe", AutomationMode::DryRun),
        ("ask", AutomationMode::AskFirst),
        ("auto", AutomationMode::Run),
    ] {
        let automation = automation(
            &w,
            &format!("create-{id}"),
            AutomationIntent::CreateAutomation {
                automation_id: id.into(),
                automation: definition("Unavailable Owner", mode, AutomationScope::Space),
            },
        )
        .committed
        .value
        .automations
        .remove(0);
        // Retained terminal storage can precede admission. It proves withdrawal, but no
        // observation, proposal, lease or start. Owner retirement itself is covered by
        // the public Automation lifecycle tests rather than reactivating a retired Automation here.
        w.kernel.writer().call(move |c| {
            c.execute(
                "INSERT INTO automation_decisions(dispatch_id,automation_id,status,mode,automation_revision,reason,frozen_action_json,frozen_authority_json,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms) VALUES(?1,?2,'withdrawn',?3,?4,'Automation Owner is unavailable',?5,?6,1000,1000,'{}',1000,1500)",
                rusqlite::params![format!("terminal:{}", automation.automation_id), automation.automation_id,
                    serde_json::to_value(mode).unwrap().as_str().unwrap(), automation.automation_revision,
                    serde_json::to_string(&automation).unwrap(), json!({"owner_member_id":automation.owner_member_id}).to_string()],
            )?;
            Ok(())
        }).unwrap();
    }
    let rows = decisions(&w);
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|row| row.id.starts_with("automation-settlement:"))
    );
    assert!(
        rows.iter()
            .all(|row| row.description == "Withdrew “Unavailable Owner”")
    );
    assert!(
        rows.iter()
            .all(|row| row.page_id.is_none() && row.session_id.is_none())
    );
}
