//! Identity is derived from authenticated bindings, never command-authored actor JSON.
use super::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    Actor, AdapterKind, BoundAgentAttribution, BoundModuleContext, RemotePrincipal, ServiceKind,
    agent::AgentTurnProvenance,
};
use rusqlite::{Connection, OptionalExtension, params};

fn denied() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "A current Member or verified Agent identity is required",
        false,
    )
}

pub(crate) fn local_member(c: &Connection, library: &str) -> Result<String, StoreError> {
    c.query_row("SELECT m.id FROM local_profile_members local JOIN members m ON m.id=local.member_id AND m.library_id=local.library_id WHERE local.library_id=?1 AND m.lifecycle='active'", [library], |r|r.get(0)).optional()?.ok_or_else(denied)
}

pub(crate) fn derive(
    c: &Connection,
    library: &str,
    adapter: &AdapterKind,
    principal: Option<&RemotePrincipal>,
    attribution: Option<&BoundAgentAttribution>,
) -> Result<Actor, StoreError> {
    if *adapter == AdapterKind::RemoteMember {
        let p = principal
            .filter(|p| p.space_id == library)
            .ok_or_else(denied)?;
        if attribution.is_some() || !crate::library::members::is_active(c, library, &p.member_id)? {
            return Err(denied());
        }
        return Ok(Actor::Member {
            member_id: p.member_id.clone(),
        });
    }
    if let Some(a) = attribution {
        return for_session(c, library, &a.session_id, a.run_id.clone());
    }
    if *adapter == AdapterKind::Agent {
        return Err(denied());
    }
    Ok(Actor::Member {
        member_id: local_member(c, library)?,
    })
}

pub(crate) fn bind(
    c: &Connection,
    context: &BoundModuleContext,
) -> Result<BoundModuleContext, StoreError> {
    super::member_admission::require_current(c, context)?;
    Ok(BoundModuleContext {
        actor: derive(
            c,
            &context.library_id.0,
            &context.adapter,
            context.principal.as_ref(),
            context.agent_attribution.as_ref(),
        )?,
        authorizing_member_id: None,
        ..context.clone()
    })
}

pub(crate) fn requesting_member(
    c: &Connection,
    context: &BoundModuleContext,
) -> Result<String, StoreError> {
    if let Some(p) = &context.principal {
        super::member_admission::require_current(c, context)?;
        return Ok(p.member_id.clone());
    }
    if let Some(member) = context.actor.member_id() {
        return Ok(member.to_owned());
    }
    local_member(c, &context.library_id.0)
}

/// Turn preparation captures a Run's requester from its accepted input. Later messages
/// cannot redirect that Run's questions to a different Member.
pub(crate) fn session_requester(
    c: &Connection,
    session: &str,
    run: Option<&str>,
) -> Result<Option<String>, StoreError> {
    c.query_row(
        "SELECT COALESCE((SELECT member_id FROM session_run_members WHERE session_id=?1 AND run_id=?2),(SELECT member_id FROM session_requesting_members WHERE session_id=?1 ORDER BY accepted_at DESC,message_id DESC LIMIT 1))",
        params![session, run],
        |r| r.get(0),
    ).map_err(Into::into)
}

pub(crate) fn for_session(
    c: &Connection,
    library: &str,
    session: &str,
    run_id: Option<String>,
) -> Result<Actor, StoreError> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM project_sessions session WHERE session.id=?1 AND session.archived=0 AND (session.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=session.project_id AND p.library_id=?2)))",params![session,library],|r|r.get(0))?;
    if !exists {
        return Err(denied());
    }
    let requesting:Option<String>=c.query_row("SELECT member_id FROM session_requesting_members WHERE session_id=?1 ORDER BY accepted_at DESC,message_id DESC LIMIT 1",[session],|r|r.get(0)).optional()?;
    let owner = crate::library::members::requester_owner_for_session(c, library, session)?;
    let captured = run_id
        .as_deref()
        .map(|run| {
            c.query_row(
                "SELECT member_id FROM session_run_members WHERE session_id=?1 AND run_id=?2",
                params![session, run],
                |r| r.get::<_, String>(0),
            )
            .optional()
        })
        .transpose()?
        .flatten();
    let member = match captured.or(owner).or(requesting) {
        Some(member) => member,
        None => {
            let personal: bool = c.query_row(
                "SELECT space_kind='personal' FROM libraries WHERE id=?1",
                [library],
                |r| r.get(0),
            )?;
            if !personal {
                return Err(denied());
            }
            local_member(c, library)?
        }
    };
    if !crate::library::members::is_active(c, library, &member)? {
        return Err(denied());
    }
    Ok(Actor::Agent {
        session_id: session.to_owned(),
        run_id,
        on_behalf_of: member,
    })
}

