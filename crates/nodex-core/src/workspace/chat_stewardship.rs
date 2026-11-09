//! Core's one rule for who may change a chat every Member of a Space shares, and who may stop
//! its work. Every check, whether a session read, a Member's own command, a command the Space
//! host carries or a relayed host call, asks this module.
//!
//! - A chat's **owner** is the Member who started it: Core records them when it creates the chat
//!   for a Member, a fork or side chat included. A chat without that record belongs to whoever
//!   asked for its first Run, otherwise to the Owner of the Page whose work it does. Replying
//!   never makes anyone else its owner.
//! - **Managing** a chat (renaming, archiving or restoring, moving it to another Project,
//!   compacting or clearing its context, merging it back) belongs to its owner and the Space
//!   Owners.
//! - **Stopping** a Run's work, its subagents, delegated or background tasks included, belongs to
//!   the Run's requester as well. Each stoppable item answers for its own Run, whichever Run is
//!   current; work whose Run is unknown stops only for those who may manage the chat.
//!
//! A personal Space's only Member is its Owner, so every chat there is theirs. Answering a
//! question or an approval follows its own entitlement (see `host_response`), and editing a
//! message stays with its author (see `host_chat`).
use crate::infrastructure::{
    member_admission,
    sqlite::{StoreError, StoreErrorCode},
};
use crate::library::members;
use nodex_core_contracts::{AdapterKind, BoundModuleContext, RemotePrincipal};
use rusqlite::{Connection, params};

/// The requesting-message identity that records the Member who created a chat.
pub(super) const CREATED_MESSAGE: &str = "session:created";

const MANAGE_REFUSAL: &str = "Only the person who started this chat or a Space Owner can do this";
const STOP_REFUSAL: &str = "Only the person who started this, or a Space Owner, can stop it.";

/// What a Member asks to do with a chat; each answer is the rule above.
#[derive(Clone, Copy, Debug)]
pub(super) enum ChatControl<'a> {
    Manage,
    /// Stop work of `run`; with no Run known, only those who may manage the chat may.
    Stop {
        run: Option<&'a str>,
    },
}

/// Records `member` as the owner of the chat Core just created for them; the first record stays.
pub(super) fn record_owner(
    connection: &Connection,
    session: &str,
    member: &str,
    at: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO session_requesting_members(session_id,message_id,member_id,accepted_at) VALUES(?1,?2,?3,?4)",
        params![session, CREATED_MESSAGE, member, at],
    )?;
    Ok(())
}

/// The Member who opened a chat, as an SQL expression over a Session: the owner Core recorded when
/// it created the chat for them, such as the default draft each Member opens for themselves.
pub(super) fn opener_sql(session: &str) -> String {
    format!(
        "(SELECT created.member_id FROM session_requesting_members created \
          WHERE created.session_id={session} AND created.message_id='{CREATED_MESSAGE}')"
    )
}

/// The Member a command acts for: the person behind it, else the Profile's local Member.
pub(super) fn acting_member(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
) -> Result<String, StoreError> {
    match context
        .actor
        .member_id()
        .or(context.authorizing_member_id.as_deref())
    {
        Some(member) => Ok(member.to_owned()),
        None => crate::infrastructure::actors::local_member(connection, library),
    }
}

/// The chat's owner as an SQL expression over a Session and a Library expression.
fn owner_sql(session: &str, library: &str) -> String {
    format!(
        "COALESCE(\
           (SELECT created.member_id FROM session_requesting_members created \
            WHERE created.session_id={session} AND created.message_id='{CREATED_MESSAGE}'), \
           (SELECT first.member_id FROM session_requesting_members first \
            WHERE first.session_id={session} ORDER BY first.accepted_at, first.message_id LIMIT 1), \
           {})",
        members::session_page_owner_sql(session, library),
    )
}

/// The Run a chat is executing now, as Core last observed it.
pub(super) fn current_run_sql(session: &str) -> String {
    format!(
        "(SELECT json_extract(observation.observed_json,'$.runId') \
          FROM session_execution_observations observation WHERE observation.session_id={session})"
    )
}

/// Whether `member` may manage `session`. Arguments are SQL expressions.
pub(super) fn may_manage_sql(session: &str, member: &str) -> String {
    let library =
        format!("(SELECT reader.library_id FROM members reader WHERE reader.id={member})");
    format!(
        "({member} IS NOT NULL AND (\
           EXISTS(SELECT 1 FROM members steward WHERE steward.id={member} \
             AND steward.role='owner' AND steward.lifecycle='active') \
           OR {member} IS {}))",
        owner_sql(session, &library),
    )
}

