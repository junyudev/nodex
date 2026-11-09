//! Automation authority is checked inside the writer before receipt replay. An Agent
//! proposes edits for the Owner to apply, including through the attributed CLI.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::automation::{Automation, AutomationIntent, AutomationMode};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension};

pub(super) fn admit_read(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::Agent | AdapterKind::ElectronHost | AdapterKind::Test
    ) || provenance.profile_id != context.profile_id.0
    {
        return Err(denied(
            "Agent Automation request does not match the current Profile",
        ));
    }
    crate::workspace::validate_persisted_turn_authority(connection, library_id, provenance)?;
    Ok(())
}
fn actor(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
) -> Result<String, StoreError> {
    crate::library::members::requester_owner(connection, library, context)
}
pub(super) fn default_owner(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    request: &AutomationIntent,
) -> Result<String, StoreError> {
    if let AutomationIntent::AgentCommand { provenance, .. } = request {
        let session = match &provenance.authority.runtime {
            Some(runtime) => Some(runtime.session_id.clone()),
            None => connection
                .query_row(
                    "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                    [&provenance.authority.root_thread_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?,
        };
        if let Some(session) = session
            && let Some(owner) =
                crate::library::members::requester_owner_for_session(connection, library, &session)?
        {
            return Ok(owner);
        }
    }
    actor(connection, library, context)
}
pub(super) fn input_owner(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    requested: Option<&str>,
    current: Option<&Automation>,
) -> Result<String, StoreError> {
    let owner = requested
        .map(str::to_owned)
        .or_else(|| current.map(|r| r.owner_member_id.clone()))
        .unwrap_or(actor(connection, library, context)?);
    if !crate::library::members::is_active(connection, library, &owner)? {
        return Err(denied(
            "An Automation Owner must be an active Member of this Space",
        ));
    }
    Ok(owner)
}
pub(super) fn admit<'a>(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    request: &'a AutomationIntent,
) -> Result<&'a AutomationIntent, StoreError> {
    let (intent, enveloped) = match request {
        AutomationIntent::AgentCommand { provenance, intent } => {
            admit_read(connection, library, context, provenance)?;
            (intent.as_ref(), true)
        }
        intent => (intent, false),
    };
    if matches!(intent, AutomationIntent::AgentCommand { .. }) {
        return Err(denied("Agent command envelopes cannot be nested"));
    }
    if context.adapter == AdapterKind::Agent && !enveloped {
        return Err(denied(
            "Agent Automation commands require execution provenance",
        ));
    }
    let agent =
        enveloped || context.adapter == AdapterKind::Agent || context.agent_attribution.is_some();
    let person = default_owner(connection, library, context, request)?;
    let (current, input) = match intent {
        AutomationIntent::CreateAutomation { automation, .. } => (None, Some(automation)),
        AutomationIntent::UpdateAutomation {
            automation_id,
            automation,
            ..
        } => (
            super::read::read_definition(connection, automation_id)?,
            Some(automation),
        ),
        AutomationIntent::DeleteAutomation { automation_id, .. }
        | AutomationIntent::SetAutomationStatus { automation_id, .. }
        | AutomationIntent::DispatchNow { automation_id } => (
            super::read::read_definition(connection, automation_id)?,
            None,
        ),
        _ => return Ok(intent),
    };
    if agent && !matches!(intent, AutomationIntent::CreateAutomation { .. }) {
        return Err(denied(
            "An Agent may propose Automation edits for the Owner to apply",
        ));
    }
    let current_mode = current.as_ref().map(|r| r.mode);
    let proposed_mode = input
        .and_then(|r| r.mode)
        .or(current_mode)
        .unwrap_or(if agent {
            AutomationMode::AskFirst
        } else {
            AutomationMode::Run
        });
    let changes_mode = current_mode.is_some_and(|mode| mode != proposed_mode);
    if agent && matches!(intent, AutomationIntent::DispatchNow { .. }) {
        return Err(denied(
            "Only the Automation Owner can run this Automation now",
        ));
    }
    let protected = current_mode == Some(AutomationMode::Run)
        || proposed_mode == AutomationMode::Run
        || changes_mode;
    if agent && protected {
        return Err(denied(
            "Only the Automation Owner can change its mode or edit an Automation set to Run. Suggest the change for the Owner to apply.",
        ));
    }
    let owner = current
        .as_ref()
        .map(|r| r.owner_member_id.as_str())
        .or_else(|| input.and_then(|r| r.owner_member_id.as_deref()))
        .unwrap_or(&person);
    if (protected || matches!(intent, AutomationIntent::DispatchNow { .. })) && owner != person {
        return Err(denied(
            "Only this Automation's Owner can change its mode or edit it in Run",
        ));
    }
    if proposed_mode == AutomationMode::Run
        && input
            .and_then(|r| r.owner_member_id.as_deref())
            .is_some_and(|next| next != owner)
    {
        return Err(denied(
            "A transferred Automation must wait for its new Owner before using Run",
        ));
    }
    if input
        .and_then(|r| r.owner_member_id.as_deref())
        .is_some_and(|next| next != owner)
        && (agent || person != owner)
    {
        return Err(denied(
            "Only the current Automation Owner can transfer ownership",
        ));
    }
    // Agent automation definitions may be scoped anywhere in the authenticated Space,
    // but cannot choose a different authorizing person.
    if agent
        && input
            .and_then(|r| r.owner_member_id.as_deref())
            .is_some_and(|owner| owner != person)
    {
        return Err(denied(
            "Suggest an Automation ownership change for its Owner",
        ));
    }
    if !crate::library::members::is_active(connection, library, owner)? {
        return Err(denied("This Automation's Owner is unavailable"));
    }
    Ok(intent)
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::automation::{AutomationInput, AutomationStatus};
    use nodex_core_contracts::{BoundAgentAttribution, LibraryId, ProfileId, RemotePrincipal};
    fn fixture() -> (Connection, BoundModuleContext, String) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::infrastructure::schema::CURRENT_SCHEMA_SQL)
            .unwrap();
        c.execute_batch("INSERT INTO profiles VALUES('profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at,space_kind) VALUES('library','profile','today','today','team'); INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('other','library','Other Owner','active','owner');").unwrap();
        let owner: String = c
            .query_row("SELECT member_id FROM local_profile_members", [], |r| {
                r.get(0)
            })
            .unwrap();
        c.execute("INSERT INTO automations(automation_id,owner_member_id,condition_text,timezone,jitter_salt,kind,status,name,prompt,rrule,model,cwds_json,execution_environment,created_at,updated_at,mode) VALUES('auto',?1,'Clock','UTC','salt','cron','ACTIVE','Automation','Saved action','FREQ=MINUTELY;INTERVAL=5','model','[]','local',1,1,'run')",[&owner]).unwrap();
        c.execute("INSERT INTO automations(automation_id,owner_member_id,condition_text,timezone,jitter_salt,kind,status,name,prompt,rrule,model,cwds_json,execution_environment,created_at,updated_at,mode) VALUES('ask',?1,'Clock','UTC','salt','cron','ACTIVE','Automation','Saved action','FREQ=MINUTELY;INTERVAL=5','model','[]','local',1,1,'ask_first')",[&owner]).unwrap();
        let context = BoundModuleContext {
            actor: nodex_core_contracts::Actor::Service {
                kind: nodex_core_contracts::ServiceKind::Maintenance,
            },
            authorizing_member_id: None,
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("library".into()),
            project_id: None,
            connection_id: "test".into(),
            adapter: AdapterKind::NativeCli,
            principal: None,
            editor_history_owner: None,
            agent_attribution: None,
        };
        (c, context, owner)
    }
    fn input() -> AutomationInput {
        serde_json::from_value(serde_json::json!({"kind":"cron","name":"Automation","prompt":"Changed action","rrule":"FREQ=MINUTELY;INTERVAL=5"})).unwrap()
    }
    fn update(id: &str, automation: AutomationInput) -> AutomationIntent {
        AutomationIntent::UpdateAutomation {
            automation_id: id.into(),
            expected_revision: 1,
            status: AutomationStatus::Active,
            automation,
        }
    }
    #[test]
    fn an_attributed_cli_agent_cannot_edit_existing_auto_or_create_auto() {
        let (c, mut context, _) = fixture();
        context.agent_attribution = Some(BoundAgentAttribution {
            run_id: None,
            session_id: "managed".into(),
            backend: nodex_core_contracts::agent::AgentBackendKind::Codex,
        });
        assert_eq!(
            admit(&c, "library", &context, &update("auto", input()))
                .unwrap_err()
                .code,
            StoreErrorCode::Unauthorized
        );
        let mut automation = input();
        automation.mode = Some(AutomationMode::Run);
        assert_eq!(
            admit(
                &c,
                "library",
                &context,
                &AutomationIntent::CreateAutomation {
                    automation_id: "new".into(),
                    automation
                }
            )
            .unwrap_err()
            .code,
            StoreErrorCode::Unauthorized
        );
        for mode in ["ask_first", "dry_run"] {
            c.execute(
                "UPDATE automations SET mode=?1 WHERE automation_id='ask'",
                [mode],
            )
            .unwrap();
            for intent in [
                update("ask", input()),
                AutomationIntent::DeleteAutomation {
                    automation_id: "ask".into(),
                    expected_revision: 1,
                },
                AutomationIntent::SetAutomationStatus {
                    automation_id: "ask".into(),
                    expected_revision: 1,
                    status: AutomationStatus::Paused,
                },
            ] {
                assert_eq!(
                    admit(&c, "library", &context, &intent).unwrap_err().code,
                    StoreErrorCode::Unauthorized
                );
            }
        }
        for mode in [AutomationMode::AskFirst, AutomationMode::DryRun] {
            let mut automation = input();
            automation.mode = Some(mode);
            assert!(
                admit(
                    &c,
                    "library",
                    &context,
                    &AutomationIntent::CreateAutomation {
                        automation_id: "proposed".into(),
                        automation
                    }
                )
                .is_ok()
            );
        }
        assert_eq!(
            admit(
                &c,
                "library",
                &context,
                &AutomationIntent::DispatchNow {
                    automation_id: "ask".into()
                }
            )
            .unwrap_err()
            .code,
            StoreErrorCode::Unauthorized
        );
    }
    #[test]
    fn only_the_exact_automation_owner_changes_modes_or_auto_even_for_another_space_owner() {
        let (c, mut context, _) = fixture();
        context.adapter = AdapterKind::RemoteMember;
        context.principal = Some(RemotePrincipal {
            space_id: "library".into(),
            member_id: "other".into(),
            device_id: "device".into(),
            session_id: "session".into(),
            role: nodex_core_contracts::library::MemberRole::Owner,
        });
        for mode in ["ask_first", "dry_run"] {
            c.execute(
                "UPDATE automations SET mode=?1 WHERE automation_id='ask'",
                [mode],
            )
            .unwrap();
            for intent in [
                update("ask", input()),
                AutomationIntent::DeleteAutomation {
                    automation_id: "ask".into(),
                    expected_revision: 1,
                },
                AutomationIntent::SetAutomationStatus {
                    automation_id: "ask".into(),
                    expected_revision: 1,
                    status: AutomationStatus::Paused,
                },
            ] {
                assert!(admit(&c, "library", &context, &intent).is_ok());
            }
        }
        c.execute(
            "UPDATE automations SET mode='ask_first' WHERE automation_id='ask'",
            [],
        )
        .unwrap();
        assert_eq!(
            admit(&c, "library", &context, &update("auto", input()))
                .unwrap_err()
                .code,
            StoreErrorCode::Unauthorized
        );
        let mut automation = input();
        automation.mode = Some(AutomationMode::DryRun);
        assert_eq!(
            admit(&c, "library", &context, &update("ask", automation))
                .unwrap_err()
                .code,
            StoreErrorCode::Unauthorized
        );
        assert_eq!(
            admit(
                &c,
                "library",
                &context,
                &AutomationIntent::DispatchNow {
                    automation_id: "ask".into()
                }
            )
            .unwrap_err()
            .code,
            StoreErrorCode::Unauthorized
        );
    }
    #[test]
    fn transferring_an_automation_revokes_auto_until_the_new_owner_grants_it() {
        let (c, context, _) = fixture();
        let mut automation = input();
        automation.owner_member_id = Some("other".into());
        assert_eq!(
            admit(&c, "library", &context, &update("auto", automation.clone()))
                .unwrap_err()
                .code,
            StoreErrorCode::Unauthorized
        );
        automation.mode = Some(AutomationMode::AskFirst);
        assert!(admit(&c, "library", &context, &update("auto", automation)).is_ok());
    }
    #[test]
    fn removing_the_owner_retires_automations_and_cancels_unstarted_authority_atomically() {
        let (c, context, owner) = fixture();
        c.execute_batch("INSERT INTO automation_execution_leases(lease_id,automation_id,dispatch_id,automation_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,purpose) VALUES('lease','auto','dispatch',1,1000,1,'claimed',1,9999999999999,'run'); INSERT INTO automation_decisions(dispatch_id,automation_id,status,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms,mode,actor_json) VALUES('dispatch','auto','admitted',1000,1000,'{}',1,1,'run',json_object('type','service','kind','automations'));").unwrap();
        c.execute_batch("INSERT INTO automation_decisions(dispatch_id,automation_id,status,waiting_in_inbox,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms,mode,actor_json) VALUES('failed-waiting','auto','failed',1,2000,2000,'{}',2,2,'ask_first',json_object('type','service','kind','automations')),('failed-history','auto','failed',0,500,500,'{}',1,1,'run',json_object('type','service','kind','automations'));").unwrap();
        c.execute(
            "UPDATE members SET lifecycle='removed' WHERE id=?1",
            [owner],
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT status FROM automations WHERE automation_id='auto'",
                [],
                |r| { r.get::<_, String>(0) }
            )
            .unwrap(),
            "DELETED"
        );
        assert_eq!(
            c.query_row(
                "SELECT status FROM automation_execution_leases WHERE lease_id='lease'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "cancelled"
        );
        assert_eq!(
            c.query_row(
                "SELECT status FROM automation_decisions WHERE dispatch_id='dispatch'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "withdrawn"
        );
        assert_eq!(c.query_row("SELECT status,waiting_in_inbox FROM automation_decisions WHERE dispatch_id='failed-waiting'", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?))).unwrap(),("withdrawn".into(),false));
        assert_eq!(
            c.query_row(
                "SELECT status FROM automation_decisions WHERE dispatch_id='failed-history'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "failed"
        );
        assert_eq!(
            admit(&c, "library", &context, &update("auto", input()))
                .unwrap_err()
                .code,
            StoreErrorCode::Unauthorized
        );
    }
}
