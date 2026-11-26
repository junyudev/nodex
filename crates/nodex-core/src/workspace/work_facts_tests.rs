use super::test_support::*;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::{CoreErrorCode, agent::AgentTurnProvenance, workspace::*};

fn launch(id: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::CreateAgentRuntimeSession {
        agent_selection: None,
        decision_run: None,
        session_id: id.into(),
        project_id: None,
        title: id.into(),
        initial_page_ids: vec![],
        runtime_id: "runtime".into(),
        runtime_thread_id: format!("thread:{id}"),
        launch_request_id: format!("launch:{id}"),
        side_chat_source_session_id: None,
    }
}
fn report(page: Option<&str>, summary: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:work".into(),
                root_thread_id: "thread:work".into(),
                turn_id: "run:work".into(),
                actor_project_id: None,
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: "work".into(),
                    runtime_id: "runtime".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }),
        intent: Box::new(ProjectWorkspaceIntent::ReportPageWork {
            page_id: page.map(str::to_owned),
            outcome: WorkReportOutcome::Ready,
            summary: summary.into(),
        }),
    }
}

fn decision_launch() -> ProjectWorkspaceIntent {
    let mut intent = launch("nodex");
    let ProjectWorkspaceIntent::CreateAgentRuntimeSession { decision_run, .. } = &mut intent else {
        unreachable!();
    };
    *decision_run = Some(NodexDecisionRunInput {
        kind: NodexDecisionRunKind::Routing,
        request_id: "request".into(),
        generation: 1,
    });
    intent
}

#[test]
fn a_chat_on_several_pages_reports_by_the_page_key_from_its_brief() {
    let w = seeded_workspace();
    apply(&w.module, "work", launch("work"));
    create_project(&w.module, "project:work:create", "project:work");
    let pages = [
        "019d0000-0000-7000-8000-0000000000a1",
        "019d0000-0000-7000-8000-0000000000a3",
    ];
    for (index, page) in pages.iter().enumerate() {
        apply(
            &w.module,
            &format!("create:{index}"),
            ProjectWorkspaceIntent::CreatePageFor {
                target: ProjectWorkspacePageCreationTarget::Project {
                    project_id: "project:work".into(),
                },
                page_id: (*page).into(),
                document_id: format!("019d0000-0000-7000-8000-0000000000b{index}"),
                title: format!("Work {index}"),
            },
        );
        apply(
            &w.module,
            &format!("link:{index}"),
            ProjectWorkspaceIntent::MutateSession {
                session_id: "work".into(),
                intent: ProjectSessionIntent::LinkPage {
                    page_id: (*page).into(),
                },
            },
        );
    }
    let key = |page: &str| {
        w.kernel
            .readers()
            .read_default(|c| {
                Ok(
                    crate::database::current_page_key_for_page(c, "library-1", page)?
                        .expect("Project Pages carry keys"),
                )
            })
            .unwrap()
    };
    let (first, second) = (key(pages[0]), key(pages[1]));
    // Naming nothing is ambiguous; the refusal says which Pages the chat may name.
    let ambiguous = w
        .module
        .apply(&context(), request("ambiguous", report(None, "Done")))
        .unwrap_err();
    assert!(ambiguous.message.contains(&first) && ambiguous.message.contains(&second));
    let foreign = w
        .module
        .apply(
            &context(),
            request("foreign", report(Some("NOPE-9"), "Done")),
        )
        .unwrap_err();
    assert!(foreign.message.contains("not linked to NOPE-9"));
    apply(
        &w.module,
        "by-key",
        report(Some(&second.to_lowercase()), "Second is done."),
    );
    let reported = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT page_id FROM project_session_pages WHERE session_id='work' AND report_outcome='ready'",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert_eq!(reported, pages[1]);
}

