//! Promotion replays committed identity and lifecycle state, never a fresh copy intent.
//! Copy removal keeps the owned Document intact, as ordinary Page deletion does.

use super::*;
use nodex_core_contracts::library::{LibraryStructuralEditResult, LibraryStructuralHistoryToken};

mod placement;
use placement::PromotionPlacement;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PromotionFootprint {
    pub(super) data_sources: BTreeMap<String, i64>,
    relation_hash: String,
    pub(super) has_relations: bool,
}

pub(super) fn capture_footprint(
    connection: &Connection,
    roots: &[BlockTransferUndoRootV1],
) -> Result<PromotionFootprint, StoreError> {
    let mut data_sources = BTreeMap::new();
    let mut sources = connection.prepare("SELECT source.id, source.schema_revision FROM data_source_page_memberships membership JOIN data_sources source ON source.id = membership.data_source_id WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL")?;
    for root in roots {
        if let Some((id, revision)) = sources
            .query_row([&root.result_page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?
        {
            data_sources.insert(id, revision);
        }
    }
    let (relation_hash, has_relations) = relation_footprint(connection, roots, &data_sources)?;
    Ok(PromotionFootprint {
        data_sources,
        relation_hash,
        has_relations,
    })
}

fn relation_footprint(
    connection: &Connection,
    roots: &[BlockTransferUndoRootV1],
    data_sources: &BTreeMap<String, i64>,
) -> Result<(String, bool), StoreError> {
    let mut incoming = connection.prepare("SELECT edge_id, source_data_source_id, source_membership_id, property_id, target_page_block_id, sibling_rank FROM data_source_relation_edges WHERE target_page_block_id = ?1")?;
    let mut outgoing = connection.prepare("SELECT edge.edge_id, edge.source_data_source_id, edge.source_membership_id, edge.property_id, edge.target_page_block_id, edge.sibling_rank FROM data_source_page_memberships membership JOIN data_source_relation_edges edge ON edge.source_data_source_id = membership.data_source_id AND edge.source_membership_id = membership.id WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2")?;
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(String, Value)> {
        Ok((
            row.get(0)?,
            serde_json::json!([
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?
            ]),
        ))
    };
    let mut edges = BTreeMap::new();
    let mut retain = |edge: rusqlite::Result<(String, Value)>| -> Result<(), StoreError> {
        let (id, value) = edge?;
        edges.insert(id, value);
        if edges.len() > MAX_TRANSFER_ROOTS {
            return Err(invalid("Promotion Relation history exceeds its bound"));
        }
        Ok(())
    };
    for root in roots {
        check_request_interruption()?;
        incoming
            .query_map([&root.result_page_id], read)?
            .try_for_each(&mut retain)?;
        for source in data_sources.keys() {
            outgoing
                .query_map(params![source, root.result_page_id], read)?
                .try_for_each(&mut retain)?;
        }
    }
    let hash = sha256(
        &serde_json::to_vec(&edges)
            .map_err(|_| internal("Promotion Relation guard cannot encode"))?,
    );
    Ok((hash, !edges.is_empty()))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum RestoreKind {
    RestorePromotion,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PromotionRestore {
    kind: RestoreKind,
    version: u32,
    pub(super) undo: BlockTransferUndoRecipeV4,
    pub(super) pages: Vec<PromotionPage>,
    guard_hash: String,
    source_post_materialization: Option<DocumentMaterialization>,
    source_post_undo_head: Option<LibraryBlockTransferDocumentHead>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PromotionPage {
    page_id: String,
    pub(super) body_ids: Vec<String>,
    placement: PromotionPlacement,
    moved_document: Option<MovedPromotionDocument>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MovedPromotionDocument {
    materialization: DocumentMaterialization,
    placeholder_block_id: String,
    properties: Vec<BlockTransferUndoBlockPropertyV1>,
    revoked_grants: Vec<(String, i64)>,
    page_created_at: String,
    file_manifest_clocks: (i64, i64),
}

impl PromotionRestore {
    // Detached bodies retain File identity, not a frozen shared File head.
    pub(super) fn retained_file_ids(&self) -> BTreeSet<String> {
        self.pages
            .iter()
            .filter_map(|page| page.moved_document.as_ref())
            .flat_map(|moved| moved.materialization.file_ids())
            .chain(
                self.source_post_materialization
                    .iter()
                    .flat_map(DocumentMaterialization::file_ids),
            )
            .collect()
    }

    pub(super) fn data_source_ids(&self) -> BTreeSet<String> {
        self.pages
            .iter()
            .filter_map(|page| page.placement.data_source_id().map(str::to_owned))
            .collect()
    }

    pub(super) fn database_ids(&self) -> Vec<String> {
        self.pages
            .iter()
            .filter_map(|page| page.placement.database_id().map(str::to_owned))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub(super) fn view_ids(&self) -> Vec<String> {
        self.pages
            .iter()
            .flat_map(|page| page.placement.view_ids().iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub(super) fn parent_keys(&self) -> Vec<String> {
        self.pages
            .iter()
            .map(|page| {
                let (kind, id) = page.placement.parent(&self.undo.library_id);
                format!("{kind}:{id}")
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub(super) fn affected_block_ids(&self) -> Vec<String> {
        let mut ids = self
            .pages
            .iter()
            .flat_map(|page| {
                std::iter::once(page.page_id.clone()).chain(page.body_ids.iter().cloned())
            })
            .collect::<BTreeSet<_>>();
        ids.extend(self.placeholder_ids());
        if self.undo.mode == LibraryBlockTransferMode::Move {
            ids.extend(
                self.undo
                    .roots
                    .iter()
                    .flat_map(|root| root.source_block_ids.iter().cloned()),
            );
            ids.extend(self.undo.source_placeholder_block_id.iter().cloned());
        }
        ids.into_iter().collect()
    }

    pub(super) fn placeholder_ids(&self) -> impl Iterator<Item = String> + '_ {
        self.pages.iter().filter_map(|page| {
            page.moved_document
                .as_ref()
                .map(|moved| moved.placeholder_block_id.clone())
        })
    }

    pub(super) fn dormant_sources(
        &self,
    ) -> Vec<super::super::structural_edit::history_payload::DormantSource> {
        self.pages
            .iter()
            .zip(&self.undo.roots)
            .filter_map(|(page, root)| {
                let moved = page.moved_document.as_ref()?;
                (page.page_id == root.source_root_id).then(|| {
                    super::super::structural_edit::history_payload::DormantSource {
                        page_id: page.page_id.clone(),
                        document_id: root.result_document_id.clone(),
                        placeholder_block_id: moved.placeholder_block_id.clone(),
                    }
                })
            })
            .collect()
    }
}

pub(super) fn block_revisions(
    connection: &Connection,
    state: &PromotionRestore,
) -> Result<BTreeMap<String, i64>, StoreError> {
    let mut statement = connection.prepare("SELECT metadata_revision, placement_revision FROM blocks WHERE id = ?1 AND library_id = ?2")?;
    let mut revisions = BTreeMap::new();
    for id in state.affected_block_ids() {
        let (metadata, placement) = statement
            .query_row(params![id, state.undo.library_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })?;
        revisions.insert(format!("blockMetadata:{id}"), metadata);
        revisions.insert(format!("blockLocation:{id}"), placement);
    }
    for page in &state.pages {
        revisions.extend(page.placement.revisions(connection)?);
    }
    Ok(revisions)
}

fn empty_paragraph(id: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: id.to_owned(),
        block_type: "paragraph".to_owned(),
        props: BTreeMap::new(),
        content: Some(Value::Array(Vec::new())),
        children: Vec::new(),
    }
}

fn file_manifest_clocks(connection: &Connection, page_id: &str) -> Result<(i64, i64), StoreError> {
    connection
        .query_row(
            "SELECT revision, body_usage_revision FROM page_file_manifests WHERE page_id = ?1",
            [page_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(Into::into)
}

fn read_properties(
    connection: &Connection,
    block_id: &str,
) -> Result<Vec<BlockTransferUndoBlockPropertyV1>, StoreError> {
    connection.prepare("SELECT property_key, value_type, value_json, revision FROM block_properties WHERE block_id = ?1 ORDER BY property_key")?
        .query_map([block_id], |row| Ok(BlockTransferUndoBlockPropertyV1 { property_key: row.get(0)?, value_type: row.get(1)?, value_json: row.get(2)?, revision: row.get(3)? }))?.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub(super) fn capture(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    operation_id: &str,
) -> Result<Option<PromotionRestore>, StoreError> {
    if recipe.schema_restore.is_some()
        || recipe
            .footprint
            .as_ref()
            .is_some_and(|footprint| footprint.has_relations)
    {
        return Ok(None);
    }
    let mut pages = Vec::new();
    for root in &recipe.roots {
        let placement =
            PromotionPlacement::capture(connection, &recipe.library_id, &root.result_page_id)?;
        let body_ids = connection.prepare(
            "SELECT block_id FROM document_block_index WHERE document_id = ?1 ORDER BY ordinal, block_id",
        )?.query_map([&root.result_document_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let moved_document = if recipe.mode == LibraryBlockTransferMode::Move {
            let parent =
                super::super::mutation::load_parent_document(connection, &root.result_document_id)?;
            let materialization = parent.base_materialization;
            let retained_placeholder = match materialization.block_tree.as_slice() {
                [block]
                    if !root.source_block_ids.contains(&block.id)
                        && block.block_type == "paragraph"
                        && block.content.as_ref() == Some(&Value::Array(Vec::new()))
                        && block.children.is_empty() =>
                {
                    Some(block.id.clone())
                }
                _ => None,
            };
            let placeholder_block_id = retained_placeholder.unwrap_or_else(|| {
                stable_uuid_v7(
                    operation_id,
                    "promotion_undo_placeholder",
                    &root.result_page_id,
                )
            });
            let page_created_at = connection.query_row(
                "SELECT created_at FROM pages WHERE block_id = ?1",
                [&root.result_page_id],
                |row| row.get(0),
            )?;
            Some(MovedPromotionDocument {
                materialization,
                placeholder_block_id,
                properties: read_properties(connection, &root.result_page_id)?,
                revoked_grants: Vec::new(),
                page_created_at,
                file_manifest_clocks: file_manifest_clocks(connection, &root.result_page_id)?,
            })
        } else {
            None
        };
        pages.push(PromotionPage {
            page_id: root.result_page_id.clone(),
            body_ids,
            placement,
            moved_document,
        });
    }
    // A following root is also retired by this batch. Save the first surviving
    // successor; preceding selected roots are restored in their original order.
    placement::normalize_batch_anchors(&mut pages);
    Ok(Some(PromotionRestore {
        kind: RestoreKind::RestorePromotion,
        version: 1,
        undo: recipe.clone(),
        pages,
        guard_hash: String::new(),
        source_post_materialization: (recipe.mode == LibraryBlockTransferMode::Move)
            .then(|| {
                super::super::mutation::load_parent_document(connection, &recipe.source_document_id)
                    .map(|parent| parent.base_materialization)
            })
            .transpose()?,
        source_post_undo_head: None,
    }))
}

pub(super) fn retire(
    connection: &Connection,
    state: &mut PromotionRestore,
    operation_id: &str,
    commit: &local_commit::CommitContext,
    now: &str,
) -> Result<Vec<PersistedTransferCommit>, StoreError> {
    let mut commits = Vec::new();
    for (page, root) in state.pages.iter_mut().zip(&state.undo.roots) {
        page.placement.retire(connection, &page.page_id, now)?;
        if let Some(moved) = page.moved_document.as_mut() {
            retire_moved_document(
                connection,
                &state.undo,
                root,
                moved,
                operation_id,
                commit,
                now,
                &mut commits,
            )?;
        } else {
            transition_blocks(
                connection,
                &state.undo.library_id,
                page,
                "active",
                "deleted",
                now,
            )?;
        }
        connection.execute(
            "DELETE FROM library_block_placements WHERE block_id = ?1",
            [&page.page_id],
        )?;
        if page.page_id != root.source_root_id || state.undo.mode == LibraryBlockTransferMode::Copy
        {
            refresh_lifecycle_projection(connection, &page.page_id, now)?;
        }
    }
    Ok(commits)
}

#[allow(clippy::too_many_arguments)]
fn retire_moved_document(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    root: &BlockTransferUndoRootV1,
    moved: &mut MovedPromotionDocument,
    operation_id: &str,
    commit: &local_commit::CommitContext,
    now: &str,
    commits: &mut Vec<PersistedTransferCommit>,
) -> Result<(), StoreError> {
    let retained_placeholder = matches!(moved.materialization.block_tree.as_slice(), [block] if block.id == moved.placeholder_block_id);
    if !retained_placeholder {
        let mut parent =
            super::super::mutation::load_parent_document(connection, &root.result_document_id)?;
        let operations = moved
            .materialization
            .block_tree
            .iter()
            .map(|block| DocumentBlockOperation::DeleteBlock {
                block_id: block.id.clone(),
            })
            .chain(std::iter::once(DocumentBlockOperation::InsertBlock {
                block: empty_paragraph(&moved.placeholder_block_id),
                parent_block_id: None,
                before_block_id: None,
            }))
            .collect::<Vec<_>>();
        let update = prepare_document_operation_update(
            &root.result_document_id,
            parent.schema,
            &parent.engine.full_state_v1(),
            &parent.authority.head.state_vector,
            &operations,
            false,
        )
        .map_err(|error| invalid(error.to_string()))?;
        let detaches =
            removed_document_block_ids(&parent.base_materialization, &update.materialization)
                .into_iter()
                .filter(|id| root.source_block_ids.contains(id))
                .collect::<Vec<_>>();
        commits.push(persist_prepared_update(
            connection,
            &recipe.project_id,
            &parent.authority,
            &parent.base_materialization,
            &mut parent.engine,
            update,
            &format!(
                "promotion-retire:{operation_id}:{}",
                root.result_document_id
            ),
            operation_id,
            &recipe.store_epoch,
            TransferDocumentPlacement::Derived {
                advances: &[],
                exact_moves: &[],
            },
            &detaches,
            commit,
        )?);
    }
    if root.result_page_id != root.source_root_id {
        for id in [&root.result_page_id, &moved.placeholder_block_id] {
            transition_block(
                connection,
                &recipe.library_id,
                &root.result_page_id,
                id,
                "active",
                "deleted",
                now,
            )?;
        }
        return Ok(());
    }
    moved.revoked_grants =
        super::super::structural_edit::revoke_page_grants(connection, &root.result_page_id)?
            .into_iter()
            .map(|id| {
                connection
                    .query_row(
                        "SELECT revision FROM project_resource_grants WHERE id = ?1",
                        [&id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(|revision| (id, revision))
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
    moved.file_manifest_clocks = file_manifest_clocks(connection, &root.result_page_id)?;
    super::super::structural_edit::retire_page_capability(connection, &root.result_page_id)?;
    super::super::structural_edit::clear_dormant_document_projections(
        connection,
        &root.result_document_id,
    )?;
    let changed = connection.execute("UPDATE blocks SET type = ?1, metadata_revision = metadata_revision + 1, placement_revision = placement_revision + 1, updated_at = ?2 WHERE id = ?3 AND library_id = ?4 AND lifecycle = 'active' AND type = 'page'", params![root.source_root_type, now, root.source_root_id, recipe.library_id])?;
    if changed != 1 {
        return Err(conflict("Promotion Page changed before demotion"));
    }
    replace_properties(
        connection,
        &recipe.library_id,
        &root.source_root_id,
        &root.source_root_properties,
        &moved.properties,
        now,
    )
}

fn replace_properties(
    connection: &Connection,
    library: &str,
    block_id: &str,
    target: &[BlockTransferUndoBlockPropertyV1],
    previous: &[BlockTransferUndoBlockPropertyV1],
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM block_properties WHERE block_id = ?1",
        [block_id],
    )?;
    for property in target {
        let revision = previous
            .iter()
            .find(|old| old.property_key == property.property_key)
            .map_or(property.revision, |old| old.revision.max(property.revision))
            + 1;
        connection.execute("INSERT INTO block_properties(block_id, library_id, property_key, value_type, value_json, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![block_id, library, property.property_key, property.value_type, property.value_json, revision, now])?;
    }
    Ok(())
}

fn transition_blocks(
    connection: &Connection,
    library: &str,
    page: &PromotionPage,
    before: &str,
    after: &str,
    now: &str,
) -> Result<(), StoreError> {
    for id in std::iter::once(&page.page_id).chain(&page.body_ids) {
        transition_block(connection, library, &page.page_id, id, before, after, now)?;
    }
    Ok(())
}

fn transition_block(
    connection: &Connection,
    library: &str,
    page_id: &str,
    id: &str,
    before: &str,
    after: &str,
    now: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
            "UPDATE blocks SET lifecycle = ?1, metadata_revision = metadata_revision + 1, \
               placement_revision = placement_revision + CASE WHEN id = ?2 THEN 1 ELSE 0 END, updated_at = ?3 \
             WHERE id = ?4 AND library_id = ?5 AND lifecycle = ?6",
            params![after, page_id, now, id, library, before],
        )?;
    if changed != 1 {
        return Err(conflict("Promotion identity changed before replay"));
    }
    Ok(())
}

fn refresh_lifecycle_projection(
    connection: &Connection,
    page: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE page_read_model SET \
           lifecycle = (SELECT lifecycle FROM blocks WHERE id = ?1), \
           metadata_revision = (SELECT metadata_revision FROM blocks WHERE id = ?1), \
           placement_revision = (SELECT placement_revision FROM blocks WHERE id = ?1), \
           library_rank_key = (SELECT rank_key FROM library_block_placements WHERE block_id = ?1), updated_at = ?2 \
         WHERE page_block_id = ?1", params![page, now],
    )?;
    connection.execute(
        "UPDATE scheduled_page_index SET lifecycle = (SELECT lifecycle FROM blocks WHERE id = ?1), \
           source_metadata_revision = (SELECT metadata_revision FROM blocks WHERE id = ?1), updated_at = ?2 \
         WHERE page_block_id = ?1", params![page, now],
    )?;
    Ok(())
}

fn restore_guard(connection: &Connection, state: &PromotionRestore) -> Result<String, StoreError> {
    let target = block_transfer_target_guard_hash(
        connection,
        &state.undo.roots,
        state.undo.schema_restore.as_ref(),
    )?;
    let mut blocks = Vec::new();
    let mut statement = connection.prepare("SELECT type, lifecycle, metadata_revision, placement_revision FROM blocks WHERE id = ?1 AND library_id = ?2")?;
    for page in &state.pages {
        for id in page.body_ids.iter().chain(
            page.moved_document
                .iter()
                .map(|moved| &moved.placeholder_block_id),
        ) {
            let block = statement
                .query_row(params![id, state.undo.library_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .optional()?
                .ok_or_else(|| conflict("Promotion body is no longer available for replay"))?;
            blocks.push((id, block));
        }
    }
    let footprint = state
        .undo
        .footprint
        .as_ref()
        .ok_or_else(|| corrupt("Promotion replay footprint is missing"))?;
    let relations = relation_footprint(connection, &state.undo.roots, &footprint.data_sources)?;
    let schemas = footprint
        .data_sources
        .keys()
        .map(|id| {
            connection
                .query_row(
                    "SELECT schema_revision FROM data_sources WHERE id = ?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|revision| (id, revision))
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sha256(
        &serde_json::to_vec(&(target, blocks, relations, schemas))
            .map_err(|_| internal("Promotion replay guard cannot be encoded"))?,
    ))
}

pub(super) fn seal_restore(
    connection: &Connection,
    operation_id: &str,
    mut state: PromotionRestore,
) -> Result<history::Prepared, StoreError> {
    state.guard_hash = restore_guard(connection, &state)?;
    if state.undo.mode == LibraryBlockTransferMode::Move {
        let source = read_document_authority(connection, &state.undo.source_document_id)?
            .ok_or_else(|| conflict("Promotion source is no longer available"))?;
        state.source_post_undo_head = Some(LibraryBlockTransferDocumentHead {
            document_id: source.head.id,
            generation: source.head.generation,
            expected_head_seq: source.head.head_seq,
        });
    }
    history::prepare_promotion_restore(operation_id, &state)
}

pub(super) fn structural_result(
    recipe: &BlockTransferUndoRecipeV4,
    source_root_block_ids: Vec<String>,
    result_root_block_ids: Vec<String>,
    document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    history: Option<LibraryStructuralHistoryToken>,
    affected_database_ids: Vec<String>,
) -> LibraryStructuralEditResult {
    LibraryStructuralEditResult {
        operation_kind: "reverse_structural_edit".to_owned(),
        source_root_block_ids,
        result_root_block_ids,
        copied_block_ids: BTreeMap::new(),
        copied_document_ids: BTreeMap::new(),
        document_commits,
        affected_page_ids: recipe
            .roots
            .iter()
            .map(|root| root.result_page_id.clone())
            .collect(),
        affected_database_ids,
        clipboard: None,
        history,
        superseded_history_recipe_operation_ids: Vec::new(),
        resume: None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn persist_ledger(
    connection: &Connection,
    operation_id: &str,
    epoch: &str,
    request_hash: &str,
    recipe: &BlockTransferUndoRecipeV4,
    action: &str,
    roots: &[String],
    commits: &[LibraryBlockTransferDocumentCommit],
    sequence: i64,
    now: &str,
) -> Result<(), StoreError> {
    let heads = commits
        .iter()
        .map(|commit| (&commit.document_id, commit.head_seq))
        .collect::<BTreeMap<_, _>>();
    let documents = commits
        .iter()
        .map(|commit| &commit.document_id)
        .collect::<Vec<_>>();
    connection.execute(
        "INSERT INTO block_mutations(mutation_id, project_id, store_epoch, mutation_kind, actor_json, client_session_id, \
         request_hash, request_json, target_block_ids_json, affected_document_ids_json, affected_database_block_ids_json, \
         field_intents_json, expected_revisions_json, outcome, result_json, committed_revisions_json, document_heads_json, change_log_seq, recorded_at) \
         VALUES (?1, ?2, ?3, 'block_transfer', '{\"kind\":\"electron_host\"}', NULL, ?4, ?5, ?6, ?7, '[]', '[]', '{}', 'committed', '{}', '{}', ?8, ?9, ?10)",
        params![operation_id, recipe.project_id, epoch, request_hash, serde_json::json!({ "kind": action }).to_string(),
            serde_json::to_string(roots).map_err(|_| internal("Promotion history roots JSON"))?,
            serde_json::to_string(&documents).map_err(|_| internal("Promotion history Documents JSON"))?,
            serde_json::to_string(&heads).map_err(|_| internal("Promotion history heads JSON"))?, sequence, now],
    )?;
    Ok(())
}

fn authorize_restore(connection: &Connection, state: &PromotionRestore) -> Result<(), StoreError> {
    let recipe = &state.undo;
    require_project_in_library(connection, &recipe.project_id, &recipe.library_id)?;
    if recipe.mode == LibraryBlockTransferMode::Move {
        require_transfer_authority(
            connection,
            &recipe.library_id,
            &recipe.project_id,
            &recipe.source_document_id,
            None,
            TransferDocumentAccess::Write,
        )?;
    }
    for (page, root) in state.pages.iter().zip(&recipe.roots) {
        page.placement.authorize(connection, recipe)?;
        // A retired row has no active membership to grant Page access. Its
        // destination Data Source's current write authority governs restoration.
        if page.placement.data_source_id().is_some() {
            continue;
        }
        if recipe.mode == LibraryBlockTransferMode::Move && page.page_id == root.source_root_id {
            continue;
        }
        if super::super::page_grant_ownership_proof(
            connection,
            &recipe.project_id,
            &page.page_id,
            true,
        )?
        .is_none()
        {
            return Err(not_found("Page is not available to the bound Project"));
        }
    }
    Ok(())
}

fn validate_source_after_undo(
    connection: &Connection,
    state: &PromotionRestore,
) -> Result<(), StoreError> {
    let Some(expected) = &state.source_post_undo_head else {
        return Ok(());
    };
    let source = read_document_authority(connection, &expected.document_id)?
        .ok_or_else(|| conflict("Promotion source is no longer available"))?;
    if source.head.generation != expected.generation
        || source.head.head_seq != expected.expected_head_seq
    {
        return Err(conflict("Source Document changed after Promotion Undo"));
    }
    Ok(())
}

fn remove_restored_source(
    connection: &Connection,
    state: &mut PromotionRestore,
    operation_id: &str,
    commit: &local_commit::CommitContext,
) -> Result<Option<PersistedTransferCommit>, StoreError> {
    if state.undo.mode != LibraryBlockTransferMode::Move {
        return Ok(None);
    }
    let recipe = &mut state.undo;
    let mut parent =
        super::super::mutation::load_parent_document(connection, &recipe.source_document_id)?;
    // The next inverse records the actual before-image and revision clocks,
    // including properties that were absent while this Block was a Page.
    for root in &mut recipe.roots {
        root.source_root_properties = read_properties(connection, &root.source_root_id)?;
    }
    recipe.source_pre_materialization = Some(parent.base_materialization.clone());
    let mut operations = recipe
        .roots
        .iter()
        .map(|root| DocumentBlockOperation::DeleteBlock {
            block_id: root.source_root_id.clone(),
        })
        .collect::<Vec<_>>();
    let reactivations = recipe
        .source_placeholder_block_id
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    if let Some(id) = &recipe.source_placeholder_block_id {
        operations.push(DocumentBlockOperation::InsertBlock {
            block: empty_paragraph(id),
            parent_block_id: None,
            before_block_id: None,
        });
    }
    let update = prepare_document_operation_update(
        &recipe.source_document_id,
        parent.schema,
        &parent.engine.full_state_v1(),
        &parent.authority.head.state_vector,
        &operations,
        false,
    )
    .map_err(|error| invalid(error.to_string()))?;
    if state.source_post_materialization.as_ref() != Some(&update.materialization) {
        return Err(conflict(
            "Promotion no longer restores the committed source result",
        ));
    }
    let detaches = recipe
        .roots
        .iter()
        .flat_map(|root| root.source_block_ids.iter().cloned())
        .collect::<Vec<_>>();
    let persisted = persist_prepared_update(
        connection,
        &recipe.project_id,
        &parent.authority,
        &parent.base_materialization,
        &mut parent.engine,
        update,
        &format!("promotion-restore:{operation_id}:source"),
        operation_id,
        &recipe.store_epoch,
        TransferDocumentPlacement::Restore {
            advances: &[],
            reactivations: &reactivations,
        },
        &detaches,
        commit,
    )?;
    recipe.source_post_head_seq = Some(persisted.public.head_seq);
    Ok(Some(persisted))
}

fn restore_page_capability(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    root: &BlockTransferUndoRootV1,
    moved: &MovedPromotionDocument,
    placement: &PromotionPlacement,
    now: &str,
) -> Result<(), StoreError> {
    if root.result_page_id != root.source_root_id {
        for id in [&root.result_page_id, &moved.placeholder_block_id] {
            transition_block(
                connection,
                &recipe.library_id,
                &root.result_page_id,
                id,
                "deleted",
                "active",
                now,
            )?;
        }
        return Ok(());
    }
    let changed = connection.execute("UPDATE blocks SET type = 'page', metadata_revision = metadata_revision + 1, placement_revision = placement_revision + 1, updated_at = ?1 WHERE id = ?2 AND library_id = ?3 AND type = ?4 AND lifecycle = 'active'", params![now, root.result_page_id, recipe.library_id, root.source_root_type])?;
    if changed != 1 {
        return Err(conflict(
            "Promotion source Block changed before restoration",
        ));
    }
    connection.execute("INSERT INTO block_documents(block_id, document_id, library_id, created_at) VALUES (?1, ?2, ?3, ?4)", params![root.result_page_id, root.result_document_id, recipe.library_id, moved.page_created_at])?;
    let (parent_kind, parent_id) = placement.parent(&recipe.library_id);
    connection.execute("INSERT INTO pages(block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![root.result_page_id, recipe.library_id, root.result_document_id, parent_kind, parent_id, moved.page_created_at, now])?;
    // Page initialization creates an empty manifest, but restoring the same
    // Page identity must retain its pre-retirement compare-and-swap clocks.
    connection.execute(
        "DELETE FROM page_file_manifests WHERE page_id = ?1",
        [&root.result_page_id],
    )?;
    connection.execute("INSERT INTO page_file_manifests(page_id, library_id, revision, body_usage_revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![root.result_page_id, recipe.library_id, moved.file_manifest_clocks.0, moved.file_manifest_clocks.1, now])?;
    connection.execute("DELETE FROM structural_dormant_document_sources WHERE library_id = ?1 AND document_id = ?2", params![recipe.library_id, root.result_document_id])?;
    replace_properties(
        connection,
        &recipe.library_id,
        &root.result_page_id,
        &moved.properties,
        &root.source_root_properties,
        now,
    )?;
    for (id, revision) in &moved.revoked_grants {
        let changed = connection.execute("UPDATE project_resource_grants SET lifecycle = 'active', revision = revision + 1, updated_at = ?1 WHERE id = ?2 AND root_kind = 'page' AND root_id = ?3 AND lifecycle = 'revoked' AND revision = ?4", params![now, id, root.result_page_id, revision])?;
        if changed != 1 {
            return Err(conflict("Promotion Page access changed before restoration"));
        }
    }
    Ok(())
}

fn restore_demoted_projection(
    connection: &Connection,
    root: &BlockTransferUndoRootV1,
    now: &str,
) -> Result<(), StoreError> {
    if root.result_page_id != root.source_root_id {
        return Ok(());
    }
    let parent =
        super::super::mutation::load_parent_document(connection, &root.result_document_id)?;
    insert_page_read_model(
        connection,
        &root.result_page_id,
        &parent.base_materialization,
        parent.authority.head.head_seq,
        now,
    )?;
    refresh_page_intrinsic_projection(connection, &root.result_page_id, now)
}

fn restore_moved_document(
    connection: &Connection,
    recipe: &BlockTransferUndoRecipeV4,
    root: &BlockTransferUndoRootV1,
    moved: &MovedPromotionDocument,
    operation_id: &str,
    commit: &local_commit::CommitContext,
) -> Result<Option<PersistedTransferCommit>, StoreError> {
    let mut parent =
        super::super::mutation::load_parent_document(connection, &root.result_document_id)?;
    if parent.base_materialization == moved.materialization {
        return Ok(None);
    }
    if parent.base_materialization.block_tree != [empty_paragraph(&moved.placeholder_block_id)] {
        return Err(conflict(
            "Retired promotion Document changed before restoration",
        ));
    }
    let operations = std::iter::once(DocumentBlockOperation::DeleteBlock {
        block_id: moved.placeholder_block_id.clone(),
    })
    .chain(moved.materialization.block_tree.iter().map(|block| {
        DocumentBlockOperation::InsertBlock {
            block: block.clone(),
            parent_block_id: None,
            before_block_id: None,
        }
    }))
    .collect::<Vec<_>>();
    let update = prepare_document_operation_update(
        &root.result_document_id,
        parent.schema,
        &parent.engine.full_state_v1(),
        &parent.authority.head.state_vector,
        &operations,
        false,
    )
    .map_err(|error| invalid(error.to_string()))?;
    if update.materialization != moved.materialization {
        return Err(conflict(
            "Promotion cannot restore its original Document body",
        ));
    }
    let advances = root
        .source_block_ids
        .iter()
        .filter(|id| **id != root.result_page_id)
        .cloned()
        .collect::<Vec<_>>();
    let reactivations = moved
        .materialization
        .search_units
        .iter()
        .filter(|unit| !root.source_block_ids.contains(&unit.block_id))
        .map(|unit| unit.block_id.clone())
        .collect::<Vec<_>>();
    persist_prepared_update(
        connection,
        &recipe.project_id,
        &parent.authority,
        &parent.base_materialization,
        &mut parent.engine,
        update,
        &format!(
            "promotion-restore:{operation_id}:{}",
            root.result_document_id
        ),
        operation_id,
        &recipe.store_epoch,
        TransferDocumentPlacement::Restore {
            advances: &advances,
            reactivations: &reactivations,
        },
        &[],
        commit,
    )
    .map(Some)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn restore(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &LibraryStructuralHistoryToken,
    mut state: PromotionRestore,
) -> Result<LibraryApplyOutcome, StoreError> {
    if state.version != 1
        || state.undo.library_id != library_id
        || state.undo.store_epoch != store_epoch
    {
        return Err(corrupt("Promotion history identity is invalid"));
    }
    authorize_restore(connection, &state)?;
    validate_source_after_undo(connection, &state)?;
    if restore_guard(connection, &state)? != state.guard_hash {
        return Err(conflict("Promotion changed after Undo"));
    }
    let now = sqlite_now(connection)?;
    let committed = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let mut document_commits =
                remove_restored_source(connection, &mut state, operation_id, scope.evidence())?
                    .into_iter()
                    .collect::<Vec<_>>();
            let mut ordered_pages = state
                .pages
                .iter()
                .zip(&state.undo.roots)
                .collect::<Vec<_>>();
            ordered_pages.sort_by(|(a, _), (b, _)| {
                (a.placement.rank_key(), &a.page_id).cmp(&(b.placement.rank_key(), &b.page_id))
            });
            for (page, root) in ordered_pages {
                if let Some(moved) = &page.moved_document {
                    restore_page_capability(
                        connection,
                        &state.undo,
                        root,
                        moved,
                        &page.placement,
                        &now,
                    )?;
                } else {
                    transition_blocks(connection, library_id, page, "deleted", "active", &now)?;
                }
                page.placement
                    .restore(connection, library_id, &page.page_id, &now)?;
                if let Some(moved) = &page.moved_document {
                    restore_demoted_projection(connection, root, &now)?;
                    // A retained wrapper's lifecycle and location must already
                    // agree with its authority before the Document writer runs.
                    page.placement.refresh(connection, &page.page_id, &now)?;
                    document_commits.extend(restore_moved_document(
                        connection,
                        &state.undo,
                        root,
                        moved,
                        operation_id,
                        scope.evidence(),
                    )?);
                }
                page.placement.refresh(connection, &page.page_id, &now)?;
            }
            state.undo.target_guard_hash = block_transfer_target_guard_hash(
                connection,
                &state.undo.roots,
                state.undo.schema_restore.as_ref(),
            )?;
            let prepared = history::prepare_promotion(operation_id, &state.undo)?;
            let ids = state
                .pages
                .iter()
                .map(|page| page.page_id.clone())
                .collect::<Vec<_>>();
            let result = structural_result(
                &state.undo,
                state
                    .undo
                    .roots
                    .iter()
                    .map(|root| root.source_root_id.clone())
                    .collect(),
                ids.clone(),
                document_commits
                    .iter()
                    .map(|commit| commit.public.clone())
                    .collect(),
                Some(history::token(&prepared.token)),
                state.database_ids(),
            );
            let mut revisions = block_revisions(connection, &state)?;
            revisions.extend(document_commits.iter().map(|commit| {
                (
                    format!("documentHead:{}", commit.public.document_id),
                    commit.public.head_seq,
                )
            }));
            let effects = MutationEffects {
                page_file_entries: Vec::new(),
                file_revisions: BTreeMap::new(),
                file_mutation: Default::default(),
                project_id: state.undo.project_id.clone(),
                operation_kind: "reverse_structural_edit",
                change_kind: "block_mutation",
                did_mutate: true,
                created_target: None,
                affected_parent_keys: state.parent_keys(),
                affected_block_ids: state.affected_block_ids(),
                affected_page_ids: ids.clone(),
                affected_database_ids: state.database_ids(),
                affected_view_ids: state.view_ids(),
                affected_document_ids: state
                    .undo
                    .roots
                    .iter()
                    .map(|root| root.result_document_id.clone())
                    .chain(
                        document_commits
                            .iter()
                            .map(|commit| commit.public.document_id.clone()),
                    )
                    .collect(),
                committed_revisions: revisions,
                page_create: None,
                page_copy: None,
                canvas_mutation: None,
                block_transfer: None,
                block_transfer_undo: None,
                page_relocation_undo: None,
                structural_edit: Some(result),
                page_lifecycle: None,
                block_property_mutation: None,
                agent_page_copy: None,
                agent_create_pages: None,
                agent_move_pages: None,
                change_payload: None,
                committed_at: now.clone(),
            };
            seal_mutation_with(scope, context, operation_id, effects, |_, sequence| {
                persist_ledger(
                    connection,
                    operation_id,
                    store_epoch,
                    request_hash,
                    &state.undo,
                    "restore_block_promotion",
                    &ids,
                    &document_commits
                        .iter()
                        .map(|commit| commit.public.clone())
                        .collect::<Vec<_>>(),
                    sequence,
                    &now,
                )?;
                history::persist(connection, &prepared, &now)?;
                history::consume(
                    connection,
                    &LibraryBlockTransferUndoToken {
                        transfer_operation_id: token.recipe_operation_id.clone(),
                        recipe_hash: token.recipe_hash.clone(),
                        store_epoch: token.store_epoch.clone(),
                    },
                    &state.undo.project_id,
                    &now,
                    scope.evidence(),
                )
            })
        },
    )?;
    library_commit_result(connection, committed)
}
