use chrono::{DateTime, Datelike, SecondsFormat, Timelike, Utc};
use nodex_core_contracts::CoreErrorRecovery;
use nodex_core_contracts::inbox::{InboxLater, InboxLaterNotification};
use nodex_core_contracts::workspace::ProjectWorkspaceIntent;

use super::*;

const PENDING: &str = "
    FROM inbox_deferrals deferral
    JOIN inbox_member_rows rows ON rows.page_id=deferral.page_id
      AND rows.member_id=deferral.member_id AND rows.episode=deferral.episode AND rows.in_inbox=1
    LEFT JOIN inbox_later_notifications intent ON intent.page_id=deferral.page_id
      AND intent.member_id=deferral.member_id AND intent.episode=deferral.episode
    WHERE rows.library_id=?1 AND intent.id IS NULL
";
const CURRENT_NOTIFICATIONS: &str = "
    FROM inbox_later_notifications intent
    JOIN inbox_member_rows rows ON rows.page_id=intent.page_id
      AND rows.member_id=intent.member_id AND rows.episode=intent.episode AND rows.in_inbox=1
    WHERE intent.library_id=?1 AND (
       (?3 AND intent.push_claimed=0) OR (NOT ?3 AND intent.member_id=?2 AND intent.claimed=0))
";

fn canonical(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn parse(value: &str) -> Result<DateTime<Utc>, StoreError> {
    let instant = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid("remind_at must be an ISO 8601 instant with an offset"))?
        .to_utc();
    if !(0..=9999).contains(&instant.year()) || instant.nanosecond() >= 1_000_000_000 {
        return Err(invalid("remind_at must name a representable instant"));
    }
    Ok(instant)
}

pub(super) fn normalize_time(value: &str) -> Result<String, StoreError> {
    Ok(canonical(parse(value)?))
}

pub(in crate::workspace) fn now(connection: &Connection) -> Result<String, StoreError> {
    normalize_time(&sqlite_now(connection)?)
}

pub(super) fn set_entries(
    connection: &Connection,
    context: &BoundModuleContext,
    pages: &[String],
    until: &str,
    now: &str,
) -> Result<(), StoreError> {
    require_decision_authority(context)?;
    let until = normalize_time(until)?;
    let now = normalize_time(now)?;
    if until <= now {
        return Err(invalid("Choose a return time in the future")
            .with_recovery(CoreErrorRecovery::InboxRemindAtPassed));
    }
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    for page in pages {
        if connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_entries entry
            JOIN inbox_rows row ON row.page_id=entry.page_id AND row.row_kind='intake' AND row.in_inbox=1
            WHERE entry.page_id=?1 AND entry.source_kind='automation')", [page], |row| row.get::<_, bool>(0))? {
            return Err(invalid("An Automation run decision cannot be set aside"));
        }
        let episode: String = connection.query_row(
            "SELECT rows.episode FROM inbox_member_rows rows
             LEFT JOIN inbox_entries entry ON rows.row_kind='intake' AND entry.page_id=rows.page_id
             WHERE rows.page_id=?1 AND rows.member_id=?2 AND rows.in_inbox=1
               AND (rows.row_kind='turn' OR (rows.row_kind='intake' AND entry.source_kind<>'automation'))",
            params![page,member], |row| row.get(0),
        ).optional()?.ok_or_else(|| conflict("Only eligible Pages waiting for you can be set aside"))?;
        connection.execute(
            "DELETE FROM inbox_deferrals WHERE page_id=?1 AND member_id=?2",
            params![page, member],
        )?;
        connection.execute(
            "INSERT INTO inbox_deferrals(page_id,member_id,episode,set_at,until_at) VALUES(?1,?2,?3,?4,?5)",
            params![page,member,episode,now,until],
        )?;
        connection.execute(
            "UPDATE page_turn_notification_intents SET claimed_at=?4
            WHERE page_id=?1 AND member_id=?2 AND episode=?3 AND claimed_at IS NULL",
            params![page, member, episode, now],
        )?;
        // Standing consent applies to newly offered work. Deferring an existing offer
        // withdraws its automatic admission without changing the offer or its basis.
        connection.execute(
            "UPDATE inbox_proposals SET auto_confirm_pending=0 WHERE auto_confirm_pending=1
             AND proposal_id=(SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1 AND author_member_id=?2)",
            params![page,member],
        )?;
    }
    Ok(())
}

pub(in crate::workspace) fn record(
    connection: &Connection,
    page: &str,
    member: &str,
) -> Result<Option<InboxLater>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT deferral.set_at,deferral.until_at FROM inbox_deferrals deferral JOIN inbox_member_rows rows
             ON rows.page_id=deferral.page_id AND rows.member_id=deferral.member_id AND rows.episode=deferral.episode
             WHERE deferral.page_id=?1 AND deferral.member_id=?2 AND rows.in_inbox=1",
            params![page, member],
            |row| {
                Ok(InboxLater {
                    set_at: row.get(0)?,
                    until: row.get(1)?,
                })
            },
        )
        .optional()?)
}

