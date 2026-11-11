//! Notes are ordinary Pages. Inbox bindings and the origin of a saved note
//! provide routing and return coordinates.
use super::*;
use nodex_core_contracts::{
    inbox::InboxNotesOutlineItem,
    library::{
        LibraryAgentSiblingAnchor, LibraryBlockTransferUndoToken, LibraryPageWriteDestination,
    },
};

pub(in crate::workspace) fn notes_page(
    connection: &Connection,
    library: &str,
    project: Option<&str>,
) -> Result<Option<String>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT page_id FROM inbox_notes WHERE library_id=?1 AND project_id IS ?2",
            params![library, project],
            |r| r.get(0),
        )
        .optional()?)
}

pub(in crate::workspace) fn outline(
    connection: &Connection,
    library: &str,
    project: Option<&str>,
) -> Result<Vec<InboxNotesOutlineItem>, StoreError> {
    let Some(root) = notes_page(connection, library, project)? else {
        return Ok(Vec::new());
    };
    Ok(connection
        .prepare(
            "WITH RECURSIVE outline(id,depth) AS (
          VALUES(?1,0)
          UNION ALL
          SELECT page.block_id,outline.depth+1 FROM outline
          JOIN pages page ON page.parent_kind='page' AND page.parent_id=outline.id
          JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
          ORDER BY 2,1 LIMIT 60
        ) SELECT outline.id,outline.depth,COALESCE(substr(material.title,1,240),'')
        FROM outline JOIN pages page ON page.block_id=outline.id
        LEFT JOIN document_materializations material ON material.document_id=page.document_id
        ORDER BY outline.depth,outline.id",
        )?
        .query_map([root], |r| {
            Ok(InboxNotesOutlineItem {
                page_id: r.get(0)?,
                depth: r.get(1)?,
                title: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn validate_destination(
    connection: &Connection,
    library: &str,
    project: Option<&str>,
    destination: Option<&str>,
) -> Result<(), StoreError> {
    let Some(destination) = destination else {
        return Ok(());
    };
    let root = notes_page(connection, library, project)?;
    let within: bool = connection.query_row(
        "WITH RECURSIVE ancestors(id,parent_id) AS (
          SELECT page.block_id,CASE WHEN page.parent_kind='page' THEN page.parent_id END
          FROM pages page JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
          WHERE page.block_id=?1 AND page.library_id=?3
          UNION ALL
          SELECT page.block_id,CASE WHEN page.parent_kind='page' THEN page.parent_id END
          FROM ancestors JOIN pages page ON page.block_id=ancestors.parent_id
          JOIN blocks block ON block.id=page.block_id AND block.lifecycle='active'
        ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)",
        params![destination, root, library],
        |r| r.get(0),
    )?;
    if !within {
        return Err(invalid(
            "Choose the Notes page or an active subpage of that Inbox's Notes",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn save(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    operation: &str,
    request_hash: &str,
    project: Option<&str>,
    pages: &[String],
    destination: Option<&str>,
    assets_root: &std::path::Path,
    now: &str,
) -> Result<(WorkspaceMutationEffects, Vec<LibraryBlockTransferUndoToken>), StoreError> {
    validate_destination(connection, library, project, destination)?;
    let mut effects = simple_effects("inbox_save_to_notes", now);
    let root = match notes_page(connection, library, project)? {
        Some(root) => root,
        None => {
            let root = stable_uuid_v7(operation, "inbox-notes", library);
            let document = stable_uuid_v7(operation, "inbox-notes-document", library);
            let created = crate::library::page_genesis::create_page_at_library_start(
                connection,
                crate::library::page_genesis::PageGenesisInput {
                    context,
                    commit_context: scope.evidence(),
                    library_id: library,
                    actor_project_id: project,
                    operation_id: operation,
                    store_epoch: scope.store_epoch(),
                    page_id: &root,
                    document_id: &document,
                    title_markdown: "Notes",
                    markdown: "",
                    now,
                },
            )?;
            connection.execute(
                "INSERT INTO inbox_notes(library_id,project_id,page_id) VALUES(?1,?2,?3)",
                params![library, project, root],
            )?;
            effects.page_ids.push(root.clone());
            effects.block_ids.push(root.clone());
            effects.document_ids.push(document);
            effects.document_heads.push(created.document_head);
            root
        }
    };
    let parent = destination.unwrap_or(&root);
    let mut tokens = Vec::with_capacity(pages.len());
    // Prepending in reverse keeps the reviewed group in order.
    for (position, page) in pages.iter().enumerate().rev() {
        let data_source: String = connection.query_row("SELECT page.parent_id FROM pages page
            JOIN inbox_entries entry ON entry.page_id=page.block_id AND entry.source_kind<>'automation'
            JOIN inbox_rows row ON row.page_id=page.block_id AND row.row_kind='intake' AND row.in_inbox=1
            WHERE page.block_id=?1 AND page.parent_kind='data_source'", [page], |r| r.get(0))
            .optional()?.ok_or_else(|| conflict("Only a message waiting for routing can be saved to Notes"))?;
        connection.execute(
            "DELETE FROM page_active_chats WHERE page_id=?1 AND EXISTS(
            SELECT 1 FROM page_turn_episodes episode WHERE episode.page_id=?1
              AND json_extract(episode.signature,'$[1]')='delivery_recovery')",
            [page],
        )?;
        connection.execute("INSERT INTO inbox_note_saves(page_id,origin_data_source_id,origin_project_id) VALUES(?1,?2,?3)",
            params![page,data_source,project])?;
        let result = crate::library::move_inbox_page_in_scope(
            connection,
            context,
            scope.store_epoch(),
            library,
            &format!("{operation}:note:{position}"),
            &crate::document::sha256(format!("{request_hash}:note:{position}").as_bytes()),
            page,
            &LibraryPageWriteDestination::Page {
                page_id: parent.to_owned(),
                at: Some(LibraryAgentSiblingAnchor::Start),
            },
            None,
            assets_root,
            Some(scope),
        )?;
        crate::database::record_person_status_edit(connection, page)?;
        tokens.push(
            result
                .committed
                .value
                .block_transfer
                .and_then(|value| value.undo_token)
                .ok_or_else(|| internal("Save to Notes requires a relocation undo recipe"))?,
        );
        effects.page_ids.push(page.clone());
    }
    Ok((effects, tokens))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn return_note(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    operation: &str,
    page: &str,
    assets_root: &std::path::Path,
    now: &str,
) -> Result<bool, StoreError> {
    let source: Option<String> = connection
        .query_row(
            "SELECT origin_data_source_id FROM inbox_note_saves WHERE page_id=?1",
            [page],
            |r| r.get(0),
        )
        .optional()?;
    let Some(data_source_id) = source else {
        return Ok(false);
    };
    let available: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM data_sources source
        JOIN database_containers container ON container.block_id=source.home_database_block_id AND container.lifecycle='active'
        WHERE source.id=?1 AND source.lifecycle='active')", [&data_source_id], |r| r.get(0))?;
    if !available {
        return Err(conflict("This note's original Database is unavailable"));
    }
    let id = stable_uuid_v7(operation, "inbox-return-note", page);
    crate::library::move_inbox_page_in_scope(
        connection,
        context,
        scope.store_epoch(),
        library,
        &id,
        &crate::document::sha256(id.as_bytes()),
        page,
        &LibraryPageWriteDestination::DataSource {
            data_source_id,
            view_id: None,
            group: None,
            at: None,
        },
        None,
        assets_root,
        Some(scope),
    )?;
    connection.execute("DELETE FROM inbox_note_saves WHERE page_id=?1", [page])?;
    let already_in_triage = connection.query_row(
        "SELECT COALESCE(stage='triage',0) FROM inbox_intake WHERE page_id=?1",
        [page],
        |r| r.get::<_, bool>(0),
    )?;
    if already_in_triage {
        crate::database::record_person_status_edit(connection, page)?;
    }
    record_routing_fact(connection, page, "open", now)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_outline_is_breadth_first_and_bounded() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE inbox_notes(library_id TEXT,project_id TEXT,page_id TEXT);
             CREATE TABLE pages(block_id TEXT,parent_kind TEXT,parent_id TEXT,document_id TEXT);
             CREATE TABLE blocks(id TEXT,lifecycle TEXT);
             CREATE TABLE document_materializations(document_id TEXT,title TEXT);
             INSERT INTO inbox_notes VALUES('library',NULL,'notes');
             INSERT INTO pages VALUES('notes','library','library','notes');
             INSERT INTO blocks VALUES('notes','active');
             INSERT INTO document_materializations VALUES('notes','Notes');",
            )
            .unwrap();
        for i in 0..64 {
            let section = format!("section:{i:02}");
            connection
                .execute("INSERT INTO pages VALUES(?1,'page','notes',?1)", [&section])
                .unwrap();
            connection
                .execute("INSERT INTO blocks VALUES(?1,'active')", [&section])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO document_materializations VALUES(?1,?1)",
                    [&section],
                )
                .unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO pages VALUES('nested','page','section:00','nested');
             INSERT INTO blocks VALUES('nested','active');
             INSERT INTO document_materializations VALUES('nested','Nested');",
            )
            .unwrap();
        let result = outline(&connection, "library", None).unwrap();
        assert_eq!(result.len(), 60);
        assert_eq!(result[0].title, "Notes");
        assert!(result[1..].iter().all(|page| page.depth == 1));
        assert_eq!(result[59].page_id, "section:58");
    }
}
