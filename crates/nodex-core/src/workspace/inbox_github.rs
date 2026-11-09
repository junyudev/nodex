//! GitHub requests retain external authorship and never acquire the person's start grant.
use super::*;
use nodex_core_contracts::{
    inbox::ProjectWorkspaceInboxSource,
    sources::{ExternalThread, SourceTriggerInput},
};

pub(in crate::workspace) fn provenance(
    thread: &ExternalThread,
    actor: &str,
) -> ProjectWorkspaceInboxSource {
    ProjectWorkspaceInboxSource::Github {
        external_thread_id: thread.id.clone(),
        actor_login: actor.into(),
        repository: thread.repository.clone(),
        number: thread.number,
        title: thread.title.clone(),
        url: thread.url.clone(),
    }
}
pub(in crate::workspace) fn read_source(
    c: &Connection,
    page: &str,
) -> Result<ProjectWorkspaceInboxSource, StoreError> {
    let raw: String = c.query_row(
        "SELECT provenance_json FROM github_entry_provenance WHERE page_id=?1",
        [page],
        |r| r.get(0),
    )?;
    serde_json::from_str(&raw).map_err(|_| corrupt("Invalid GitHub provenance"))
}
pub(in crate::workspace) fn batch_source(
    c: &Connection,
    library: &str,
    message: &str,
) -> Result<ProjectWorkspaceInboxSource, StoreError> {
    let (thread,actor):(String,String)=c.query_row("SELECT tt.thread_id,json_extract(t.event_json,'$.actor_login') FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN trigger_threads tt ON tt.trigger_id=t.id AND tt.role='primary' WHERE d.message_id=?1 AND t.library_id=?2 ORDER BY d.id LIMIT 1",params![message,library],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(provenance(
        &super::super::thread_follows::thread(c, library, &thread)?,
        &actor,
    ))
}
pub(in crate::workspace) fn register(
    c: &Connection,
    page: &str,
    author: &ProjectWorkspaceInboxSource,
) -> Result<(), StoreError> {
    let ProjectWorkspaceInboxSource::Github {
        external_thread_id, ..
    } = author
    else {
        return Ok(());
    };
    c.execute(
        "INSERT OR IGNORE INTO github_entry_provenance(page_id,provenance_json) VALUES(?1,?2)",
        params![
            page,
            serde_json::to_string(author).map_err(|_| invalid("Invalid GitHub provenance"))?
        ],
    )?;
    c.execute("INSERT INTO github_intakes(external_thread_id,page_id) VALUES(?1,?2) ON CONFLICT(external_thread_id) DO UPDATE SET page_id=excluded.page_id",params![external_thread_id,page])?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn ingest(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    trigger: &str,
    event: &SourceTriggerInput,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let thread = super::super::thread_follows::thread(c, library, &event.thread_id)?;
    let author = provenance(&thread, &event.actor_login);
    let existing: Option<String> = c
        .query_row(
            "SELECT page_id FROM github_intakes WHERE external_thread_id=?1",
            [&thread.id],
            |r| r.get(0),
        )
        .optional()?;
    let remote_text = event.text.as_deref().unwrap_or(&thread.title);
    let excerpt = remote_text.chars().take(8000).collect::<String>();
    let excerpt = if excerpt.len() < remote_text.len() {
        format!("{excerpt}…")
    } else {
        excerpt
    };
    let paragraph = format!(
        "GitHub · {} #{} · @{}\n\n{}\n\n{}",
        thread.repository, thread.number, event.actor_login, excerpt, event.url
    );
    let markdown = text_paragraphs_markdown(&paragraph);
    let page = existing
        .clone()
        .unwrap_or_else(|| stable_uuid_v7("github-intake", library, trigger));
    let mut effects = if existing.is_none() {
        let document = stable_uuid_v7("github-intake-document", library, trigger);
        capture_message_in_scope(
            c,
            library,
            context,
            epoch,
            &stable_uuid_v7(operation, "github-intake", &thread.id),
            scope,
            &page,
            &document,
            &MessagePage {
                title_markdown: title_markdown(&normalize_given_title(
                    &thread.title.chars().take(200).collect::<String>(),
                )?),
                body_markdown: markdown.clone(),
                provisional_title: None,
            },
            &EntrySource {
                kind: "github",
                label: Some(event.actor_login.clone()),
                ..Default::default()
            },
            None,
            now,
        )?
    } else {
        let (generation, head) = document_head(c, &page)?;
        let previous:String=c.query_row("SELECT m.markdown FROM pages p JOIN document_materializations m ON m.document_id=p.document_id WHERE p.block_id=?1",[&page],|r|r.get(0))?;
        let body = format!("{previous}\n\n{markdown}");
        let compact =
            text_paragraphs_markdown(&format!("GitHub update · {} · {}", event.kind, event.url));
        let compact = format!("{previous}\n\n{compact}");
        let next = if body.len() <= MAX_MESSAGE_BYTES {
            Some(body)
        } else if compact.len() <= MAX_MESSAGE_BYTES {
            Some(compact)
        } else {
            None
        };
        // The Page is a bounded intake projection. Every complete update remains a linked immutable Trigger.
        if let Some(body) = next {
            crate::document::edit_page_in_scope(
                c,
                scope,
                context,
                library,
                &page,
                generation,
                head,
                Some(&body),
                None,
                &stable_uuid_v7(operation, "github-update", trigger),
            )?;
        }
        c.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1 WHERE state='pending' AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id=?1)",[&page])?;
        c.execute("UPDATE inbox_entries SET state='open',outcome=NULL,suggestion_state='waiting',suggestion_error=NULL,suggestion_request_id=NULL,current_proposal_id=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
        simple_effects("source", now)
    };
    register(c, &page, &author)?;
    c.execute(
        "INSERT INTO github_intake_triggers VALUES(?1,?2)",
        params![trigger, thread.id],
    )?;
    effects.page_ids.push(page);
    Ok(effects)
}

pub(in crate::workspace) fn register_delivery_origins(
    c: &Connection,
    library: &str,
    message: &str,
    page: &str,
) -> Result<(), StoreError> {
    let origins=c.prepare("SELECT tt.thread_id,json_extract(t.event_json,'$.actor_login') FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN trigger_threads tt ON tt.trigger_id=t.id AND tt.role='primary' WHERE d.message_id=?1 AND t.library_id=?2 ORDER BY d.id")?.query_map(params![message,library],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (thread, actor) in origins {
        register(
            c,
            page,
            &provenance(
                &super::super::thread_follows::thread(c, library, &thread)?,
                &actor,
            ),
        )?;
    }
    Ok(())
}