#[test]
fn decision_run_is_absent_from_discovery_routing_and_page_chats() {
    let w = seeded_workspace();
    apply(&w.module, "work", launch("work"));
    apply(&w.module, "decision", decision_launch());
    let window = CollectionWindowRequest {
        first: Some(100),
        after: None,
    };
    let chat_list = |archived, query| {
        let ProjectWorkspaceReadValue::SessionWindow { sessions, .. } = read(
            &w.module,
            ProjectWorkspaceRead::SessionWindow {
                provenance: None,
                archived,
                order: None,
                projectless_only: None,
                exclude_drafts: None,
                chat_list_only: None,
                project_id: None,
                query,
                native_only: None,
                execution_refs: None,
                session_ids: None,
                window: window.clone(),
            },
        ) else {
            panic!("sessions")
        };
        sessions.items
    };
    let sessions = chat_list(false, None);
    assert!(sessions.iter().any(|x| x.task.session.id == "work"));
    assert!(!sessions.iter().any(|x| x.task.session.id == "nodex"));
    assert!(
        chat_list(false, Some("nodex".into()))
            .iter()
            .all(|row| row.task.session.id != "nodex")
    );
    let ProjectWorkspaceReadValue::InboxChatTargets { window: targets } = read(
        &w.module,
        ProjectWorkspaceRead::InboxChatTargets {
            scope: nodex_core_contracts::inbox::ProjectWorkspaceInboxScope::Library,
            query: "".into(),
            window: window.clone(),
        },
    ) else {
        panic!("targets")
    };
    assert!(targets.items.iter().all(|x| x.session_id != "nodex"));
    create_library_page(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        "project:default",
    );
    assert_eq!(
        w.module
            .apply(
                &context(),
                request(
                    "link:nodex",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "nodex".into(),
                        intent: ProjectSessionIntent::LinkPage {
                            page_id: "019d0000-0000-7000-8000-000000000091".into(),
                        },
                    },
                )
            )
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidInput
    );
    let ProjectWorkspaceReadValue::SessionExecutionObserver { observer } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObserver {
            session_id: "nodex".into(),
        },
    ) else {
        panic!("observer")
    };
    assert!(observer.is_none());
    let ProjectWorkspaceReadValue::SessionExecutionObservers { observers } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObservers {
            after_session_id: None,
            limit: 100,
        },
    ) else {
        panic!("observers")
    };
    assert!(observers.iter().any(|row| row.session_id == "work"));
    assert!(observers.iter().all(|row| row.session_id != "nodex"));
    let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
        &w.module,
        ProjectWorkspaceRead::PageChatWindow {
            page_id: "019d0000-0000-7000-8000-000000000091".into(),
            include_archived: Some(true),
            window: window.clone(),
        },
    ) else {
        panic!("chats")
    };
    assert!(chats.items.is_empty());
    let ProjectWorkspaceReadValue::SessionDetail { session, .. } = read(
        &w.module,
        ProjectWorkspaceRead::SessionDetail {
            session_id: "nodex".into(),
        },
    ) else {
        panic!("decision Session")
    };
    assert_eq!(
        session.decision_run_kind,
        Some(NodexDecisionRunKind::Routing)
    );
    assert!(!session.can_manage && !session.can_stop);
    for (op, intent) in [
        (
            "archive-decision",
            ProjectSessionIntent::SetArchived { archived: true },
        ),
        (
            "unarchive-decision",
            ProjectSessionIntent::SetArchived { archived: false },
        ),
        (
            "rename-decision",
            ProjectSessionIntent::Rename {
                title: "Rename".into(),
            },
        ),
    ] {
        let error = w
            .module
            .apply(
                &context(),
                request(
                    op,
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "nodex".into(),
                        intent,
                    },
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
    }
    assert!(
        chat_list(true, None)
            .iter()
            .all(|row| row.task.session.id != "nodex")
    );
}

