//! Explicit Page paths reference Library Files. A path mutation never changes
//! the target File's name, content, lifecycle, or revision.

use nodex_core_contracts::library::LibraryPageFileEntry;
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::file_path::PortablePageFilePath;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EntryReplacement {
    pub(super) file_id: String,
    pub(super) logical_path: String,
}

/// Captured Page paths are immutable structural evidence. Replaying a copy
/// uses these paths even when the source Page has since changed its namespace.
pub(super) fn capture(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Vec<EntryReplacement>, StoreError> {
    Ok(connection
        .prepare("SELECT file_id, logical_path FROM page_file_entries WHERE library_id = ?1 AND page_id = ?2 ORDER BY file_id")?
        .query_map(params![library_id, page_id], |row| Ok(EntryReplacement {
            file_id: row.get(0)?,
            logical_path: row.get(1)?,
        }))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn initialize_captured(
    context: &EntryWriteContext<'_>,
    entries: &[EntryReplacement],
) -> Result<i64, StoreError> {
    if context.expected_revision != 0 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Page copy requires a fresh namespace",
        ));
    }
    require_revision(context)?;
    for entry in entries {
        require_live_file(context, &entry.file_id)?;
        let path = PortablePageFilePath::parse(&entry.logical_path)?;
        require_path_excluding(context, &path, "[]")?;
        context.connection.execute(
            "INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![context.page_id, context.library_id, entry.file_id, path.display(), path.collision_key()],
        )?;
    }
    if entries.is_empty() {
        return Ok(0);
    }
    advance_revision(context)?;
    Ok(1)
}

/// Applies one final namespace, so a batch can swap paths without publishing
/// intermediate collisions. The caller supplies existing entries to remove;
/// replacement IDs must either be among those entries or be new to this Page.
pub(super) fn replace_batch(
    context: &EntryWriteContext<'_>,
    removed_file_ids: &[String],
    replacements: &[EntryReplacement],
) -> Result<i64, StoreError> {
    use std::collections::BTreeSet;
    require_revision(context)?;
    if removed_file_ids.len() > 100 || replacements.len() > 100 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "A Page File batch supports at most 100 entries",
        ));
    }
    let removed = removed_file_ids.iter().collect::<BTreeSet<_>>();
    if removed.len() != removed_file_ids.len() {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "A Page File batch contains duplicate removals",
        ));
    }
    let originals = removed_file_ids
        .iter()
        .map(|file_id| {
            resolve(
                context.connection,
                context.library_id,
                context.page_id,
                file_id,
            )
            .map(|entry| (entry.file_id, entry.logical_path))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
    let mut replacement_ids = BTreeSet::new();
    let mut paths: Vec<PortablePageFilePath> = Vec::with_capacity(replacements.len());
    let removed_json = serde_json::to_string(removed_file_ids).map_err(|_| {
        error(
            StoreErrorCode::Internal,
            "Page File entry batch cannot be encoded",
        )
    })?;
    for replacement in replacements {
        require_live_file(context, &replacement.file_id)?;
        if !replacement_ids.insert(&replacement.file_id) {
            return Err(error(
                StoreErrorCode::Conflict,
                "A File can have only one path in a Page",
            ));
        }
        let occupied = context.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE page_id = ?1 AND file_id = ?2)",
            params![context.page_id, replacement.file_id],
            |row| row.get::<_, bool>(0),
        )?;
        if occupied && !removed.contains(&replacement.file_id) {
            return Err(error(
                StoreErrorCode::Conflict,
                "The File already has a path in this Page",
            ));
        }
        let path = PortablePageFilePath::parse(&replacement.logical_path)?;
        if paths
            .iter()
            .any(|other| paths_collide(path.collision_key(), other.collision_key()))
        {
            return Err(error(StoreErrorCode::Conflict, "Page File paths overlap"));
        }
        require_path_excluding(context, &path, &removed_json)?;
        paths.push(path);
    }
    if removed_file_ids.is_empty() && replacements.is_empty() {
        return Ok(context.expected_revision);
    }
    if originals.len() == replacements.len()
        && replacements.iter().zip(&paths).all(|(replacement, path)| {
            originals
                .get(&replacement.file_id)
                .is_some_and(|old| old == path.display())
        })
    {
        return Ok(context.expected_revision);
    }
    context.connection.execute(
        "DELETE FROM page_file_entries WHERE page_id = ?1 AND library_id = ?2
           AND file_id IN (SELECT value FROM json_each(?3))",
        params![context.page_id, context.library_id, removed_json],
    )?;
    for (replacement, path) in replacements.iter().zip(paths) {
        context.connection.execute(
            "INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![context.page_id, context.library_id, replacement.file_id, path.display(), path.collision_key()],
        )?;
    }
    advance_revision(context)?;
    Ok(context.expected_revision + 1)
}