/// The product Session a verified Turn belongs to.
pub(crate) fn turn_session(
    c: &Connection,
    provenance: &AgentTurnProvenance,
) -> Result<String, StoreError> {
    match &provenance.authority.runtime {
        Some(runtime) => Ok(runtime.session_id.clone()),
        None => c
            .query_row(
                "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                [&provenance.authority.root_thread_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(denied),
    }
}

/// Whether the Space is personal: its one Member is everyone who reads shared state.
pub(crate) fn is_personal(c: &Connection, library: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND space_kind='personal')",
        [library],
        |r| r.get(0),
    )?)
}

/// Whether a Session is the Space's Coordinator, which people know as Nodex.
pub(crate) fn is_coordinator(c: &Connection, session: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM coordinator WHERE session_id=?1)",
        [session],
        |r| r.get(0),
    )?)
}

/// The active Member whose standing consent lets this Page start on its own.
pub(crate) fn work_grant(c: &Connection, page_id: &str) -> Result<Option<String>, StoreError> {
    Ok(c.query_row("SELECT grant.member_id FROM page_work_grants grant JOIN members member ON member.id=grant.member_id AND member.lifecycle='active' WHERE grant.page_id=?1",[page_id],|r|r.get(0)).optional()?)
}

/// Called only after the owning Module verifies this Turn's execution authority.
pub(crate) fn verified_turn(
    c: &Connection,
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<BoundModuleContext, StoreError> {
    if provenance.profile_id != context.profile_id.0
        || provenance.authority.library_id != context.library_id.0
    {
        return Err(denied());
    }
    let session = turn_session(c, provenance)?;
    let actor = for_session(
        c,
        &context.library_id.0,
        &session,
        Some(provenance.authority.turn_id.clone()),
    )?;
    Ok(BoundModuleContext {
        actor,
        authorizing_member_id: None,
        ..context.clone()
    })
}

pub(crate) fn service(
    context: &BoundModuleContext,
    kind: ServiceKind,
    authorizing_member_id: Option<String>,
) -> BoundModuleContext {
    BoundModuleContext {
        actor: Actor::Service { kind },
        authorizing_member_id,
        ..context.clone()
    }
}

pub(crate) fn workspace(
    c: &Connection,
    context: &BoundModuleContext,
    intent: &nodex_core_contracts::workspace::ProjectWorkspaceIntent,
) -> Result<BoundModuleContext, StoreError> {
    use nodex_core_contracts::sources::SourceCommand as S;
    use nodex_core_contracts::workspace::ProjectWorkspaceIntent as W;
    if let W::AgentCommand { provenance, intent } = intent {
        let target=match intent.as_ref() {
            W::WriteTurnNote {page_id,..}=>c.query_row("SELECT json_extract(signature,'$[0].member_id') FROM page_turn_episodes WHERE page_id=?1",[page_id],|r|r.get::<_,Option<String>>(0)).optional()?.flatten().map(|member|(member,None)),
            W::AnswerInboxQuestion {question_page_id,..}=>c.query_row("SELECT author_member_id FROM inbox_entries WHERE page_id=?1",[question_page_id],|r|r.get::<_,Option<String>>(0)).optional()?.flatten().map(|member|(member,None)),
            // Nodex starting a Page set to Start automatically acts on that Member's standing
            // consent; any other start acts for the Member whose request it is handling.
            W::StartPageWork { page_id, .. } if is_coordinator(c, &turn_session(c, provenance)?)? => {
                work_grant(c, page_id)?.map(|grant| (grant.clone(), Some(grant)))
            }
            _=>None,
        };
        if let Some((member, authorizing_member_id)) = target {
            if !crate::library::members::is_active(c, &context.library_id.0, &member)? {
                return Err(denied());
            }
            return Ok(BoundModuleContext {
                actor: Actor::Agent {
                    session_id: turn_session(c, provenance)?,
                    run_id: Some(provenance.authority.turn_id.clone()),
                    on_behalf_of: member,
                },
                authorizing_member_id,
                ..context.clone()
            });
        }
        return verified_turn(c, context, provenance);
    }
    let context = bind(c, context)?;
    if let W::CreateAgentRuntimeSession {
        coordinator: true,
        session_id,
        ..
    } = intent
        && matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        )
        && !c.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_sessions WHERE id=?1)",
            [session_id],
            |r| r.get::<_, bool>(0),
        )?
    {
        // Bootstrap is a producer action authorized by Core's local operator;
        // retain that grant separately from the Service's authorship.
        let member = context.actor.member_id().map(str::to_owned);
        return Ok(service(&context, ServiceKind::AgentRuntime, member));
    }
    if let W::ConfirmInboxDispatch {
        confirmed_by: nodex_core_contracts::inbox::InboxConfirmedBy::Nodex,
        proposal_id,
        ..
    } = intent
    {
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) {
            return Err(denied());
        }
        let members=c.prepare("SELECT DISTINCT author_member_id FROM inbox_proposal_pages link JOIN inbox_entries entry ON entry.page_id=link.page_id WHERE link.proposal_id=?1")?.query_map([proposal_id],|r|r.get::<_,Option<String>>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let [Some(member)] = members.as_slice() else {
            return Err(denied());
        };
        let allowed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM member_inbox_preferences WHERE member_id=?1 AND start_my_requests=1)",[member],|r|r.get(0))?;
        if !allowed || !crate::library::members::is_active(c, &context.library_id.0, member)? {
            return Err(denied());
        }
        return Ok(service(
            &context,
            ServiceKind::InboxRouting,
            Some(member.clone()),
        ));
    }
    if let W::StartPageWork {
        page_id,
        expected_readiness_epoch: Some(_),
        ..
    } = intent
        && matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        )
    {
        let grant = work_grant(c, page_id)?.ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Conflict,
                "Automatic work requires a current Member grant",
                true,
            )
        })?;
        return Ok(service(&context, ServiceKind::Scheduler, Some(grant)));
    }
    let kind = match intent {
        W::Source {
            command:
                S::ConfigureSource { .. }
                | S::ReplyToOrigin { .. }
                | S::RetryProblem { .. }
                | S::FollowThread { .. },
        } => None,
        W::Source { .. } => Some(ServiceKind::Sources),
        W::AutomationAssessment { .. }
        | W::HoldAutomationDecision { .. }
        | W::RefreshAutomationDecision { .. } => Some(ServiceKind::Automations),
        W::CreateAgentRuntimeSession { session_id, .. }
            if c.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_sessions WHERE id=?1)",
                [session_id],
                |r| r.get::<_, bool>(0),
            )? =>
        {
            Some(ServiceKind::AgentRuntime)
        }
        W::BindCoordinator { .. }
        | W::UnbindCoordinator { .. }
        | W::RecordSessionExecution { .. }
        | W::RecordWorkEvents { .. }
        | W::RecordSessionActivity { .. }
        | W::SettlePageWorkLaunch { .. }
        | W::RecordChatDelivery { .. }
        | W::BindChatInbound { .. }
        | W::ObserveAppServerThreadWindow { .. }
        | W::ReconcileAppServerThreadSweep { .. }
        | W::ObserveCodexThreadMetadata { .. }
        | W::ObserveSubagentDiscoveryPage { .. }
        | W::ObserveSubagentStatusEvidence { .. }
        | W::BufferSubagentStatusEvidence { .. }
        | W::AdmitTurnAuthority { .. }
        | W::AcknowledgeAgentRuntimeExecutionCleanup { .. }
        | W::UpsertBackgroundProcess { .. }
        | W::BindThreadBackendSession { .. }
        | W::ClearThreadBackendSession { .. } => Some(ServiceKind::AgentRuntime),
        W::BeginInboxRouting { .. }
        | W::RecordInboxRoutingRefusal { .. }
        | W::StartInboxRoutingRun { .. }
        | W::PrepareInboxSuggestions { .. }
        | W::SettleInboxSuggestion { .. }
        | W::BeginInboxDispatch { .. }
        | W::CompleteInboxDispatch { .. }
        | W::FailInboxDispatch { .. }
        | W::RecordInboxSuggestionFailure { .. }
        | W::CreateEventBatch { .. }
        | W::DiscardEventBatch { .. }
        | W::SettleEventBatch { .. } => Some(ServiceKind::InboxRouting),
        W::ClaimTurnNotification { .. } | W::ClaimInboxLaterNotification { .. } => {
            Some(ServiceKind::Notifications)
        }
        W::PublishDueInboxLater { .. } => Some(ServiceKind::Scheduler),
        W::StartPageWork {
            expected_readiness_epoch: Some(_),
            ..
        } => Some(ServiceKind::Scheduler),
        _ => None,
    };
    let kind = kind.filter(|_| {
        matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        )
    });
    Ok(kind.map_or_else(|| context.clone(), |kind| service(&context, kind, None)))
}

