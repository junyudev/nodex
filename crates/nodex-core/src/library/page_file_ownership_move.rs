use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::library::LibraryPageFileOwnershipMove;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::page_files::allocate_numbered_path;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PageFilePlacementMove {
    pub(super) source_page_id: String,
    pub(super) target_page_id: String,
    pub(super) candidate_file_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct PageFileOwnershipMoveEffects {
    pub(super) moves: Vec<LibraryPageFileOwnershipMove>,
    pub(super) manifest_revisions: BTreeMap<String, i64>,
    pub(super) content_revision_page_ids: BTreeSet<String>,
    pub(super) affected_page_ids: BTreeSet<String>,
}

impl PageFileOwnershipMoveEffects {
    pub(super) fn committed_revisions(&self, commit_seq: i64) -> BTreeMap<String, i64> {
        self.manifest_revisions
            .iter()
            .map(|(page_id, revision)| (format!("pageFiles:{page_id}"), *revision))
            .chain(
                self.content_revision_page_ids
                    .iter()
                    .map(|page_id| (format!("pageFileContent:{page_id}"), commit_seq)),
            )
            .collect()
    }
}

#[derive(Clone, Debug)]
struct EligibleFile {
    file_id: String,
    source_page_id: String,
    target_page_id: String,
    previous_logical_path: String,
    logical_path: String,
    path_key: String,
    mime_type: String,
    blob_hash: String,
    byte_length: i64,
    previous_version: i64,
}

pub(super) fn candidate_file_ids(
    connection: &Connection,
    library_id: &str,
    source_document_id: &str,
    moved_block_ids: &[String],
) -> Result<Vec<String>, StoreError> {
    if moved_block_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = json!(moved_block_ids).to_string();
    connection
        .prepare(
            "SELECT DISTINCT reference.page_file_id \
             FROM block_asset_refs reference \
             WHERE reference.library_id = ?1 AND reference.document_id = ?2 \
               AND reference.block_id IN (SELECT value FROM json_each(?3)) \
               AND reference.page_file_id IS NOT NULL \
             ORDER BY reference.page_file_id",
        )?
        .query_map(params![library_id, source_document_id, ids], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub(super) fn move_exclusively_placed_files(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    actor_id: &str,
    now: &str,
    placement_moves: &[PageFilePlacementMove],
) -> Result<PageFileOwnershipMoveEffects, StoreError> {
    move_files_with_placement_expectation(
        connection,
        library_id,
        operation_id,
        actor_id,
        now,
        placement_moves,
        PlacementExpectation::Target,
    )
}

/// Promotion Undo runs before deleting the generated Page, so its authenticated
/// inverse evidence expects every placement to still be in the current owner.
/// Callers must additionally require every requested File to be returned.
pub(super) fn restore_promoted_page_file_ownership(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    actor_id: &str,
    now: &str,
    placement_moves: &[PageFilePlacementMove],
) -> Result<PageFileOwnershipMoveEffects, StoreError> {
    move_files_with_placement_expectation(
        connection,
        library_id,
        operation_id,
        actor_id,
        now,
        placement_moves,
        PlacementExpectation::Source,
    )
}

#[derive(Clone, Copy)]
enum PlacementExpectation {
    Source,
    Target,
}

fn move_files_with_placement_expectation(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    actor_id: &str,
    now: &str,
    placement_moves: &[PageFilePlacementMove],
    placement_expectation: PlacementExpectation,
) -> Result<PageFileOwnershipMoveEffects, StoreError> {
    let mut coordinates = placement_moves
        .iter()
        .flat_map(|movement| {
            movement.candidate_file_ids.iter().map(|file_id| {
                (
                    movement.source_page_id.clone(),
                    movement.target_page_id.clone(),
                    file_id.clone(),
                )
            })
        })
        .collect::<Vec<_>>();
    coordinates.sort();
    coordinates.dedup();

    let mut eligible = Vec::new();
    for (source_page_id, target_page_id, file_id) in coordinates {
        if source_page_id == target_page_id {
            continue;
        }
        require_active_page(connection, library_id, &target_page_id)?;
        let current = connection
            .query_row(
                "SELECT file.logical_path, file.path_key, file.mime_type, file.byte_length, \
                        file.current_version, version.blob_hash \
                 FROM page_files file \
                 JOIN page_file_versions version ON version.file_id = file.file_id \
                   AND version.version = file.current_version \
                 WHERE file.file_id = ?1 AND file.library_id = ?2 \
                   AND file.owner_page_id = ?3 AND file.state = 'live'",
                params![file_id, library_id, source_page_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((logical_path, path_key, mime_type, byte_length, previous_version, blob_hash)) =
            current
        else {
            continue;
        };
        let Some(blob_hash) = blob_hash else {
            return Err(corrupt("Live Page File has no current Blob"));
        };
        let expected_placement_page_id = match placement_expectation {
            PlacementExpectation::Source => source_page_id.as_str(),
            PlacementExpectation::Target => target_page_id.as_str(),
        };
        let placement_pages = placement_page_ids(connection, library_id, &file_id)?;
        if placement_pages.as_slice() != [expected_placement_page_id] {
            continue;
        }
        eligible.push(EligibleFile {
            file_id,
            source_page_id,
            target_page_id,
            previous_logical_path: logical_path.clone(),
            logical_path,
            path_key,
            mime_type,
            blob_hash,
            byte_length,
            previous_version,
        });
    }
    if eligible.is_empty() {
        return Ok(PageFileOwnershipMoveEffects::default());
    }

    allocate_target_paths(connection, library_id, &mut eligible)?;
    let affected_page_ids = eligible
        .iter()
        .flat_map(|file| [file.source_page_id.clone(), file.target_page_id.clone()])
        .collect::<BTreeSet<_>>();
    let mut manifest_revisions = BTreeMap::new();
    for page_id in &affected_page_ids {
        let current = connection.query_row(
            "SELECT revision FROM page_file_manifests WHERE page_id = ?1 AND library_id = ?2",
            params![page_id, library_id],
            |row| row.get::<_, i64>(0),
        )?;
        let next = current
            .checked_add(1)
            .ok_or_else(|| conflict("Page File manifest revision overflowed"))?;
        let updated = connection.execute(
            "UPDATE page_file_manifests SET revision = ?1, updated_at = ?2 \
             WHERE page_id = ?3 AND library_id = ?4 AND revision = ?5",
            params![next, now, page_id, library_id, current],
        )?;
        if updated != 1 {
            return Err(conflict("Page File manifest revision changed"));
        }
        manifest_revisions.insert(page_id.clone(), next);
    }

    for file in &eligible {
        connection.execute(
            "DELETE FROM page_file_namespace WHERE file_id = ?1",
            [&file.file_id],
        )?;
    }
    for file in &eligible {
        connection.execute(
            "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![file.target_page_id, library_id, file.path_key, file.file_id],
        )?;
    }

    let mut effects = PageFileOwnershipMoveEffects {
        moves: Vec::with_capacity(eligible.len()),
        manifest_revisions,
        content_revision_page_ids: BTreeSet::new(),
        affected_page_ids,
    };
    for file in eligible {
        let version = file
            .previous_version
            .checked_add(1)
            .ok_or_else(|| conflict("Page File version overflowed"))?;
        let manifest_revision = effects
            .manifest_revisions
            .get(&file.target_page_id)
            .copied()
            .ok_or_else(|| corrupt("Target Page File manifest was not advanced"))?;
        connection.execute(
            "INSERT INTO page_file_versions( \
               file_id, version, library_id, owner_page_id, manifest_revision, change_kind, \
               logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, turn_id, \
               operation_id, occurred_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'rehome', ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13)",
            params![
                file.file_id,
                version,
                library_id,
                file.target_page_id,
                manifest_revision,
                file.logical_path,
                file.path_key,
                file.mime_type,
                file.blob_hash,
                file.byte_length,
                actor_id,
                operation_id,
                now,
            ],
        )?;
        let updated = connection.execute(
            "UPDATE page_files SET owner_page_id = ?1, logical_path = ?2, path_key = ?3, \
               current_version = ?4, updated_at = ?5 \
             WHERE file_id = ?6 AND library_id = ?7 AND owner_page_id = ?8 \
               AND current_version = ?9 AND state = 'live'",
            params![
                file.target_page_id,
                file.logical_path,
                file.path_key,
                version,
                now,
                file.file_id,
                library_id,
                file.source_page_id,
                file.previous_version,
            ],
        )?;
        if updated != 1 {
            return Err(conflict("Page File ownership changed"));
        }
        // Rehome changes the File read authority even when its logical path is
        // preserved. Both the previous owner and every final placement must
        // invalidate cached content under the ownership transition's commit.
        effects
            .content_revision_page_ids
            .insert(file.source_page_id.clone());
        effects
            .content_revision_page_ids
            .insert(file.target_page_id.clone());
        effects.content_revision_page_ids.extend(placement_page_ids(
            connection,
            library_id,
            &file.file_id,
        )?);
        effects.moves.push(LibraryPageFileOwnershipMove {
            file_id: file.file_id,
            previous_owner_page_id: file.source_page_id,
            owner_page_id: file.target_page_id,
            previous_logical_path: file.previous_logical_path,
            logical_path: file.logical_path,
            version,
        });
    }
    Ok(effects)
}

fn allocate_target_paths(
    connection: &Connection,
    library_id: &str,
    eligible: &mut [EligibleFile],
) -> Result<(), StoreError> {
    let moving_file_ids = eligible
        .iter()
        .map(|file| file.file_id.as_str())
        .collect::<BTreeSet<_>>();
    let target_pages = eligible
        .iter()
        .map(|file| file.target_page_id.clone())
        .collect::<BTreeSet<_>>();
    let mut occupied_by_target = BTreeMap::new();
    for target_page_id in target_pages {
        let occupied = connection
            .prepare(
                "SELECT file_id, path_key FROM page_files \
                 WHERE library_id = ?1 AND owner_page_id = ?2 AND state = 'live' \
                 ORDER BY path_key",
            )?
            .query_map(params![library_id, target_page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(file_id, path_key)| {
                (!moving_file_ids.contains(file_id.as_str())).then_some(path_key)
            })
            .collect::<BTreeSet<_>>();
        occupied_by_target.insert(target_page_id, occupied);
    }
    for file in eligible {
        let occupied = occupied_by_target
            .get_mut(&file.target_page_id)
            .ok_or_else(|| corrupt("Target Page File namespace was not loaded"))?;
        let Some((logical_path, path_key)) =
            allocate_numbered_path(&file.previous_logical_path, occupied)?
        else {
            return Err(conflict("Target Page File namespace is exhausted"));
        };
        file.logical_path = logical_path;
        file.path_key = path_key;
    }
    Ok(())
}

fn placement_page_ids(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<Vec<String>, StoreError> {
    connection
        .prepare(
            "SELECT DISTINCT reference.owner_block_id \
             FROM block_asset_refs reference \
             JOIN blocks owner ON owner.id = reference.owner_block_id \
               AND owner.library_id = reference.library_id \
             WHERE reference.library_id = ?1 AND reference.page_file_id = ?2 \
               AND owner.type = 'page' AND owner.lifecycle = 'active' \
             ORDER BY reference.owner_block_id",
        )?
        .query_map(params![library_id, file_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn require_active_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(), StoreError> {
    let active = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM pages page JOIN blocks block ON block.id = page.block_id \
           WHERE page.block_id = ?1 AND page.library_id = ?2 \
             AND block.library_id = ?2 AND block.lifecycle = 'active')",
        params![page_id, library_id],
        |row| row.get::<_, bool>(0),
    )?;
    if active {
        return Ok(());
    }
    Err(conflict("Target Page is no longer active"))
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