fn paths_collide(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(super) fn allocate_path(
    context: &EntryWriteContext<'_>,
    preferred: &str,
    removed_file_ids: &[String],
    replacements: &[EntryReplacement],
    policy: nodex_core_contracts::library::LibraryPageFileCollisionPolicy,
) -> Result<String, StoreError> {
    let preferred = PortablePageFilePath::parse(preferred)?;
    let excluded = serde_json::to_string(removed_file_ids).map_err(|_| {
        error(
            StoreErrorCode::Internal,
            "Page File path exclusions cannot be encoded",
        )
    })?;
    let assigned = replacements
        .iter()
        .map(|entry| PortablePageFilePath::parse(&entry.logical_path))
        .collect::<Result<Vec<_>, _>>()?;
    let ancestors = preferred
        .collision_key()
        .match_indices('/')
        .map(|(index, _)| &preferred.collision_key()[..index])
        .collect::<Vec<_>>();
    let ancestor_keys = serde_json::to_string(&ancestors).map_err(|_| {
        error(
            StoreErrorCode::Internal,
            "Page File path ancestors cannot be encoded",
        )
    })?;
    let blocked_parent = context.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE page_id = ?1 AND library_id = ?2
           AND file_id NOT IN (SELECT value FROM json_each(?3)) AND path_key IN (SELECT value FROM json_each(?4)))",
        params![context.page_id, context.library_id, excluded, ancestor_keys], |row| row.get::<_, bool>(0),
    )? || assigned.iter().any(|path| ancestors.contains(&path.collision_key()));
    if blocked_parent {
        return Err(error(
            StoreErrorCode::Conflict,
            "A parent of this path is already a File",
        ));
    }
    let (directory, basename) = preferred
        .display()
        .rsplit_once('/')
        .unwrap_or(("", preferred.display()));
    let (stem, extension) = basename
        .rfind('.')
        .filter(|index| *index > 0)
        .map_or((basename, ""), |index| basename.split_at(index));
    for number in 1..=10_000 {
        let candidate = if number == 1 {
            preferred.display().to_owned()
        } else {
            crate::domain::file_path::suffixed_path(
                directory,
                stem,
                extension,
                &format!(" ({number})"),
            )
            .ok_or_else(|| {
                error(
                    StoreErrorCode::Conflict,
                    "Page File path has no room for a suffix",
                )
            })?
        };
        let path = PortablePageFilePath::parse(&candidate)?;
        let available = require_path_excluding(context, &path, &excluded);
        let assigned_collision = assigned
            .iter()
            .any(|other| paths_collide(path.collision_key(), other.collision_key()));
        if available.is_ok() && !assigned_collision {
            return Ok(candidate);
        }
        if let Err(failure) = available
            && failure.code != StoreErrorCode::Conflict
        {
            return Err(failure);
        }
        if policy == nodex_core_contracts::library::LibraryPageFileCollisionPolicy::Reject {
            return Err(error(
                StoreErrorCode::Conflict,
                "Page File path overlaps an existing entry",
            ));
        }
    }
    Err(error(
        StoreErrorCode::Conflict,
        "Page File path namespace is exhausted",
    ))
}

fn require_path_excluding(
    context: &EntryWriteContext<'_>,
    path: &PortablePageFilePath,
    excluded_json: &str,
) -> Result<(), StoreError> {
    let key = path.collision_key();
    let ancestors = key
        .match_indices('/')
        .map(|(index, _)| &key[..index])
        .collect::<Vec<_>>();
    let ancestors = serde_json::to_string(&ancestors)
        .map_err(|_| error(StoreErrorCode::Internal, "Page File path cannot be encoded"))?;
    let collision = context.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE page_id = ?1 AND library_id = ?2
           AND file_id NOT IN (SELECT value FROM json_each(?3))
           AND (path_key = ?4 OR (path_key >= ?5 AND path_key < ?6)
             OR path_key IN (SELECT value FROM json_each(?7))))",
        params![
            context.page_id,
            context.library_id,
            excluded_json,
            key,
            format!("{key}/"),
            format!("{key}0"),
            ancestors
        ],
        |row| row.get::<_, bool>(0),
    )?;
    if collision {
        return Err(error(
            StoreErrorCode::Conflict,
            "Page File path overlaps an existing entry",
        ));
    }
    Ok(())
}