#[test]
fn decision_run_sidebar_sections_and_pins_do_not_reveal_its_session() {
    let w = seeded_workspace();
    apply(&w.module, "work", launch("work"));
    apply(&w.module, "decision", decision_launch());
    let window = CollectionWindowRequest {
        first: Some(100),
        after: None,
    };
    let ProjectWorkspaceReadValue::SidebarSectionWindow { sections } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarSectionWindow {
            include_deleted: None,
            window: window.clone(),
        },
    ) else {
        panic!("sections")
    };
    let chats = sections
        .items
        .iter()
        .find(|section| section.section_id == "sidebar:chats")
        .unwrap();
    assert_eq!(chats.effective_session_count, 1);
    apply(
        &w.module,
        "section:nodex",
        ProjectWorkspaceIntent::CreateSidebarSection {
            section_id: "section:nodex".into(),
            name: "Work".into(),
            initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Session {
                session_id: "nodex".into(),
            }),
        },
    );
    let ProjectWorkspaceReadValue::SidebarSectionItemWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarSectionItemWindow {
            section_id: "section:nodex".into(),
            include_archived: Some(true),
            window: window.clone(),
        },
    ) else {
        panic!("section items")
    };
    assert!(items.items.is_empty());
    let error = w
        .module
        .apply(
            &context(),
            request(
                "pin:nodex",
                ProjectWorkspaceIntent::MutateSession {
                    session_id: "nodex".into(),
                    intent: ProjectSessionIntent::SetPinned { pinned: true },
                },
            ),
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Unauthorized);
    let ProjectWorkspaceReadValue::SidebarOverview { pinned_tasks } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarOverview {
            include_archived: Some(true),
            pinned_window: window,
        },
    ) else {
        panic!("pins")
    };
    assert!(pinned_tasks.items.is_empty());
}