pub(in crate::workspace) fn next(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
) -> Result<Option<String>, StoreError> {
    require_host(context)?;
    Ok(connection
        .query_row(
            &format!("SELECT deferral.until_at {PENDING} ORDER BY deferral.until_at LIMIT 1"),
            [library_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub(in crate::workspace) fn notifications(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    for_push: bool,
) -> Result<Vec<InboxLaterNotification>, StoreError> {
    if for_push {
        require_host(context)?;
    } else {
        require_decision_authority(context)?;
    }
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    Ok(connection.prepare(&format!(
        "SELECT intent.id,intent.member_id,intent.page_id,intent.returned_at,
         COALESCE((SELECT substr(m.title,1,512) FROM pages p JOIN document_materializations m ON m.document_id=p.document_id WHERE p.block_id=intent.page_id),'')
         {CURRENT_NOTIFICATIONS} ORDER BY intent.returned_at,intent.id LIMIT 100"
    ))?.query_map(params![library_id,member,for_push], |row| Ok(InboxLaterNotification {
        id: row.get(0)?, member_id: row.get(1)?, page_id: row.get(2)?, returned_at: row.get(3)?, title: row.get(4)?,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(in crate::workspace) fn push_owner(
    connection: &Connection,
    library_id: &str,
    id: &str,
) -> Result<Option<String>, StoreError> {
    validate_id("id", id)?;
    Ok(connection
        .query_row(
            &format!("SELECT intent.member_id {CURRENT_NOTIFICATIONS} AND intent.id=?4"),
            params![library_id, "", true, id],
            |row| row.get(0),
        )
        .optional()?)
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn apply(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    intent: &ProjectWorkspaceIntent,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            let mut effects = simple_effects("inbox_write", &now);
            match intent {
                ProjectWorkspaceIntent::SetInboxLater { page_ids, until } => {
                    let pages = unique_page_ids(page_ids, MAX_BULK_PAGES)?;
                    set_entries(connection, context, &pages, until, &now)?;
                    effects.page_ids = pages;
                }
                ProjectWorkspaceIntent::ClearInboxLater { page_ids } => {
                    require_decision_authority(context)?;
                    let pages = unique_page_ids(page_ids, MAX_BULK_PAGES)?;
                    let member =
                        crate::infrastructure::actors::requesting_member(connection, context)?;
                    for page in &pages {
                        connection.execute(
                            "DELETE FROM inbox_deferrals WHERE page_id=?1 AND member_id=?2",
                            params![page, member],
                        )?;
                    }
                    effects.page_ids = pages;
                }
                ProjectWorkspaceIntent::PublishDueInboxLater { wake_at } => {
                    effects.operation_kind = "inbox_later_due";
                    require_host(context)?;
                    let cutoff = normalize_time(&now)?;
                    let wake_at = normalize_time(wake_at)?;
                    if wake_at > cutoff {
                        return Ok(effects);
                    }
                    let due = connection
                        .prepare(&format!(
                            "SELECT deferral.page_id,deferral.member_id,deferral.episode,deferral.until_at
                         {PENDING} AND deferral.until_at<=?2"
                        ))?
                        .query_map(params![library_id, cutoff], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    for (page, member, episode, until) in due {
                        let id = stable_uuid_v7(operation_id, &member, &page);
                        connection.execute(
                            "INSERT INTO inbox_later_notifications(id,library_id,page_id,member_id,episode,returned_at)
                             VALUES(?1,?2,?3,?4,?5,?6)",
                            params![id,library_id,page,member,episode,until],
                        )?;
                        effects.page_ids.push(page);
                    }
                    effects.page_ids.sort_unstable();
                    effects.page_ids.dedup();
                }
                ProjectWorkspaceIntent::ClaimInboxLaterNotification { id, for_push } => {
                    if *for_push {
                        require_host(context)?;
                    } else {
                        require_decision_authority(context)?;
                    }
                    let member =
                        crate::infrastructure::actors::requesting_member(connection, context)?;
                    let page = connection
                        .query_row(
                            &format!(
                                "SELECT intent.page_id {CURRENT_NOTIFICATIONS} AND intent.id=?4"
                            ),
                            params![library_id, member, for_push, id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .ok_or_else(|| conflict("This Inbox reminder was already settled"))?;
                    let claimed = if *for_push { "push_claimed" } else { "claimed" };
                    connection.execute(
                        &format!("UPDATE inbox_later_notifications SET {claimed}=1 WHERE id=?1"),
                        [id],
                    )?;
                    effects.page_ids.push(page);
                }
                _ => return Err(internal("Invalid Inbox Later command")),
            }
            Ok(effects)
        },
    )
}