pub(super) struct EntryWriteContext<'a> {
    pub(super) connection: &'a Connection,
    pub(super) library_id: &'a str,
    pub(super) page_id: &'a str,
    pub(super) expected_revision: i64,
    pub(super) now: &'a str,
}

/// Whole-Page copy duplicates its explicit namespace and shares File targets.
/// The caller has already authorized and staged the source/destination Pages.
pub(super) fn copy_for_pages(
    connection: &Connection,
    library_id: &str,
    page_ids: &std::collections::BTreeMap<String, String>,
    now: &str,
) -> Result<std::collections::BTreeMap<String, i64>, StoreError> {
    let mut revisions = std::collections::BTreeMap::new();
    for (source, target) in page_ids {
        if source == target {
            return Err(error(
                StoreErrorCode::InvalidInput,
                "Page copy requires a fresh target",
            ));
        }
        let context = EntryWriteContext {
            connection,
            library_id,
            page_id: target,
            expected_revision: 0,
            now,
        };
        let entries = capture(connection, library_id, source)?;
        let revision = initialize_captured(&context, &entries)?;
        if revision == 0 {
            continue;
        }
        revisions.insert(target.clone(), revision);
    }
    Ok(revisions)
}

pub(super) fn resolve(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    file_id: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    connection
        .query_row(
            "SELECT page_id, file_id, logical_path FROM page_file_entries \
         WHERE page_id = ?1 AND file_id = ?2 AND library_id = ?3",
            params![page_id, file_id, library_id],
            |row| {
                Ok(LibraryPageFileEntry {
                    page_id: row.get(0)?,
                    file_id: row.get(1)?,
                    logical_path: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| error(StoreErrorCode::NotFound, "Page File entry is unavailable"))
}

pub(super) fn resolve_path(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    logical_path: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    let path = PortablePageFilePath::parse(logical_path)?;
    let file_id = connection.query_row(
        "SELECT file_id FROM page_file_entries WHERE page_id = ?1 AND path_key = ?2 AND library_id = ?3",
        params![page_id, path.collision_key(), library_id],
        |row| row.get::<_, String>(0),
    ).optional()?.ok_or_else(|| error(StoreErrorCode::NotFound, "Page File path is unavailable"))?;
    resolve(connection, library_id, page_id, &file_id)
}

pub(super) fn add(
    context: &EntryWriteContext<'_>,
    file_id: &str,
    logical_path: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    require_revision(context)?;
    require_live_file(context, file_id)?;
    let path = PortablePageFilePath::parse(logical_path)?;
    require_available_path(context, &path, None)?;
    let exists = context.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE page_id = ?1 AND file_id = ?2)",
        params![context.page_id, file_id],
        |row| row.get::<_, bool>(0),
    )?;
    if exists {
        return Err(error(
            StoreErrorCode::Conflict,
            "File already has a path in this Page",
        ));
    }
    context.connection.execute(
        "INSERT INTO page_file_entries(page_id, library_id, file_id, logical_path, path_key) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            context.page_id,
            context.library_id,
            file_id,
            path.display(),
            path.collision_key()
        ],
    )?;
    advance_revision(context)?;
    resolve(
        context.connection,
        context.library_id,
        context.page_id,
        file_id,
    )
}

#[cfg(test)]
pub(super) fn rename(
    context: &EntryWriteContext<'_>,
    file_id: &str,
    logical_path: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    require_revision(context)?;
    let entry = resolve(
        context.connection,
        context.library_id,
        context.page_id,
        file_id,
    )?;
    let path = PortablePageFilePath::parse(logical_path)?;
    if entry.logical_path == path.display() {
        return Ok(entry);
    }
    require_available_path(context, &path, Some(file_id))?;
    context.connection.execute(
        "UPDATE page_file_entries SET logical_path = ?1, path_key = ?2 \
         WHERE page_id = ?3 AND file_id = ?4 AND library_id = ?5",
        params![
            path.display(),
            path.collision_key(),
            context.page_id,
            file_id,
            context.library_id
        ],
    )?;
    advance_revision(context)?;
    resolve(
        context.connection,
        context.library_id,
        context.page_id,
        file_id,
    )
}

pub(super) fn remove(
    context: &EntryWriteContext<'_>,
    file_id: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    require_revision(context)?;
    let entry = resolve(
        context.connection,
        context.library_id,
        context.page_id,
        file_id,
    )?;
    context.connection.execute(
        "DELETE FROM page_file_entries WHERE page_id = ?1 AND file_id = ?2 AND library_id = ?3",
        params![context.page_id, file_id, context.library_id],
    )?;
    advance_revision(context)?;
    Ok(entry)
}