const STAGE_PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn stage_fixture() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project:stages", "project:work");
    apply(
        &w.module,
        "page:stages",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: STAGE_PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    apply(&w.module, "work", launch("work"));
    apply(
        &w.module,
        "handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    crate::workspace::test_support::mark_managed(&w, "work");
    w
}
fn stage(w: &TestWorkspace) -> String {
    w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT json_extract(value.value_json,'$') FROM data_source_property_values value JOIN data_source_page_memberships member ON member.id=value.membership_id WHERE member.page_block_id=?1 AND member.removed_at IS NULL AND value.property_id='status'",[STAGE_PAGE],|r|r.get(0))?)).unwrap()
}
fn stage_edit(w: &TestWorkspace, status: &str) -> nodex_core_contracts::database::DatabaseIntent {
    use nodex_core_contracts::database::*;
    let (source,revision) = w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT value.data_source_id,value.revision FROM data_source_property_values value JOIN data_source_page_memberships member ON member.id=value.membership_id WHERE member.page_block_id=?1 AND member.removed_at IS NULL AND value.property_id='status'",[STAGE_PAGE],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
    DatabaseIntent::EditPropertyValues {
        edits: vec![DatabasePropertyValueMutation {
            expected_membership_revision: None,
            address: DatabasePagePropertyAddress {
                page_id: STAGE_PAGE.into(),
                data_source_id: source,
                property_id: "status".into(),
            },
            edit: DatabasePropertyValueEdit::Replace {
                expected_value_revision: revision,
                value: DatabasePropertyValueInput::Select {
                    option_id: status.into(),
                },
            },
        }],
    }
}

fn set_stage(w: &TestWorkspace, id: &str, status: &str, person: bool) {
    let intent = stage_edit(w, status);
    if person {
        crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
            .apply(
                &context(),
                nodex_core_contracts::ModuleApplyRequest {
                    contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                    store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
                    operation_id: id.into(),
                    intent: vec![intent],
                },
            )
            .unwrap();
        return;
    }
    // Set an automatic predecessor through the same transactional Database collaborator.
    let id = id.to_owned();
    let mut agent = context();
    agent.adapter = nodex_core_contracts::AdapterKind::Agent;
    w.kernel
        .writer()
        .call(move |c| {
            crate::infrastructure::sqlite::with_immediate_transaction(c, |c| {
                crate::database::apply_intents_as_collaborator(
                    c,
                    "library-1",
                    &agent,
                    &id,
                    &[intent],
                    "2026-11-05T00:00:00.000Z",
                )
                .map(|_| ())
            })
        })
        .unwrap();
}
fn outcome_report(outcome: WorkReportOutcome) -> ProjectWorkspaceIntent {
    let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = report(None, "Checked work.")
    else {
        panic!()
    };
    ProjectWorkspaceIntent::AgentCommand {
        provenance,
        intent: Box::new(ProjectWorkspaceIntent::ReportPageWork {
            page_id: None,
            outcome,
            summary: "Checked work.".into(),
        }),
    }
}
fn report_outcome(w: &TestWorkspace) -> Option<String> {
    w.kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
        "SELECT report_outcome FROM project_session_pages WHERE session_id='work' AND page_id=?1",
        [STAGE_PAGE], |row| row.get(0),
    )?)
        })
        .unwrap()
}
fn report_moved(w: &TestWorkspace) -> bool {
    w.kernel.readers().read_default(|c| Ok(c.query_row(
        "SELECT report_status_moved FROM project_session_pages WHERE session_id='work' AND page_id=?1",
        [STAGE_PAGE], |row| row.get(0),
    )?)).unwrap()
}
#[test]
fn report_facts_follow_only_their_predecessors_and_keep_every_skipped_fact() {
    for before in ["triage", "plan", "doing", "review", "done", "canceled"] {
        for outcome in [
            WorkReportOutcome::Ready,
            WorkReportOutcome::Dropped,
            WorkReportOutcome::Blocked,
            WorkReportOutcome::Failed,
        ] {
            let w = stage_fixture();
            set_stage(&w, "predecessor", before, false);
            apply(&w.module, "report", outcome_report(outcome));
            let expected = match (outcome, before) {
                (WorkReportOutcome::Ready, "doing") => "review",
                (WorkReportOutcome::Dropped, "triage" | "plan" | "doing") => "canceled",
                _ => before,
            };
            assert_eq!(stage(&w), expected, "{before} {outcome:?}");
            assert_eq!(report_moved(&w), before != expected);
            let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
                &w.module,
                ProjectWorkspaceRead::PageChatActivitySummaries {
                    page_ids: vec![STAGE_PAGE.into()],
                },
            ) else {
                panic!()
            };
            assert_eq!(
                summaries[0]
                    .work
                    .latest_report
                    .as_ref()
                    .unwrap()
                    .status_moved,
                Some(before != expected)
            );

            let retained=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT report_revision,report_status_moved FROM project_session_pages WHERE page_id=?1 AND session_id='work'",[STAGE_PAGE],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,bool>(1)?)))?)).unwrap();
            assert_eq!(retained, (1, before != expected));
        }
    }
}
#[test]
fn a_persons_move_including_aba_fences_a_later_report() {
    for moves in [vec!["review"], vec!["plan", "doing"]] {
        let w = stage_fixture();
        for (i, status) in moves.iter().enumerate() {
            set_stage(&w, &format!("person:{i}"), status, true);
        }
        apply(
            &w.module,
            "report",
            outcome_report(WorkReportOutcome::Ready),
        );
        assert_eq!(stage(&w), *moves.last().unwrap());
        assert!(!report_moved(&w));
    }
}
#[test]
fn a_batch_group_move_away_and_back_fences_a_later_report() {
    use nodex_core_contracts::database::DatabaseGroupScope;
    use nodex_core_contracts::library::*;
    use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};

    for mode in ["batch move", "single move", "batch set"] {
        let w = stage_fixture();
        let data_source_id = w
            .kernel
            .readers()
            .read_default(|connection| {
                Ok(connection.query_row(
                    "SELECT parent_id FROM pages WHERE block_id = ?1",
                    [STAGE_PAGE],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel);
        for status in ["plan", "doing"] {
            let destination = LibraryPageWriteDestination::DataSource {
                data_source_id: data_source_id.clone(),
                view_id: None,
                group: Some(DatabaseGroupScope::Path {
                    group_key: Some(status.into()),
                    subgroup_key: None,
                }),
                at: None,
            };
            let operation_id = format!("person:{mode}:{status}");
            if mode == "batch set" {
                use nodex_core_contracts::database::*;
                crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
                    .apply(
                        &context(),
                        ModuleApplyRequest {
                            contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                            store_epoch: StoreEpoch("epoch-1".into()),
                            operation_id,
                            intent: vec![DatabaseIntent::SetPageProperties {
                                updates: vec![DatabasePagePropertyUpdate {
                                    page_ids: vec![STAGE_PAGE.into()],
                                    values: vec![LibraryPageCopyValue {
                                        property_id: "Status".into(),
                                        value: serde_json::json!(status),
                                    }],
                                    expected_value_revisions: Default::default(),
                                }],
                                authorization: None,
                            }],
                        },
                    )
                    .unwrap();
            } else {
                let intent = if mode == "batch move" {
                    LibraryIntent::MovePages {
                        page_ids: vec![STAGE_PAGE.into()],
                        destination,
                    }
                } else {
                    LibraryIntent::MovePage {
                        page_id: STAGE_PAGE.into(),
                        destination,
                        expected_etag: None,
                    }
                };
                library
                    .apply(
                        &context(),
                        ModuleApplyRequest {
                            contract_version: LIBRARY_CONTRACT_VERSION,
                            store_epoch: StoreEpoch("epoch-1".into()),
                            operation_id,
                            intent,
                        },
                    )
                    .unwrap();
            }
            assert_eq!(stage(&w), status);
        }
        apply(
            &w.module,
            "report",
            outcome_report(WorkReportOutcome::Ready),
        );
        assert_eq!(stage(&w), "doing");
        assert!(!report_moved(&w), "{mode}");
    }
}

#[test]
fn an_old_chat_reports_evidence_without_moving_the_new_attempt() {
    let w = stage_fixture();
    apply(&w.module, "new", launch("new"));
    apply(
        &w.module,
        "new:handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "new".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    apply(
        &w.module,
        "old:report",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
}
#[test]
fn a_person_or_their_agent_accepts_reviewed_work_and_only_a_person_advances_the_fence() {
    use nodex_core_contracts::AdapterKind;
    let w = stage_fixture();
    apply(&w.module, "ready", outcome_report(WorkReportOutcome::Ready));
    let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = report(None, "Reviewed") else {
        panic!()
    };
    w.module
        .apply(
            &context(),
            request(
                "agent:accept",
                ProjectWorkspaceIntent::AgentCommand {
                    provenance,
                    intent: Box::new(ProjectWorkspaceIntent::AcceptPageWork {
                        expected_turn_episode: None,
                        page_id: STAGE_PAGE.into(),
                    }),
                },
            ),
        )
        .unwrap();
    assert_eq!(stage(&w), "done");
    // The Agent accepted for its Member; like its other Status edits, that is not a person's move.
    let (actor, member) = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok((
                c.query_row("SELECT actor_json FROM mutation_actors WHERE module_name='project_workspace' AND operation_id='agent:accept'", [], |r| r.get::<_, String>(0))?,
                c.query_row("SELECT member_id FROM local_profile_members", [], |r| r.get::<_, String>(0))?,
            ))
        })
        .unwrap();
    let actor: serde_json::Value = serde_json::from_str(&actor).unwrap();
    assert_eq!(actor["type"], "agent");
    assert_eq!(actor["on_behalf_of"], member.as_str());
    assert_eq!(
        w.kernel
            .readers()
            .read_default(|c| crate::database::status_person_revision(c, STAGE_PAGE))
            .unwrap(),
        0
    );
    for adapter in [AdapterKind::ElectronHost, AdapterKind::NativeCli] {
        let w = stage_fixture();
        apply(&w.module, "ready", outcome_report(WorkReportOutcome::Ready));
        let mut person = context();
        person.adapter = adapter;
        w.module
            .apply(
                &person,
                request(
                    "accept",
                    ProjectWorkspaceIntent::AcceptPageWork {
                        expected_turn_episode: None,
                        page_id: STAGE_PAGE.into(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(stage(&w), "done");
        assert_eq!(
            w.kernel
                .readers()
                .read_default(|c| crate::database::status_person_revision(c, STAGE_PAGE))
                .unwrap(),
            1
        );
    }
    for before in ["triage", "plan", "doing", "done", "canceled"] {
        let w = stage_fixture();
        set_stage(&w, "before", before, false);
        apply(
            &w.module,
            "accept",
            ProjectWorkspaceIntent::AcceptPageWork {
                expected_turn_episode: None,
                page_id: STAGE_PAGE.into(),
            },
        );
        assert_eq!(stage(&w), before);
    }
}

#[test]
fn rehanding_an_existing_attempt_cannot_undo_a_newer_person_choice() {
    let w = stage_fixture();
    set_stage(&w, "person:triage", "triage", true);
    set_stage(&w, "person:todo", "plan", true);
    apply(
        &w.module,
        "rehand",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    assert_eq!(stage(&w), "plan");
    let moved=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT status_moved FROM project_session_pages WHERE page_id=?1 AND session_id='work'",[STAGE_PAGE],|r|r.get::<_,bool>(0))?)).unwrap();
    assert!(!moved);
}

#[test]
fn report_keeps_its_fact_when_the_status_source_is_unavailable() {
    let w = stage_fixture();
    w.kernel.writer().call(|c|{c.execute("UPDATE data_sources SET lifecycle='archived' WHERE id=(SELECT parent_id FROM pages WHERE block_id=?1)",[STAGE_PAGE])?;Ok(())}).unwrap();
    apply(
        &w.module,
        "report",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
}

#[test]
fn compound_page_metadata_status_edits_also_fence_work_reports() {
    use nodex_core_contracts::library::*;
    let w = stage_fixture();
    let revision=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT COALESCE((SELECT revision FROM block_properties WHERE block_id=?1 AND property_key='schedule.isAllDay'),0)",[STAGE_PAGE],|r|r.get::<_,i64>(0))?)).unwrap();
    let intent = LibraryIntent::ApplyPageMetadataProperties {
        database_intents: vec![stage_edit(&w, "doing")],
        intrinsic_mutation: Box::new(LibraryBlockPropertyMutation {
            actor: serde_json::json!({"kind":"host"}),
            client_session_id: None,
            fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                block_id: STAGE_PAGE.into(),
                property_key: "schedule.isAllDay".into(),
                expected_revision: revision,
                value: serde_json::json!(false),
            }],
        }),
    };
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel);
    let input = nodex_core_contracts::ModuleApplyRequest {
        contract_version: LIBRARY_CONTRACT_VERSION,
        operation_id: "compound:status".into(),
        store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
        intent,
    };
    library.apply(&context(), input.clone()).unwrap();
    library.apply(&context(), input).unwrap();
    assert_eq!(
        w.kernel
            .readers()
            .read_default(|c| crate::database::status_person_revision(c, STAGE_PAGE))
            .unwrap(),
        1,
        "an exact retry retains its one person edit"
    );
    apply(
        &w.module,
        "ready:after-person",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
}

#[test]
fn only_the_root_agent_reports_work_even_on_a_native_connection() {
    for kind in [
        ProjectWorkspaceAgentRuntimeTurnKind::Run,
        ProjectWorkspaceAgentRuntimeTurnKind::NativeConnection,
    ] {
        let w = stage_fixture();
        let mut child = report(None, "Finished a delegated task.");
        let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = &mut child else {
            unreachable!();
        };
        provenance.authority.thread_id = "thread:child".into();
        provenance.authority.runtime.as_mut().unwrap().turn_kind = kind;
        let error = w
            .module
            .apply(&context(), request("child:report", child))
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
        assert!(error.message.contains("Agent that delegated your task"));
        assert_eq!(stage(&w), "doing");
        assert_eq!(report_outcome(&w), None);

        let mut root = report(None, "Finished the Page's work.");
        let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = &mut root else {
            unreachable!();
        };
        provenance.authority.runtime.as_mut().unwrap().turn_kind = kind;
        apply(&w.module, "root:report", root);
        assert_eq!(stage(&w), "review");
        assert_eq!(report_outcome(&w).as_deref(), Some("ready"));
    }
}

#[test]
fn review_waits_for_a_quiet_tree_and_later_runs_supersede_the_active_claim() {
    use SessionExecutionState as State;
    use TurnReason::*;
    for guard in ["none", "person", "skipped", "older-chat", "unstarted-head"] {
        let w = stage_fixture();
        if guard == "skipped" {
            set_stage(&w, "review:before-report", "review", false);
        }
        let turn = || {
            let ProjectWorkspaceReadValue::PageTurn { turn, .. } = read(
                &w.module,
                ProjectWorkspaceRead::PageTurn {
                    page_id: STAGE_PAGE.into(),
                },
            ) else {
                panic!("Page Turn")
            };
            turn
        };
        let capture = |revision, state, run, started, stopped, terminal| {
            let mut observation: SessionExecutionObservation = serde_json::from_value(serde_json::json!({
                "agent":{"instanceId":"codex","model":"gpt","effort":null},
                "state":state, "runId":run, "runStartedAt":started, "personStopped":stopped,
                "pendingRequestIds":[], "pendingRequests":[], "queue":null, "terminalStatus":terminal,
                "stalled":false, "progressFingerprint":null, "progressSince":0
            }))
            .unwrap();
            if guard == "unstarted-head" && revision == 6 {
                observation.earlier_run_start = Some(SessionExecutionRunStart {
                    run_id: "run:later".into(),
                    started_at: 4_000_000_000_000,
                });
            }
            let intent = ProjectWorkspaceIntent::RecordSessionExecution {
                session_id: "work".into(),
                expected_revision: revision,
                observation,
            };
            apply(&w.module, &format!("capture:{revision}"), intent.clone());
            apply(&w.module, &format!("capture:{revision}"), intent);
        };
        let before_report = 100;
        let after_report = 4_000_000_000_000_i64;
        capture(
            0,
            State::Idle,
            "run:earlier",
            Some(before_report),
            false,
            None,
        );
        apply(
            &w.module,
            "root:report",
            report(None, "Finished the Page's work."),
        );
        assert_eq!(stage(&w), "review");
        assert_eq!(turn().reason, (guard == "skipped").then_some(Review));
        capture(
            1,
            State::Working,
            "run:work",
            Some(after_report),
            false,
            None,
        );
        assert_eq!(turn().reason, Some(Working));
        assert_eq!(
            stage(&w),
            "review",
            "the reporting Run cannot supersede itself"
        );
        capture(
            2,
            State::Unavailable,
            "run:work",
            Some(before_report),
            false,
            None,
        );
        assert_eq!(turn().reason, (guard == "skipped").then_some(Review));
        capture(
            3,
            State::Idle,
            "run:work",
            Some(before_report),
            false,
            Some("completed"),
        );
        assert_eq!(turn().reason, Some(Review));
        capture(
            4,
            State::Unavailable,
            "run:work",
            Some(before_report),
            false,
            Some("completed"),
        );
        assert_eq!(
            turn().reason,
            Some(Review),
            "a disconnected owner keeps its last confirmed quiet Run"
        );
        capture(5, State::Failed, "run:never-started", None, true, None);
        assert_eq!(
            turn().reason,
            Some(Review),
            "stopping before execution retains the claim"
        );

        match guard {
            "person" => {
                set_stage(&w, "person:doing", "doing", true);
                set_stage(&w, "person:review", "review", true);
            }
            "older-chat" => {
                apply(&w.module, "other", launch("other"));
                apply(
                    &w.module,
                    "other:handoff",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "other".into(),
                        intent: ProjectSessionIntent::HandOffPage {
                            page_id: STAGE_PAGE.into(),
                        },
                    },
                );
            }
            _ => {}
        }
        // A short or stopped continuation may already be terminal on the first capture.
        if guard == "unstarted-head" {
            capture(6, State::Failed, "run:never-started", None, true, None);
        } else {
            capture(
                6,
                State::Failed,
                "run:later",
                Some(after_report),
                true,
                None,
            );
        }
        let reopened = matches!(guard, "none" | "unstarted-head");
        assert_eq!(stage(&w), if reopened { "doing" } else { "review" });
        assert_eq!(turn().reason, (!reopened).then_some(Review), "{guard}");
        assert_eq!(report_outcome(&w).is_some(), guard == "older-chat");
        w.kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::store_validation::validate_current_store(connection)
            })
            .expect("a superseded report retains a valid Store for restart");
    }
}

#[test]
fn decision_runs_require_host_authority_and_fresh_projectless_sessions() {
    use nodex_core_contracts::AdapterKind;
    let w = seeded_workspace();
    let person = nodex_core_contracts::BoundModuleContext {
        adapter: AdapterKind::NativeCli,
        ..context()
    };
    let error = w
        .module
        .apply(&person, request("person-launch", decision_launch()))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Unauthorized);
    let mut scoped = decision_launch();
    let ProjectWorkspaceIntent::CreateAgentRuntimeSession { project_id, .. } = &mut scoped else {
        unreachable!()
    };
    *project_id = Some("project:default".into());
    let error = w
        .module
        .apply(&context(), request("scoped-launch", scoped))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::InvalidInput);

    apply(&w.module, "launch-decision", decision_launch());
    let ProjectWorkspaceReadValue::DecisionRun {
        decision_run: Some(run),
        ..
    } = read(
        &w.module,
        ProjectWorkspaceRead::DecisionRun {
            session_id: "nodex".into(),
        },
    )
    else {
        panic!("decision run")
    };
    assert_eq!(
        (run.kind, run.request_id.as_str(), run.generation),
        (NodexDecisionRunKind::Routing, "request", 1)
    );
    let mut replay = decision_launch();
    let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
        session_id,
        runtime_thread_id,
        launch_request_id,
        ..
    } = &mut replay
    else {
        unreachable!()
    };
    *session_id = "another-session".into();
    *runtime_thread_id = "another-thread".into();
    *launch_request_id = "another-launch".into();
    let result = w
        .module
        .apply(&context(), request("replay-decision", replay))
        .unwrap();
    assert_eq!(result.committed.value.affected_session_ids, ["nodex"]);
    let ProjectWorkspaceReadValue::DecisionRun { decision_run, .. } = read(
        &w.module,
        ProjectWorkspaceRead::DecisionRun {
            session_id: "another-session".into(),
        },
    ) else {
        panic!("decision run")
    };
    assert!(decision_run.is_none());

    let mut changed = decision_launch();
    let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
        decision_run: Some(input),
        ..
    } = &mut changed
    else {
        unreachable!()
    };
    input.generation = 2;
    let error = w
        .module
        .apply(&context(), request("rebind-decision", changed))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Conflict);
}

