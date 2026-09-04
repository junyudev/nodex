//! Transfer owns inverse semantics; the shared registry owns capability lifetime.
//! The former inline table is read-only import input, never a second live index.

use super::*;
use crate::library::structural_edit::{self, history_owner, history_payload};
use nodex_core_contracts::library::LibraryStructuralHistoryToken;

// These source-format coordinates are private to capability import. Current
// transfers cannot construct or execute an inverse with physical View ranks.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPageRelocationUndoRecipeV2 {
    version: u32,
    project_id: String,
    library_id: String,
    store_epoch: String,
    page_id: String,
    #[serde(rename = "result_parent")]
    _result_parent: PageRelocationUndoParentV2,
    #[serde(rename = "result_location_revision")]
    _result_location_revision: i64,
    source: LegacyPageRelocationUndoSourceV2,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum LegacyPageRelocationUndoSourceV2 {
    Library {
        #[serde(rename = "previous_sibling_id")]
        _previous_sibling_id: Option<String>,
        #[serde(rename = "next_sibling_id")]
        _next_sibling_id: Option<String>,
    },
    Page {
        page_id: String,
        document_id: String,
        #[serde(rename = "parent_block_id")]
        _parent_block_id: Option<String>,
        #[serde(rename = "previous_sibling_id")]
        _previous_sibling_id: Option<String>,
        #[serde(rename = "next_sibling_id")]
        _next_sibling_id: Option<String>,
    },
    DataSource {
        data_source_id: String,
        #[serde(rename = "default_view_id")]
        _default_view_id: String,
        #[serde(rename = "positions")]
        _positions: Vec<LegacyPageRelocationUndoPositionV2>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPageRelocationUndoPositionV2 {
    #[serde(rename = "view_id")]
    _view_id: String,
    #[serde(rename = "rank_key")]
    _rank_key: String,
    #[serde(rename = "revision")]
    _revision: i64,
}

pub(in crate::library) fn token(
    value: &LibraryBlockTransferUndoToken,
) -> LibraryStructuralHistoryToken {
    LibraryStructuralHistoryToken {
        recipe_operation_id: value.transfer_operation_id.clone(),
        recipe_hash: value.recipe_hash.clone(),
        store_epoch: value.store_epoch.clone(),
    }
}

#[derive(Default)]
struct Retention {
    blocks: BTreeSet<String>,
    documents: BTreeSet<String>,
    data_sources: BTreeSet<String>,
    files: BTreeSet<String>,
}

pub(super) struct Prepared {
    pub(super) token: LibraryBlockTransferUndoToken,
    pub(super) symmetric: bool,
    project: String,
    library: String,
    payload: history_payload::EncodedPayload,
    roots: Retention,
}

fn promotion_retention(recipe: &BlockTransferUndoRecipeV4) -> Retention {
    let mut roots = Retention::default();
    if let Some(body) = &recipe.source_pre_materialization {
        roots.files.extend(body.file_ids());
    }
    if recipe.mode == LibraryBlockTransferMode::Move {
        roots.documents.insert(recipe.source_document_id.clone());
    }
    for root in &recipe.roots {
        roots.blocks.insert(root.result_page_id.clone());
        roots.blocks.extend(root.source_block_ids.iter().cloned());
        roots.documents.insert(root.result_document_id.clone());
    }
    if let Some(schema) = &recipe.schema_restore {
        roots.data_sources.insert(schema.data_source_id.clone());
    }
    if let Some(footprint) = &recipe.footprint {
        roots
            .data_sources
            .extend(footprint.data_sources.keys().cloned());
    }
    roots
}

pub(super) fn prepare_promotion_restore(
    operation_id: &str,
    state: &super::promotion_history::PromotionRestore,
) -> Result<Prepared, StoreError> {
    let mut roots = promotion_retention(&state.undo);
    roots.files.extend(state.retained_file_ids());
    roots.data_sources.extend(state.data_source_ids());
    for page in &state.pages {
        roots.blocks.extend(page.body_ids.iter().cloned());
    }
    roots.blocks.extend(state.placeholder_ids());
    let mut prepared = prepare(
        operation_id,
        state,
        &state.undo.project_id,
        &state.undo.library_id,
        &state.undo.store_epoch,
        roots,
    )?;
    prepared.payload = prepared
        .payload
        .with_dormant_sources(state.dormant_sources());
    Ok(prepared)
}

fn relocation_retention(recipe: &PageRelocationUndoRecipeV3) -> Retention {
    let mut roots = Retention::default();
    roots.blocks.insert(recipe.page_id.clone());
    match &recipe.source {
        PageRelocationUndoSourceV3::Page {
            page_id,
            document_id,
            ..
        } => {
            roots.blocks.insert(page_id.clone());
            roots.documents.insert(document_id.clone());
        }
        PageRelocationUndoSourceV3::DataSource { data_source_id, .. } => {
            roots.data_sources.insert(data_source_id.clone());
        }
        PageRelocationUndoSourceV3::Library { .. } => {}
    }
    roots
}

pub(super) fn prepare_promotion(
    operation_id: &str,
    recipe: &BlockTransferUndoRecipeV4,
) -> Result<Prepared, StoreError> {
    let mut prepared = prepare(
        operation_id,
        recipe,
        &recipe.project_id,
        &recipe.library_id,
        &recipe.store_epoch,
        promotion_retention(recipe),
    )?;
    prepared.symmetric = recipe.schema_restore.is_none()
        && recipe
            .footprint
            .as_ref()
            .is_some_and(|footprint| !footprint.has_relations);
    Ok(prepared)
}

pub(super) fn prepare_relocation(
    operation_id: &str,
    recipe: &PageRelocationUndoRecipeV3,
) -> Result<Prepared, StoreError> {
    prepare(
        operation_id,
        recipe,
        &recipe.project_id,
        &recipe.library_id,
        &recipe.store_epoch,
        relocation_retention(recipe),
    )
}

fn prepare(
    operation_id: &str,
    recipe: &impl Serialize,
    project: &str,
    library: &str,
    epoch: &str,
    roots: Retention,
) -> Result<Prepared, StoreError> {
    let json = serde_json::to_string(recipe)
        .map_err(|_| internal("Transfer inverse cannot be encoded"))?;
    Ok(Prepared {
        symmetric: false,
        token: LibraryBlockTransferUndoToken {
            transfer_operation_id: operation_id.to_owned(),
            recipe_hash: sha256(json.as_bytes()),
            store_epoch: epoch.to_owned(),
        },
        project: project.to_owned(),
        library: library.to_owned(),
        payload: history_payload::prepare_transfer(json),
        roots,
    })
}

// Decode exactly one known transfer codec. No wrapper or re-encoding may change
// the original hash: durable receipts continue to carry the original capability.
fn retention(
    json: &str,
    project: &str,
    library: &str,
    epoch: &str,
) -> Result<Retention, StoreError> {
    if let Ok(recipe) = serde_json::from_str::<BlockTransferUndoRecipeV4>(json) {
        if ![3, BLOCK_TRANSFER_UNDO_RECIPE_VERSION].contains(&recipe.version)
            || recipe.project_id != project
            || recipe.library_id != library
            || recipe.store_epoch != epoch
        {
            return Err(corrupt("Promotion history identity is invalid"));
        }
        return Ok(promotion_retention(&recipe));
    }
    if let Ok(recipe) = serde_json::from_str::<PageRelocationUndoRecipeV3>(json)
        && recipe.version == PAGE_RELOCATION_UNDO_RECIPE_VERSION
    {
        if recipe.project_id != project
            || recipe.library_id != library
            || recipe.store_epoch != epoch
        {
            return Err(corrupt("Relocation history identity is invalid"));
        }
        return Ok(relocation_retention(&recipe));
    }
    let legacy = serde_json::from_str::<LegacyPageRelocationUndoRecipeV2>(json)
        .map_err(|_| corrupt("Transfer history payload is invalid"))?;
    if legacy.version != 2
        || legacy.project_id != project
        || legacy.library_id != library
        || legacy.store_epoch != epoch
    {
        return Err(corrupt("Relocation history identity is invalid"));
    }
    let mut roots = Retention::default();
    roots.blocks.insert(legacy.page_id);
    match legacy.source {
        LegacyPageRelocationUndoSourceV2::Page {
            page_id,
            document_id,
            ..
        } => {
            roots.blocks.insert(page_id);
            roots.documents.insert(document_id);
        }
        LegacyPageRelocationUndoSourceV2::DataSource { data_source_id, .. } => {
            roots.data_sources.insert(data_source_id);
        }
        LegacyPageRelocationUndoSourceV2::Library { .. } => {}
    }
    Ok(roots)
}

pub(super) fn persist(
    connection: &Connection,
    prepared: &Prepared,
    created_at: &str,
) -> Result<(), StoreError> {
    let Prepared {
        token: value,
        project,
        library,
        payload,
        roots,
        symmetric: _,
    } = prepared;
    structural_edit::insert_history_payload(
        connection,
        &value.transfer_operation_id,
        library,
        project,
        &value.store_epoch,
        &value.recipe_hash,
        payload,
        created_at,
    )?;
    let databases = roots
        .data_sources
        .iter()
        .map(|id| {
            connection
                .query_row(
                    "SELECT home_database_block_id FROM data_sources WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    for (kind, ids) in [
        ("block", &roots.blocks),
        ("document", &roots.documents),
        ("database", &databases),
        ("file", &roots.files),
    ] {
        for id in ids {
            connection.execute(
                "INSERT INTO structural_retention_members(authority_kind, authority_id, library_id, member_kind, member_id) \
                 VALUES ('history_recipe', ?1, ?2, ?3, ?4)",
                params![value.transfer_operation_id, library, kind, id],
            )?;
        }
    }
    Ok(())
}

pub(super) fn read(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    value: &LibraryBlockTransferUndoToken,
) -> Result<(String, String), StoreError> {
    // An untrusted token must not make the import decoder inspect another
    // capability's payload or expose its corruption/consumption state.
    let legacy = connection
        .query_row(
            "SELECT consumed_at FROM block_transfer_undo_recipes WHERE transfer_operation_id = ?1 \
         AND library_id = ?2 AND store_epoch = ?3 AND recipe_hash = ?4 \
         AND (?5 IS NULL OR project_id = ?5)",
            params![
                value.transfer_operation_id,
                library,
                value.store_epoch,
                value.recipe_hash,
                context.project_id.as_ref().map(|id| id.0.as_str())
            ],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    if let Some(consumed_at) = legacy {
        if consumed_at.is_some() {
            return Err(conflict("Transfer history was already consumed"));
        }
        import(connection, &value.transfer_operation_id)?;
    }
    structural_edit::read_history_payload(
        connection,
        library,
        context.project_id.as_ref().map(|id| id.0.as_str()),
        &value.store_epoch,
        &token(value),
    )
}

pub(super) fn consume(
    connection: &Connection,
    value: &LibraryBlockTransferUndoToken,
    project: &str,
    now: &str,
    commit: &local_commit::CommitContext,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 \
         WHERE recipe_operation_id = ?2 AND recipe_hash = ?3 AND state = 'available'",
        params![now, value.transfer_operation_id, value.recipe_hash],
    )?;
    if changed != 1 {
        return Err(conflict("Transfer history was already consumed"));
    }
    local_commit::require_projection_read(
        connection,
        commit,
        nodex_core_contracts::LocalProjectionScope::StructuralHistory {
            project_id: project.to_owned(),
        },
    )?;
    history_owner::release_terminal_recipe(connection, &value.transfer_operation_id)
}

fn import(connection: &Connection, id: &str) -> Result<(), StoreError> {
    let row = connection.query_row(
        "SELECT project_id, library_id, store_epoch, recipe_hash, recipe_json, consumed_at, created_at \
         FROM block_transfer_undo_recipes WHERE transfer_operation_id = ?1", [id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, String>(6)?)),
    ).optional()?;
    let Some((project, library, epoch, hash, json, consumed_at, created_at)) = row else {
        return Ok(());
    };
    let value = LibraryBlockTransferUndoToken {
        transfer_operation_id: id.to_owned(),
        recipe_hash: hash,
        store_epoch: epoch,
    };
    if sha256(json.as_bytes()) != value.recipe_hash {
        return Err(corrupt("Transfer history payload hash changed"));
    }
    let roots = retention(&json, &project, &library, &value.store_epoch)?;
    persist(
        connection,
        &Prepared {
            token: value,
            symmetric: false,
            project,
            library,
            payload: history_payload::prepare_transfer(json),
            roots,
        },
        &created_at,
    )?;
    if let Some(consumed_at) = consumed_at {
        connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 WHERE recipe_operation_id = ?2", params![consumed_at, id])?;
        history_owner::release_terminal_recipe(connection, id)?;
    }
    connection.execute(
        "DELETE FROM block_transfer_undo_recipes WHERE transfer_operation_id = ?1",
        [id],
    )?;
    Ok(())
}

/// One legacy artifact per independently committed writer admission. Deletion
/// is the durable cursor, so imports cannot be skipped by another writer.
pub(in crate::library) fn import_one(connection: &Connection) -> Result<bool, StoreError> {
    let id = connection.query_row(
        "SELECT transfer_operation_id FROM block_transfer_undo_recipes ORDER BY transfer_operation_id LIMIT 1",
        [], |row| row.get::<_, String>(0),
    ).optional()?;
    let Some(id) = id else {
        return Ok(false);
    };
    import(connection, &id)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;

    #[test]
    fn historical_sparse_positions_decode_only_as_retention_evidence() {
        let raw = serde_json::json!({
            "version": 2,
            "project_id": "project", "library_id": "library", "store_epoch": "epoch",
            "page_id": "moved-page", "result_location_revision": 2,
            "result_parent": { "kind": "library", "library_id": "library" },
            "source": {
                "kind": "data_source", "data_source_id": "source", "default_view_id": "view",
                "positions": [{ "view_id": "view", "rank_key": "historical-rank", "revision": 8 }]
            }
        })
        .to_string();
        let roots = retention(&raw, "project", "library", "epoch").unwrap();
        assert_eq!(roots.blocks, BTreeSet::from(["moved-page".to_owned()]));
        assert_eq!(roots.data_sources, BTreeSet::from(["source".to_owned()]));
        assert!(serde_json::from_str::<PageRelocationUndoRecipeV3>(&raw).is_err());
        assert!(retention(&raw, "another-project", "library", "epoch").is_err());
    }

    #[test]
    fn legacy_import_preserves_exact_capabilities_and_resumes_only_committed_artifacts() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::infrastructure::schema::install_current_schema(&mut connection).unwrap();
        // Historical storage-codec fixture, intentionally independent of a
        // current content graph. Public promotion scenarios cover that graph.
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        let promotion = BlockTransferUndoRecipeV4 {
            version: 3,
            footprint: None,
            mode: LibraryBlockTransferMode::Copy,
            project_id: "project".into(),
            library_id: "library".into(),
            store_epoch: "epoch".into(),
            source_document_id: "source-document".into(),
            source_generation: 1,
            source_post_head_seq: None,
            source_pre_materialization: None,
            source_placeholder_block_id: None,
            roots: vec![BlockTransferUndoRootV1 {
                source_root_id: "source-block".into(),
                result_page_id: "promoted-page".into(),
                result_document_id: "promoted-document".into(),
                source_block_ids: vec!["source-block".into()],
                source_root_type: "paragraph".into(),
                source_root_properties: vec![BlockTransferUndoBlockPropertyV1 {
                    property_key: "caption".into(),
                    value_type: "text".into(),
                    value_json: serde_json::to_string(&"文".repeat(300_000)).unwrap(),
                    revision: 1,
                }],
            }],
            target_guard_hash: "a".repeat(64),
            schema_restore: None,
        };
        let relocation = PageRelocationUndoRecipeV3 {
            version: PAGE_RELOCATION_UNDO_RECIPE_VERSION,
            project_id: "project".into(),
            library_id: "library".into(),
            store_epoch: "epoch".into(),
            page_id: "relocated-page".into(),
            result_parent: PageRelocationUndoParentV2::Library {
                library_id: "library".into(),
            },
            result_location_revision: 2,
            source: PageRelocationUndoSourceV3::Page {
                page_id: "parent".into(),
                document_id: "parent-document".into(),
                parent_block_id: None,
                previous_sibling_id: None,
                next_sibling_id: None,
            },
        };
        let bodies = [
            serde_json::to_string_pretty(&promotion).unwrap(),
            serde_json::to_string_pretty(&relocation).unwrap(),
        ];
        let created = "2026-09-01T00:00:00.000Z";
        let consumed = "2026-09-02T00:00:00.000Z";
        for (index, body) in bodies.iter().enumerate() {
            connection.execute(
                "INSERT INTO block_transfer_undo_recipes VALUES (?1, 'project', 'library', 'epoch', ?2, ?3, ?4, ?5)",
                params![format!("transfer-{index}"), sha256(body.as_bytes()), body, (index == 1).then_some(consumed), created],
            ).unwrap();
        }
        let cancelled: Result<(), StoreError> =
            with_immediate_transaction(&mut connection, |transaction| {
                assert!(import_one(transaction)?);
                Err(conflict("cancelled before commit"))
            });
        assert!(cancelled.is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_recipes",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM block_transfer_undo_recipes",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        for (index, body) in bodies.iter().enumerate() {
            assert!(
                with_immediate_transaction(&mut connection, |transaction| import_one(transaction))
                    .unwrap()
            );
            let id = format!("transfer-{index}");
            let metadata = connection.query_row(
                "SELECT library_id, project_id, store_epoch, recipe_hash, state, consumed_at, created_at \
                 FROM structural_history_recipes WHERE recipe_operation_id = ?1", [&id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, String>(6)?)),
            ).unwrap();
            assert_eq!(
                metadata,
                (
                    "library".into(),
                    "project".into(),
                    "epoch".into(),
                    sha256(body.as_bytes()),
                    if index == 0 { "available" } else { "consumed" }.into(),
                    (index == 1).then(|| consumed.to_owned()),
                    created.into()
                )
            );
            let bytes = connection.prepare("SELECT payload_chunk FROM structural_history_payloads WHERE recipe_operation_id = ?1 ORDER BY part")
                .unwrap().query_map([&id], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().concat();
            assert_eq!(
                &bytes, body,
                "whitespace and multibyte chunk edges preserve the original token hash"
            );
        }
        assert!(
            !with_immediate_transaction(&mut connection, |transaction| import_one(transaction))
                .unwrap()
        );
        let terminal_queued: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM structural_history_payload_gc WHERE recipe_operation_id = 'transfer-1')", [], |row| row.get(0)).unwrap();
        assert!(terminal_queued);
        let owners: i64 = connection
            .query_row("SELECT count(*) FROM editor_history_recipes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            owners, 0,
            "import cannot invent authenticated Host lifetime evidence"
        );
    }
}