pub(crate) fn automation(
    c: &Connection,
    context: &BoundModuleContext,
    intent: &nodex_core_contracts::automation::AutomationIntent,
) -> Result<BoundModuleContext, StoreError> {
    use nodex_core_contracts::automation::AutomationIntent as A;
    if let A::AgentCommand { provenance, .. } = intent {
        return verified_turn(c, context, provenance);
    }
    let context = bind(c, context)?;
    let producer = matches!(
        intent,
        A::ClaimDue { .. }
            | A::CompleteLease { .. }
            | A::FailLease { .. }
            | A::BeginRun { .. }
            | A::BindRunSession { .. }
            | A::SetRunSessionTitle { .. }
            | A::CompleteRunForReview { .. }
            | A::SetRunInboxItem { .. }
            | A::SettleInterruptedRuns
            | A::ClaimDueReminders { .. }
            | A::CompleteReminderLease { .. }
            | A::FailReminderLease { .. }
            | A::RescheduleAutomation { .. }
    );
    if !producer {
        return Ok(context);
    }
    let encoded = serde_json::to_value(intent).map_err(|_| denied())?;
    let dispatch = encoded.get("dispatch_id").and_then(|v| v.as_str());
    let authorizing_member_id=dispatch.map(|dispatch|c.query_row("SELECT COALESCE(json_extract(decision.frozen_authority_json,'$.owner_member_id'),automation.owner_member_id) FROM automation_decisions decision JOIN automations automation USING(automation_id) WHERE decision.dispatch_id=?1",[dispatch],|r|r.get::<_,String>(0)).optional()).transpose()?.flatten();
    Ok(service(
        &context,
        ServiceKind::Automations,
        authorizing_member_id,
    ))
}