#[test]
fn blocked_and_review_turns_notify_without_additional_input() {
    let w = stage_fixture();
    let check = |reason| {
        let ProjectWorkspaceReadValue::PageTurn { turn, .. } = read(
            &w.module,
            ProjectWorkspaceRead::PageTurn {
                page_id: STAGE_PAGE.into(),
            },
        ) else {
            panic!("Turn")
        };
        assert_eq!(turn.reason, Some(reason));
        let ProjectWorkspaceReadValue::InboxTurnNotifications { intents } =
            read(&w.module, ProjectWorkspaceRead::InboxTurnNotifications)
        else {
            panic!("Turn notifications")
        };
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].episode, turn.episode);
    };
    apply(
        &w.module,
        "blocked",
        outcome_report(WorkReportOutcome::Blocked),
    );
    check(TurnReason::Blocked);
    apply(&w.module, "ready", outcome_report(WorkReportOutcome::Ready));
    apply(&w.module, "quiet", ProjectWorkspaceIntent::RecordSessionExecution {
        session_id: "work".into(), expected_revision: 0,
        observation: serde_json::from_value(serde_json::json!({
            "state":"idle","runId":"run:work","runStartedAt":0,"pendingRequestIds":[],
            "pendingRequests":[],"queue":null,"terminalStatus":"completed","personStopped":false,
            "stalled":false,"progressFingerprint":null,"progressSince":0
        })).unwrap(),
    });
    check(TurnReason::Review);
}