/// Whether `member` may stop `run`'s work in `session`. A NULL Run has no requester, so only those
/// who may manage the chat may stop it. Arguments are SQL expressions.
pub(super) fn may_stop_sql(session: &str, run: &str, member: &str) -> String {
    format!(
        "({} OR ({member} IS NOT NULL AND {run} IS NOT NULL AND {member} IS (\
           SELECT requester.member_id FROM session_run_members requester \
           WHERE requester.session_id={session} AND requester.run_id={run})))",
        may_manage_sql(session, member),
    )
}

/// Whether `member`, an active Member of `library`, may do `control` with `session`.
pub(super) fn allows(
    connection: &Connection,
    library: &str,
    member: &str,
    session: &str,
    control: ChatControl<'_>,
) -> Result<bool, StoreError> {
    let (predicate, run) = match control {
        ChatControl::Manage => (may_manage_sql("?1", "?3"), None),
        ChatControl::Stop { run } => (may_stop_sql("?1", "?2", "?3"), run),
    };
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM members WHERE id=?3 AND library_id=?4 AND lifecycle='active') AND {predicate}"
        ),
        params![session, run, member, library],
        |row| row.get(0),
    )?)
}

/// Whether `member` owns `session` itself, as a side chat's opener does; a Space Owner's role
/// does not make another Member's chat theirs.
pub(super) fn owns(
    connection: &Connection,
    library: &str,
    member: &str,
    session: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        &format!("SELECT ?1 IS {}", owner_sql("?2", "?3")),
        params![member, session, library],
        |row| row.get(0),
    )?)
}

/// A Member's verified command, whether over HTTPS or carried by the Space host, must satisfy
/// the rule. The local Profile's own commands and verified Agent work keep their own authority.
pub(super) fn require(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    session: &str,
    control: ChatControl<'_>,
) -> Result<(), StoreError> {
    if context.adapter != AdapterKind::RemoteMember {
        return Ok(());
    }
    let Some(principal) = &context.principal else {
        return Err(refused(control));
    };
    authorize(connection, library, principal, session, control)
}

/// Core admits a Member's call only while the rule allows it, before and whenever the host acts.
pub(super) fn authorize(
    connection: &Connection,
    library: &str,
    principal: &RemotePrincipal,
    session: &str,
    control: ChatControl<'_>,
) -> Result<(), StoreError> {
    member_admission::require_principal(connection, library, principal)?;
    super::session_mutation::validate_id("session_id", session)?;
    if let ChatControl::Stop { run: Some(run) } = control {
        super::session_mutation::validate_id("run_id", run)?;
    }
    super::session_mutation::require_session(connection, library, session)?;
    if allows(connection, library, &principal.member_id, session, control)? {
        return Ok(());
    }
    Err(refused(control))
}