pub(crate) fn encode(actor: &Actor) -> Result<String, StoreError> {
    if actor.member_id().is_some_and(str::is_empty)
        || matches!(actor, Actor::Agent { session_id, run_id, .. } if session_id.is_empty() || run_id.as_ref().is_some_and(String::is_empty))
    {
        return Err(denied());
    }
    serde_json::to_string(actor).map_err(|_| denied())
}

/// How `viewer` reads a Member: "You" for themselves, otherwise that Member's name.
pub(crate) fn member_label(
    c: &Connection,
    member: &str,
    viewer: &str,
) -> Result<String, StoreError> {
    if member == viewer {
        return Ok("You".into());
    }
    Ok(c.query_row(
        "SELECT display_name FROM members WHERE id=?1",
        [member],
        |r| r.get(0),
    )?)
}

/// The possessive `viewer` reads for a Member: "your" for themselves, otherwise "Alice’s".
pub(crate) fn member_possessive(
    c: &Connection,
    member: &str,
    viewer: &str,
) -> Result<String, StoreError> {
    if member == viewer {
        return Ok("your".into());
    }
    Ok(format!("{}’s", member_label(c, member, viewer)?))
}

pub(crate) fn label(c: &Connection, actor: &Actor, viewer: &str) -> Result<String, StoreError> {
    let member = |id: &str| member_label(c, id, viewer);
    match actor {
        Actor::Member { member_id } => member(member_id),
        Actor::Agent {
            session_id,
            run_id,
            on_behalf_of,
        } => {
            if is_coordinator(c, session_id)? {
                return Ok(format!("Nodex on behalf of {}", member(on_behalf_of)?));
            }
            let recorded:Option<String>=c.query_row("SELECT label FROM agent_actor_labels WHERE session_id=?1 AND run_key IN (?2,'') ORDER BY run_key=?2 DESC LIMIT 1",params![session_id,run_id.as_deref().unwrap_or_default()],|r|r.get(0)).optional()?;
            if let Some(name) = recorded {
                return Ok(format!("{name} on behalf of {}", member(on_behalf_of)?));
            }
            let backend:Option<String>=c.query_row("SELECT thread.agent_backend_kind FROM project_sessions session LEFT JOIN project_session_threads link ON link.session_id=session.id LEFT JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE session.id=?1",[session_id],|r|r.get(0)).optional()?.flatten();
            let name = match backend.as_deref() {
                Some("codex") => "Codex",
                Some("claude") => "Claude",
                Some("opencode") => "OpenCode",
                _ => "Agent",
            };
            Ok(format!("{name} on behalf of {}", member(on_behalf_of)?))
        }
        // Nodex names its own services as the chat names their messages: starting work a person
        // let start on its own and routing the Inbox are Nodex acting, not a separate actor.
        Actor::Service { kind } => Ok(match kind {
            ServiceKind::Sources => "GitHub",
            ServiceKind::Automations => "Automations",
            ServiceKind::Scheduler | ServiceKind::InboxRouting => "Nodex",
            ServiceKind::AgentRuntime => "Agent Runtime",
            ServiceKind::Maintenance => "Maintenance",
            ServiceKind::Notifications => "Notifications",
            ServiceKind::Membership => "Membership",
        }
        .into()),
    }
}

