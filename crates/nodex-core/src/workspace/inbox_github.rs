//! GitHub requests retain external authorship and never acquire the person's start grant.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use nodex_core_contracts::{
    inbox::ProjectWorkspaceInboxSource,
    sources::{ExternalThread, SourceTriggerInput},
};
use std::collections::{BTreeMap, btree_map::Entry};

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

/// Keep only the new excerpts between Triggers. Materialize each affected body once
/// inside the same Source commit, after all of its Triggers have been linked.
#[derive(Default)]
pub(in crate::workspace) struct IntakeAppends(BTreeMap<String, IntakeAppend>);

struct IntakeAppend {
    initial_bytes: usize,
    suffix: String,
}

impl IntakeAppends {
    fn append(
        &mut self,
        c: &Connection,
        page: &str,
        markdown: &str,
        event: &SourceTriggerInput,
    ) -> Result<(), StoreError> {
        let pending = match self.0.entry(page.into()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(IntakeAppend {
                initial_bytes: c.query_row(
                    "SELECT length(CAST(m.markdown AS BLOB))
                     FROM pages p JOIN document_materializations m ON m.document_id=p.document_id
                     WHERE p.block_id=?1",
                    [page],
                    |r| {
                        let bytes = r.get(0)?;
                        usize::try_from(bytes)
                            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, bytes))
                    },
                )?,
                suffix: String::new(),
            }),
        };
        let remaining =
            MAX_MESSAGE_BYTES.saturating_sub(pending.initial_bytes + pending.suffix.len());
        let compact;
        let excerpt = if markdown.len() + 2 <= remaining {
            markdown
        } else {
            compact = text_paragraphs_markdown(&format!(
                "GitHub update · {} · {}",
                event.kind, event.url
            ));
            if compact.len() + 2 > remaining {
                return Ok(());
            }
            &compact
        };
        pending.suffix.push_str("\n\n");
        pending.suffix.push_str(excerpt);
        Ok(())
    }

    pub(in crate::workspace) fn flush(
        self,
        scope: &DurableMutationScope<'_>,
        context: &BoundModuleContext,
        library: &str,
        operation: &str,
    ) -> Result<(), StoreError> {
        let c = scope.connection();
        for (page, pending) in self.0 {
            if pending.suffix.is_empty() {
                continue;
            }
            let (generation, head) = document_head(c, &page)?;
            let mut body: String = c.query_row(
                "SELECT m.markdown FROM pages p
                 JOIN document_materializations m ON m.document_id=p.document_id
                 WHERE p.block_id=?1",
                [&page],
                |r| r.get(0),
            )?;
            body.push_str(&pending.suffix);
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
                &stable_uuid_v7(operation, "github-update", &page),
            )?;
        }
        Ok(())
    }
}

pub(in crate::workspace) fn ingest(
    scope: &DurableMutationScope<'_>,
    library: &str,
    context: &BoundModuleContext,
    operation: &str,
    appends: &mut IntakeAppends,
    trigger: &str,
    event: &SourceTriggerInput,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let c = scope.connection();
    let now = scope.committed_at();
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
            scope.store_epoch(),
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
        // The body is a bounded projection. Every complete update remains an immutable Trigger.
        appends.append(c, &page, &markdown, event)?;
        if c.query_row(
            "SELECT COALESCE((SELECT triage FROM inbox_intake WHERE page_id=?1),0)",
            [&page],
            |r| r.get::<_, bool>(0),
        )? {
            supersede_open_proposals(c, std::slice::from_ref(&page), "superseded", now)?;
            c.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1 WHERE state='pending' AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id=?1)",[&page])?;
            c.execute("UPDATE inbox_entries SET suggestion_state='waiting',suggestion_error=NULL,suggestion_request_id=NULL,current_proposal_id=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
        }
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