fn refused(control: ChatControl<'_>) -> StoreError {
    let message = match control {
        ChatControl::Manage => MANAGE_REFUSAL,
        ChatControl::Stop { .. } => STOP_REFUSAL,
    };
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A team Space: Olivia owns it; Alice starts a chat, Bob replies in it, Carol never takes part.
    fn space() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../schema/current.sql"))
            .unwrap();
        c.execute_batch(
            "INSERT INTO profiles VALUES('profile','today','today');
             INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('space','profile','today','today');
             UPDATE libraries SET space_kind='team';
             INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES
               ('olivia','space','Olivia','active','owner'),('alice','space','Alice','active','member'),
               ('bob','space','Bob','active','member'),('carol','space','Carol','active','member');
             INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at)
               VALUES('chat','Work','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',1793491200000);",
        )
        .unwrap();
        c
    }
    fn manage(c: &Connection, member: &str) -> bool {
        allows(c, "space", member, "chat", ChatControl::Manage).unwrap()
    }
    fn stop(c: &Connection, member: &str, run: Option<&str>) -> bool {
        allows(c, "space", member, "chat", ChatControl::Stop { run }).unwrap()
    }
    fn reply(c: &Connection, message: &str, member: &str, at: &str) {
        c.execute(
            "INSERT INTO session_requesting_members VALUES('chat',?1,?2,?3)",
            params![message, member, at],
        )
        .unwrap();
    }
    fn run(c: &Connection, run: &str, member: &str, current: bool) {
        c.execute(
            "INSERT INTO session_run_members(session_id,run_id,member_id) VALUES('chat',?1,?2)",
            params![run, member],
        )
        .unwrap();
        if current {
            c.execute(
                "INSERT INTO session_execution_observations VALUES('chat',1,json_object('runId',?1),'today') \
                 ON CONFLICT(session_id) DO UPDATE SET observed_json=excluded.observed_json",
                [run],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_reply_never_moves_a_chat_away_from_the_member_who_started_it() {
        let c = space();
        record_owner(&c, "chat", "alice", "2026-11-01T00:00:00Z").unwrap();
        reply(&c, "alice-message", "alice", "2026-11-01T00:00:01Z");
        run(&c, "alice-run", "alice", false);
        // Bob replied last, and his Run is the chat's current work.
        reply(&c, "bob-message", "bob", "2026-11-01T00:01:00Z");
        run(&c, "bob-run", "bob", true);

        // Only Alice and the Space Owner manage the chat.
        assert_eq!(
            ["alice", "olivia", "bob", "carol"].map(|member| manage(&c, member)),
            [true, true, false, false]
        );
        // Bob stops the Run he asked for, as the chat's owner and the Owner do; Carol stops nothing.
        assert_eq!(
            ["alice", "olivia", "bob", "carol"].map(|member| stop(&c, member, Some("bob-run"))),
            [true, true, true, false]
        );
        // Work whose Run is unknown is only for those who manage the chat.
        assert_eq!(
            ["alice", "olivia", "bob", "carol"].map(|member| stop(&c, member, None)),
            [true, true, false, false]
        );
        // Alice's earlier Run is not Bob's to stop.
        assert!(!stop(&c, "bob", Some("alice-run")));
        assert!(stop(&c, "alice", Some("alice-run")));
        assert!(owns(&c, "space", "alice", "chat").unwrap());
        assert!(!owns(&c, "space", "olivia", "chat").unwrap());
    }

    #[test]
    fn a_subagent_of_an_earlier_run_answers_to_that_runs_requester_not_the_current_one() {
        let c = space();
        record_owner(&c, "chat", "alice", "2026-11-01T00:00:00Z").unwrap();
        // Bob's Run started a subagent that still works after Carol's Run became current.
        reply(&c, "bob-message", "bob", "2026-11-01T00:01:00Z");
        run(&c, "bob-run", "bob", false);
        reply(&c, "carol-message", "carol", "2026-11-01T00:02:00Z");
        run(&c, "carol-run", "carol", true);
        let subagent = |member| stop(&c, member, Some("bob-run"));
        let current = |member| stop(&c, member, Some("carol-run"));
        // The subagent is Bob's to stop, not Carol's, though her Run is current.
        assert_eq!(
            ["alice", "olivia", "bob", "carol"].map(subagent),
            [true, true, true, false]
        );
        assert_eq!(
            ["alice", "olivia", "bob", "carol"].map(current),
            [true, true, false, true]
        );
    }

    #[test]
    fn a_chat_without_a_creation_record_belongs_to_whoever_asked_for_its_first_run() {
        let c = space();
        reply(&c, "alice-message", "alice", "2026-11-01T00:00:01Z");
        reply(&c, "bob-message", "bob", "2026-11-01T00:01:00Z");
        assert!(manage(&c, "alice"));
        assert!(!manage(&c, "bob"));
        // Recording an owner later keeps the first record.
        record_owner(&c, "chat", "alice", "2026-11-01T00:02:00Z").unwrap();
        record_owner(&c, "chat", "bob", "2026-11-01T00:03:00Z").unwrap();
        assert!(!manage(&c, "bob"));
    }

    #[test]
    fn an_owner_role_and_membership_are_read_when_asked() {
        let c = space();
        record_owner(&c, "chat", "alice", "2026-11-01T00:00:00Z").unwrap();
        c.execute_batch(
            "UPDATE members SET role='member' WHERE id='olivia';
             UPDATE members SET lifecycle='removed' WHERE id='alice';",
        )
        .unwrap();
        assert!(!manage(&c, "olivia"));
        assert!(!manage(&c, "alice"));
        // Nothing in another Space reads as this Space's Member.
        assert!(!allows(&c, "elsewhere", "olivia", "chat", ChatControl::Manage).unwrap());
    }

    #[test]
    fn every_chat_in_a_personal_space_is_its_only_members() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../schema/current.sql"))
            .unwrap();
        c.execute_batch(
            "INSERT INTO profiles VALUES('profile','today','today');
             INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('space','profile','today','today');
             INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at)
               VALUES('chat','Work','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',1793491200000);",
        )
        .unwrap();
        let only = crate::infrastructure::actors::local_member(&c, "space").unwrap();
        assert!(manage(&c, &only));
        assert!(stop(&c, &only, Some("any-run")));
    }
}
