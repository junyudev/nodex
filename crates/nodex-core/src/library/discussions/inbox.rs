//! The Inbox projects the latest eligible activity for each Discussion and requesting Member.

use super::*;
use crate::infrastructure::actors;

pub(crate) fn read(
    c: &Connection,
    context: &BoundModuleContext,
    cursor: Option<&DiscussionCursor>,
    limit: Option<u32>,
) -> Result<DiscussionInboxWindow, StoreError> {
    let limit = limit.unwrap_or(30);
    if !(1..=100).contains(&limit) {
        return Err(invalid("Inbox limit must be between 1 and 100"));
    }
    let context = actors::bind(c, context)?;
    let member = actors::requesting_member(c, &context)?;
    let project = context.project_id.as_ref().map(|id| id.0.as_str());
    // Acknowledged Ask replies stay in the answered branch so they cannot reappear as replies.
    let mut stmt = c.prepare(
        "WITH RECURSIVE project_pages(id) AS (
           SELECT page_id FROM activity_page_scopes WHERE project_id=?3 AND library_id=?1
           UNION SELECT p.block_id FROM pages p JOIN project_pages a
             ON p.parent_kind='page' AND p.parent_id=a.id WHERE p.library_id=?1
         ), facts AS (
           SELECT d.id, d.page_id, d.last_activity_at AS activity, p.document_id, cm.id AS comment_id,
             cm.body, max(cm.created_at,coalesce(cm.edited_at,cm.created_at)) AS at, CASE
               WHEN (cm.question_for=?2 OR (json_extract(cm.ask_json,'$.state')='needs_you'
                 AND coalesce(json_extract(cm.ask_json,'$.requesterId'),
                     json_extract(cm.author_json,'$.member_id'),json_extract(cm.author_json,'$.on_behalf_of'))=?2))
               AND NOT EXISTS(SELECT 1 FROM page_discussion_comments later
                 WHERE later.discussion_id=d.id AND later.deleted_at IS NULL
                   AND (later.created_at,later.id)>(cm.created_at,cm.id)
                   AND json_extract(later.author_json,'$.member_id')=?2)
                 THEN 0
               WHEN json_extract(cm.suggested_edit_json,'$.state')='open'
                 AND coalesce(json_extract(cm.author_json,'$.member_id'),
                     json_extract(cm.author_json,'$.on_behalf_of'),'')<>?2
                 AND (json_extract(work.value_json,'$.owner')=?2 OR
                   (work.value_json IS NULL AND l.space_kind='personal')) THEN 1
               WHEN coalesce(json_extract(cm.author_json,'$.member_id'),'')<>?2
                 AND EXISTS(SELECT 1 FROM json_each(cm.mentions_json) WHERE value=?2) THEN 2
               WHEN json_extract(cm.author_json,'$.type')='agent' AND EXISTS(
                 SELECT 1 FROM page_discussion_comments ask
                 WHERE ask.discussion_id=d.id AND ask.deleted_at IS NULL
                   AND json_extract(ask.ask_json,'$.state')='answered'
                   AND json_extract(ask.ask_json,'$.sessionId')=json_extract(cm.author_json,'$.session_id')
                   AND json_extract(ask.ask_json,'$.runId')=json_extract(cm.author_json,'$.run_id')
                   AND coalesce(json_extract(ask.ask_json,'$.requesterId'),
                     json_extract(ask.author_json,'$.member_id'),json_extract(ask.author_json,'$.on_behalf_of'))=?2
               ) THEN CASE WHEN NOT EXISTS(
                 SELECT 1 FROM page_discussion_comments later WHERE later.discussion_id=d.id AND (
                   (later.deleted_at IS NULL AND (later.created_at,later.id)>(cm.created_at,cm.id)
                     AND json_extract(later.author_json,'$.member_id')=?2)
                   OR (json_extract(later.suggested_edit_json,'$.state') IN ('accepted','rejected')
                     AND json_extract(later.suggested_edit_json,'$.decidedBy.member_id')=?2
                     AND (json_extract(later.suggested_edit_json,'$.decidedAt')>cm.created_at
                       OR (later.id=cm.id AND json_extract(later.suggested_edit_json,'$.decidedAt')=cm.created_at)))
                 )
               ) THEN 3 END
               WHEN coalesce(json_extract(cm.author_json,'$.member_id'),'')<>?2
                 AND (cm.suggested_edit_json IS NULL OR
                   coalesce(json_extract(cm.author_json,'$.on_behalf_of'),'')<>?2)
                 AND EXISTS(SELECT 1 FROM page_discussion_comments earlier WHERE earlier.discussion_id=d.id
                   AND earlier.deleted_at IS NULL AND (earlier.created_at,earlier.id)<(cm.created_at,cm.id)
                   AND json_extract(earlier.author_json,'$.member_id')=?2) THEN 4
             END AS priority
           FROM page_discussion_comments cm JOIN page_discussions d ON d.id=cm.discussion_id
           JOIN pages p ON p.block_id=d.page_id JOIN blocks b ON b.id=p.block_id
           JOIN libraries l ON l.id=p.library_id
           LEFT JOIN block_properties work ON work.block_id=p.block_id AND work.property_key='work'
           WHERE p.library_id=?1 AND b.lifecycle='active' AND cm.deleted_at IS NULL AND d.resolved_at IS NULL
             AND (?3 IS NULL OR EXISTS(SELECT 1 FROM project_pages WHERE id=p.block_id))
             AND (?4 IS NULL OR (d.last_activity_at,d.id)<(?4,?5))
         ), ranked AS (
           SELECT facts.*, row_number() OVER (PARTITION BY id ORDER BY
             CASE WHEN priority<2 THEN priority ELSE 2 END, at DESC, priority, comment_id DESC) AS rank
           FROM facts WHERE priority IS NOT NULL
         )
         SELECT r.id,r.page_id,r.comment_id,coalesce(dm.title,''),substr(r.body,1,500),r.activity,r.priority
         FROM ranked r LEFT JOIN document_materializations dm ON dm.document_id=r.document_id
         WHERE r.rank=1 ORDER BY r.activity DESC,r.id DESC LIMIT ?6",
    )?;
    let mut items = stmt
        .query_map(
            params![
                context.library_id.0,
                member,
                project,
                cursor.map(|v| &v.last_activity_at),
                cursor.map(|v| &v.id),
                limit + 1,
            ],
            |row| {
                let reason = match row.get::<_, u8>(6)? {
                    0 => DiscussionInboxReason::NeedsYou,
                    1 => DiscussionInboxReason::SuggestedEdit,
                    2 => DiscussionInboxReason::Mention,
                    3 => DiscussionInboxReason::Answered,
                    _ => DiscussionInboxReason::Reply,
                };
                Ok(DiscussionInboxEntry {
                    discussion_id: row.get(0)?,
                    page_id: row.get(1)?,
                    comment_id: row.get(2)?,
                    title: row.get(3)?,
                    excerpt: row.get(4)?,
                    occurred_at: row.get(5)?,
                    reason,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if items.len() > limit as usize {
        items.pop();
        items.last().map(|item| DiscussionCursor {
            id: item.discussion_id.clone(),
            last_activity_at: item.occurred_at.clone(),
        })
    } else {
        None
    };
    Ok(DiscussionInboxWindow { items, next })
}