#[cfg(test)]
pub(super) fn retarget(
    context: &EntryWriteContext<'_>,
    file_id: &str,
    replacement_file_id: &str,
) -> Result<LibraryPageFileEntry, StoreError> {
    require_revision(context)?;
    let entry = resolve(
        context.connection,
        context.library_id,
        context.page_id,
        file_id,
    )?;
    if file_id == replacement_file_id {
        return Ok(entry);
    }
    require_live_file(context, replacement_file_id)?;
    let occupied = context.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_file_entries WHERE page_id = ?1 AND file_id = ?2)",
        params![context.page_id, replacement_file_id],
        |row| row.get::<_, bool>(0),
    )?;
    if occupied {
        return Err(error(
            StoreErrorCode::Conflict,
            "Replacement File already has a path in this Page",
        ));
    }
    context.connection.execute(
        "UPDATE page_file_entries SET file_id = ?1 WHERE page_id = ?2 AND file_id = ?3 AND library_id = ?4",
        params![replacement_file_id, context.page_id, file_id, context.library_id],
    )?;
    advance_revision(context)?;
    resolve(
        context.connection,
        context.library_id,
        context.page_id,
        replacement_file_id,
    )
}

pub(super) fn transfer(
    source: &EntryWriteContext<'_>,
    target: &EntryWriteContext<'_>,
    file_id: &str,
    logical_path: &str,
    copy: bool,
) -> Result<LibraryPageFileEntry, StoreError> {
    if source.library_id != target.library_id || source.page_id == target.page_id {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Entry transfer requires different Pages in one Library",
        ));
    }
    if !std::ptr::eq(source.connection, target.connection) || source.connection.is_autocommit() {
        return Err(error(
            StoreErrorCode::Internal,
            "Entry transfer requires one outer transaction",
        ));
    }
    require_revision(source)?;
    resolve(
        source.connection,
        source.library_id,
        source.page_id,
        file_id,
    )?;
    let entry = add(target, file_id, logical_path)?;
    if !copy {
        remove(source, file_id)?;
    }
    Ok(entry)
}

fn require_live_file(context: &EntryWriteContext<'_>, file_id: &str) -> Result<(), StoreError> {
    let file = super::files::metadata(context.connection, context.library_id, file_id)?;
    if file.lifecycle != nodex_core_contracts::library::LibraryFileLifecycle::Live {
        return Err(error(
            StoreErrorCode::Conflict,
            "Restore the File before adding it to a Page",
        ));
    }
    Ok(())
}

pub(super) fn require_revision(context: &EntryWriteContext<'_>) -> Result<(), StoreError> {
    if context.connection.is_autocommit() {
        return Err(error(
            StoreErrorCode::Internal,
            "Page entry writes require an outer transaction",
        ));
    }
    let revision = context.connection.query_row(
        "SELECT manifest.revision FROM page_file_manifests manifest \
         JOIN blocks block ON block.id = manifest.page_id AND block.library_id = manifest.library_id \
         WHERE manifest.page_id = ?1 AND manifest.library_id = ?2 AND block.lifecycle = 'active'",
        params![context.page_id, context.library_id], |row| row.get::<_, i64>(0),
    ).optional()?.ok_or_else(|| error(StoreErrorCode::NotFound, "Page is unavailable"))?;
    if revision != context.expected_revision {
        return Err(error(
            StoreErrorCode::RevisionConflict,
            "Page File manifest revision changed",
        ));
    }
    Ok(())
}

fn advance_revision(context: &EntryWriteContext<'_>) -> Result<(), StoreError> {
    let changed = context.connection.execute(
        "UPDATE page_file_manifests SET revision = revision + 1, updated_at = ?1 \
         WHERE page_id = ?2 AND library_id = ?3 AND revision = ?4",
        params![
            context.now,
            context.page_id,
            context.library_id,
            context.expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(error(
            StoreErrorCode::RevisionConflict,
            "Page File manifest revision changed",
        ));
    }
    Ok(())
}

fn require_available_path(
    context: &EntryWriteContext<'_>,
    path: &PortablePageFilePath,
    excluded_file_id: Option<&str>,
) -> Result<(), StoreError> {
    let excluded = serde_json::to_string(&excluded_file_id.into_iter().collect::<Vec<_>>())
        .map_err(|_| {
            error(
                StoreErrorCode::Internal,
                "Page File path exclusion cannot be encoded",
            )
        })?;
    require_path_excluding(context, path, &excluded)
}

fn error(code: StoreErrorCode, message: &'static str) -> StoreError {
    StoreError::new(code, message, code == StoreErrorCode::RevisionConflict)
}
