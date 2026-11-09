//! What a Member may do in a chat its Space host runs. Core decides from its own Store each time
//! the host relay admits, delivers or uses the call; a Device's request only names the chat.
use super::chat_stewardship::ChatControl;
use crate::infrastructure::{
    member_admission,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{
    BoundModuleContext, RemotePrincipal,
    workspace::{SessionMemberActions, SessionMessageEdit, SessionRunActions},
};
use rusqlite::{Connection, OptionalExtension, params};

/// Edit refusal the desktop shows beside a Member's own message.
pub const REPLIED_SINCE: &str = "Someone else has replied since";
const MAX_MEMBER_RUNS: usize = 200;

/// A person action on a hosted chat, named by the chats it touches.
#[derive(Clone, Copy, Debug)]
pub enum HostChatAction<'a> {
    /// Read the chat, as a fork of it does: any active Member of its Space.
    Read { session: &'a str },
    /// Reply to the chat, as opening a side chat of it does: any Member while it is active.
    Reply { session: &'a str },
    /// Change what the chat shares, such as merging it back into the chat it came from: its
    /// owner and the Space Owners.
    Manage { session: &'a str },
    /// Compact or clear the context of an active chat: whoever may manage it.
    ManageContext { session: &'a str },
    /// Stop a Run's work: its requester, the chat's owner and the Space Owners. Work whose Run is
    /// not named stops only for those who may manage the chat.
    Stop {
        session: &'a str,
        run: Option<&'a str>,
    },
    /// Save or discard a temporary side chat: the Member who opened it, its owner.
    OwnSideChat { session: &'a str },
    /// Rewrite the message that opened a Run: its author, while no other Member has posted since.
    Edit { session: &'a str, run: &'a str },
    /// Start a chat, with or without a Project: any active Member, in a new chat or in the
    /// unstarted one they opened themselves, by the launch that starts it. Core makes them its
    /// owner.
    Start { session: &'a str, launch: &'a str },
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

pub(super) fn authorize(
    connection: &Connection,
    library: &str,
    principal: &RemotePrincipal,
    action: HostChatAction<'_>,
) -> Result<(), StoreError> {
    member_admission::require_principal(connection, library, principal)?;
    let chat = |session: &str| {
        super::session_mutation::validate_id("session_id", session)?;
        super::session_mutation::require_session(connection, library, session)
    };
    let active = |session: &str| {
        if chat(session)?.archived {
            return Err(denied("Restore this chat to continue it."));
        }
        Ok(())
    };
    let steward = |session, control| {
        super::chat_stewardship::authorize(connection, library, principal, session, control)
    };
    match action {
        HostChatAction::Read { session } => chat(session).map(|_| ()),
        HostChatAction::Reply { session } => active(session),
        HostChatAction::Manage { session } => steward(session, ChatControl::Manage),
        HostChatAction::ManageContext { session } => {
            active(session)?;
            steward(session, ChatControl::Manage)
        }
        HostChatAction::Stop { session, run } => steward(session, ChatControl::Stop { run }),
        HostChatAction::Edit { session, run } => {
            active(session)?;
            match message_edit(connection, session, run, &principal.member_id)? {
                SessionMessageEdit::Available => Ok(()),
                SessionMessageEdit::RepliedSince => Err(denied(REPLIED_SINCE)),
                SessionMessageEdit::Unavailable => {
                    Err(denied("Only the person who sent this message can edit it."))
                }
            }
        }
        HostChatAction::Start { session, launch } => {
            super::session_mutation::validate_id("session_id", session)?;
            super::session_mutation::validate_id("launch_id", launch)?;
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_sessions WHERE id=?1)",
                [session],
                |row| row.get(0),
            )?;
            if !exists {
                return Ok(());
            }
            let started = chat(session)?;
            // The call that starts the chat keeps its proof while it does: a chat already
            // bound is this start's only when this launch bound it.
            let launched: Option<String> = connection
                .query_row(
                    "SELECT launch_request_id FROM project_session_execution_bindings \
                     WHERE session_id=?1",
                    [session],
                    |row| row.get(0),
                )
                .optional()?;
            if started.archived
                || started.thread_id.is_some()
                || launched.is_some_and(|launched| launched != launch)
            {
                return Err(denied("This chat has already started."));
            }
            if !super::chat_stewardship::owns(connection, library, &principal.member_id, session)? {
                return Err(denied("This chat belongs to another Member."));
            }
            Ok(())
        }
        HostChatAction::OwnSideChat { session } => {
            chat(session)?;
            let temporary: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_session_side_chats WHERE session_id=?1)",
                [session],
                |row| row.get(0),
            )?;
            if !temporary {
                return Err(denied("Only a side chat can be saved or closed this way."));
            }
            if !super::chat_stewardship::owns(connection, library, &principal.member_id, session)? {
                return Err(denied("This side chat belongs to another Member."));
            }
            Ok(())
        }
    }
}

/// What the reading Member may do with each named Run: edit its opening message, by the rule
/// above, and stop its work, by the same chat stewardship rule that admits a stop.
pub(super) fn member_actions(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    session: &str,
    run_ids: &[String],
) -> Result<SessionMemberActions, StoreError> {
    super::session_mutation::validate_id("session_id", session)?;
    super::session_mutation::require_session(connection, library, session)?;
    let member = match &context.principal {
        Some(principal) => {
            member_admission::require_principal(connection, library, principal)?;
            principal.member_id.clone()
        }
        None => crate::infrastructure::actors::local_member(connection, library)?,
    };
    if run_ids.len() > MAX_MEMBER_RUNS {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "At most 200 Runs can be checked at once",
            false,
        ));
    }
    let runs = run_ids
        .iter()
        .map(|run| {
            super::session_mutation::validate_id("run_id", run)?;
            Ok(SessionRunActions {
                run_id: run.clone(),
                edit: message_edit(connection, session, run, &member)?,
                can_stop: super::chat_stewardship::allows(
                    connection,
                    library,
                    &member,
                    session,
                    ChatControl::Stop { run: Some(run) },
                )?,
            })
        })
        .collect::<Result<_, StoreError>>()?;
    Ok(SessionMemberActions { runs })
}

/// Whether `member` may rewrite the message that opened `run`. Core knows each Run's requesting
/// message from the Runtime's attribution; every person message it accepted afterwards, queued
/// ones included, counts as a reply, in the order Core accepted them.
fn message_edit(
    connection: &Connection,
    session: &str,
    run: &str,
    member: &str,
) -> Result<SessionMessageEdit, StoreError> {
    let opened: Option<(String, String)> = connection
        .query_row(
            "SELECT run.message_id, message.accepted_at FROM session_run_members run \
             JOIN session_requesting_members message ON message.session_id=run.session_id \
               AND message.message_id=run.message_id AND message.member_id=run.member_id \
             WHERE run.session_id=?1 AND run.run_id=?2 AND run.member_id=?3",
            params![session, run, member],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((message, accepted_at)) = opened else {
        return Ok(SessionMessageEdit::Unavailable);
    };
    let replied: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_requesting_members WHERE session_id=?1 \
           AND member_id<>?2 AND (accepted_at>?3 OR (accepted_at=?3 AND message_id>?4)))",
        params![session, member, accepted_at, message],
        |row| row.get(0),
    )?;
    Ok(if replied {
        SessionMessageEdit::RepliedSince
    } else {
        SessionMessageEdit::Available
    })
}