#[cfg(test)]
pub(crate) fn seed_agent_session(c: &Connection, thread: &str) -> Result<(), StoreError> {
    let session = format!("session:{thread}");
    c.execute("INSERT OR IGNORE INTO project_sessions(id,project_id,no_thread_fallback_title,created_at,updated_at,activity_at) SELECT ?1,project_id,'Agent test',linked_at,linked_at,CAST(round(unixepoch(linked_at,'subsec')*1000) AS INTEGER) FROM codex_threads WHERE thread_id=?2",params![session,thread])?;
    c.execute("INSERT OR IGNORE INTO project_session_threads(session_id,thread_id,linked_at) SELECT ?1,thread_id,linked_at FROM codex_threads WHERE thread_id=?2",params![session,thread])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::{
        LibraryId, ProfileId, agent::AgentBackendKind, library::MemberRole,
    };

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../schema/current.sql"))
            .unwrap();
        c.execute_batch("INSERT INTO profiles VALUES('profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('space','profile','today','today'); UPDATE libraries SET space_kind='team'; INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('alice','space','Alice','active','member'); INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at) VALUES('chat','Work','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',1793491200000);").unwrap();
        c
    }
    #[test]
    fn actors_follow_authenticated_callers_and_fail_without_identity() {
        let c = fixture();
        let local = local_member(&c, "space").unwrap();
        for adapter in [
            AdapterKind::ElectronHost,
            AdapterKind::NativeCli,
            AdapterKind::LoopbackHttp,
        ] {
            assert_eq!(
                derive(&c, "space", &adapter, None, None).unwrap(),
                Actor::Member {
                    member_id: local.clone()
                }
            );
        }
        let p = RemotePrincipal {
            space_id: "space".into(),
            member_id: "alice".into(),
            device_id: "device".into(),
            session_id: "token".into(),
            role: MemberRole::Member,
        };
        assert_eq!(
            derive(&c, "space", &AdapterKind::RemoteMember, Some(&p), None).unwrap(),
            Actor::Member {
                member_id: "alice".into()
            }
        );
        assert!(derive(&c, "space", &AdapterKind::RemoteMember, None, None).is_err());
        assert!(derive(&c, "space", &AdapterKind::Agent, None, None).is_err());
        c.execute_batch("DELETE FROM members WHERE id='alice'; UPDATE libraries SET space_kind='personal' WHERE id='space'").unwrap();
        let verified = BoundAgentAttribution {
            session_id: "chat".into(),
            run_id: Some("run".into()),
            backend: AgentBackendKind::Codex,
        };
        assert_eq!(
            derive(&c, "space", &AdapterKind::NativeCli, None, Some(&verified)).unwrap(),
            Actor::Agent {
                session_id: "chat".into(),
                run_id: Some("run".into()),
                on_behalf_of: local.clone()
            }
        );
        c.execute_batch("UPDATE libraries SET space_kind='team' WHERE id='space'; INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('alice','space','Alice','active','member')").unwrap();
        assert!(derive(&c, "space", &AdapterKind::NativeCli, None, Some(&verified)).is_err());
        c.execute(
            "INSERT INTO session_requesting_members VALUES('chat','message','alice','today')",
            [],
        )
        .unwrap();
        assert!(
            matches!(derive(&c,"space",&AdapterKind::Agent,None,Some(&verified)).unwrap(),Actor::Agent {on_behalf_of,..} if on_behalf_of=="alice")
        );
        c.execute(
            "INSERT INTO session_run_members(session_id,run_id,member_id) VALUES('chat','run','alice')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO session_requesting_members VALUES('chat','later',?1,'tomorrow')",
            [&local],
        )
        .unwrap();
        assert!(
            matches!(derive(&c,"space",&AdapterKind::Agent,None,Some(&verified)).unwrap(),Actor::Agent {on_behalf_of,..} if on_behalf_of=="alice")
        );
        c.execute("DELETE FROM local_profile_members", []).unwrap();
        assert!(derive(&c, "space", &AdapterKind::NativeCli, None, None).is_err());
        c.execute(
            "UPDATE members SET lifecycle='removed' WHERE id='alice'",
            [],
        )
        .unwrap();
        assert!(derive(&c, "space", &AdapterKind::RemoteMember, Some(&p), None).is_err());
    }
    #[test]
    fn activity_and_history_labels_name_the_person_and_delegation() {
        let c = fixture();
        let local = local_member(&c, "space").unwrap();
        c.execute(
            "INSERT INTO agent_actor_labels VALUES('chat','run','Codex')",
            [],
        )
        .unwrap();
        for (actor, expected) in [
            (
                Actor::Member {
                    member_id: local.clone(),
                },
                "You",
            ),
            (
                Actor::Member {
                    member_id: "alice".into(),
                },
                "Alice",
            ),
            (
                Actor::Agent {
                    session_id: "chat".into(),
                    run_id: Some("run".into()),
                    on_behalf_of: "alice".into(),
                },
                "Codex on behalf of Alice",
            ),
            (
                Actor::Service {
                    kind: ServiceKind::Sources,
                },
                "GitHub",
            ),
            // Work a person let start on its own is started by Nodex, as its first message says.
            (
                Actor::Service {
                    kind: ServiceKind::Scheduler,
                },
                "Nodex",
            ),
        ] {
            assert_eq!(label(&c, &actor, &local).unwrap(), expected);
        }
    }
    #[test]
    fn host_producers_use_services_and_keep_grants_separate() {
        let c = fixture();
        let context = BoundModuleContext {
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("space".into()),
            project_id: None,
            connection_id: "host".into(),
            adapter: AdapterKind::ElectronHost,
            principal: None,
            editor_history_owner: None,
            agent_attribution: None,
            actor: Actor::Member {
                member_id: "forged".into(),
            },
            authorizing_member_id: None,
        };
        let intent =
            nodex_core_contracts::workspace::ProjectWorkspaceIntent::ClaimTurnNotification {
                page_id: "page".into(),
                episode: "episode".into(),
            };
        let bound = workspace(&c, &context, &intent).unwrap();
        assert_eq!(
            bound.actor,
            Actor::Service {
                kind: ServiceKind::Notifications
            }
        );
        assert!(bound.authorizing_member_id.is_none());
        assert!(
            encode(&Actor::Member {
                member_id: String::new()
            })
            .is_err()
        );
    }
}
