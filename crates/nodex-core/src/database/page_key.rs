use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::page_key::{
    MAX_PAGE_KEY_PREFIX_LENGTH, PageKeyParseError, PageKeyPrefix, ParsedPageKey,
    parse_page_key_search_candidates, suggest_page_key_prefix,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// Automatic suggestions deliberately search a finite human-scale suffix
/// space. This keeps preview/create latency independent of Library history and
/// turns exhaustion into an explicit domain error instead of an unbounded SQL
/// probe loop.
const MAX_SUGGESTED_PREFIX_ORDINAL: i64 = 999;
const MAX_SUGGESTED_PREFIX_FAMILY_ROWS: i64 = 1 + 10 + 100 + 1_000;
const CURRENT_PAGE_KEY_PAGE_JOINS: &str = "FROM pages page \
             JOIN data_sources source ON page.parent_kind = 'data_source' AND source.id = page.parent_id \
             JOIN page_key_namespaces namespace ON namespace.database_block_id = source.home_database_block_id \
               AND namespace.library_id = page.library_id \
             JOIN page_key_prefixes prefix ON prefix.database_block_id = namespace.database_block_id \
               AND prefix.library_id = namespace.library_id AND prefix.retired_at IS NULL \
             JOIN page_key_assignments assignment ON assignment.database_block_id = namespace.database_block_id \
               AND assignment.page_block_id = page.block_id ";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageKeyNamespaceSnapshot {
    pub(crate) database_block_id: String,
    pub(crate) library_id: String,
    pub(crate) current_prefix: String,
    pub(crate) next_number: i64,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageKeyAssignment {
    pub(crate) database_block_id: String,
    pub(crate) page_block_id: String,
    pub(crate) number: i64,
    pub(crate) current_page_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageKeyResolution {
    pub(crate) page_block_id: String,
    pub(crate) matched_page_key: String,
    pub(crate) current_page_key: Option<String>,
    pub(crate) matched_database_block_id: String,
    pub(crate) current_database_block_id: Option<String>,
    pub(crate) page_lifecycle: String,
    pub(crate) is_current: bool,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UniquePageKeyResolution {
    NotFound,
    Ambiguous,
    Resolved(PageKeyResolution),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PageKeyPrefixAvailability {
    Available,
    Current,
    Reserved,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageKeyPrefixPreview {
    pub(crate) prefix: String,
    pub(crate) availability: PageKeyPrefixAvailability,
    pub(crate) alternative_prefix: Option<String>,
    pub(crate) next_number: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RetiredPageKeyPrefixSnapshot {
    pub(crate) prefix: String,
    pub(crate) last_number: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageKeyNamespaceSettingsSnapshot {
    pub(crate) current_prefix: String,
    pub(crate) next_number: i64,
    pub(crate) assigned_page_count: i64,
    pub(crate) revision: i64,
    pub(crate) retired_prefixes: Vec<RetiredPageKeyPrefixSnapshot>,
}

/// Previews the same collision-free prefix that namespace creation uses.
/// This is intentionally a pure read: the create/update transaction remains
/// the final authority if another writer claims the prefix after this call.
pub(crate) fn preview_page_key_prefix(
    connection: &Connection,
    library_id: &str,
    project_name: &str,
    requested_prefix: Option<&str>,
    owner_database_id: Option<&str>,
) -> Result<PageKeyPrefixPreview, StoreError> {
    let owner_namespace = owner_database_id
        .map(|database_id| current_page_key_namespace(connection, library_id, database_id))
        .transpose()?
        .flatten();
    let next_number = owner_namespace
        .as_ref()
        .map_or(1, |namespace| namespace.next_number);

    let Some(requested_prefix) = requested_prefix else {
        let prefix = available_suggested_prefix(connection, library_id, project_name)?;
        return Ok(PageKeyPrefixPreview {
            prefix: prefix.into_string(),
            availability: PageKeyPrefixAvailability::Available,
            alternative_prefix: None,
            next_number,
        });
    };

    let requested = parse_requested_prefix(requested_prefix)?;
    let registered_owner = prefix_owner(connection, library_id, requested.as_str())?;
    let availability = match registered_owner.as_deref() {
        None => PageKeyPrefixAvailability::Available,
        Some(owner) if Some(owner) == owner_database_id => PageKeyPrefixAvailability::Current,
        Some(_) => PageKeyPrefixAvailability::Reserved,
    };
    let alternative_prefix = if availability == PageKeyPrefixAvailability::Reserved {
        Some(available_suggested_prefix(connection, library_id, requested.as_str())?.into_string())
    } else {
        None
    };
    Ok(PageKeyPrefixPreview {
        prefix: requested.into_string(),
        availability,
        alternative_prefix,
        next_number,
    })
}

pub(crate) fn page_key_namespace_settings(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
) -> Result<Option<PageKeyNamespaceSettingsSnapshot>, StoreError> {
    let Some(namespace) = current_page_key_namespace(connection, library_id, database_block_id)?
    else {
        return Ok(None);
    };
    let assigned_page_count = connection.query_row(
        "SELECT count(*) FROM page_key_assignments WHERE database_block_id = ?1",
        [database_block_id],
        |row| row.get::<_, i64>(0),
    )?;
    let retired_prefixes = connection
        .prepare(
            "SELECT normalized_prefix, last_number FROM page_key_prefixes \
             WHERE library_id = ?1 AND database_block_id = ?2 AND retired_at IS NOT NULL \
             ORDER BY activated_at, normalized_prefix",
        )?
        .query_map(params![library_id, database_block_id], |row| {
            Ok(RetiredPageKeyPrefixSnapshot {
                prefix: row.get(0)?,
                last_number: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(PageKeyNamespaceSettingsSnapshot {
        current_prefix: namespace.current_prefix,
        next_number: namespace.next_number,
        assigned_page_count,
        revision: namespace.revision,
        retired_prefixes,
    }))
}

/// Creates the Database-owned namespace. The caller must already own the
/// surrounding durable transaction.
pub(crate) fn create_page_key_namespace(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
    requested_prefix: Option<&str>,
    project_name: &str,
    now: &str,
) -> Result<PageKeyNamespaceSnapshot, StoreError> {
    require_database_in_library(connection, library_id, database_block_id)?;
    if namespace_exists(connection, database_block_id)? {
        return Err(conflict(format!(
            "Database {database_block_id} already has a Page-key namespace"
        )));
    }
    let prefix = match requested_prefix {
        Some(prefix) => {
            let prefix = parse_requested_prefix(prefix)?;
            require_prefix_available(connection, library_id, &prefix, database_block_id)?;
            prefix
        }
        None => available_suggested_prefix(connection, library_id, project_name)?,
    };

    connection.execute(
        "INSERT INTO page_key_namespaces(\
           database_block_id, library_id, next_number, revision, created_at, updated_at\
         ) VALUES (?1, ?2, 1, 1, ?3, ?3)",
        params![database_block_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO page_key_prefixes(\
           library_id, normalized_prefix, database_block_id, last_number, revision, \
           activated_at, retired_at\
         ) VALUES (?1, ?2, ?3, NULL, 1, ?4, NULL)",
        params![library_id, prefix.as_str(), database_block_id, now],
    )?;
    Ok(PageKeyNamespaceSnapshot {
        database_block_id: database_block_id.to_owned(),
        library_id: library_id.to_owned(),
        current_prefix: prefix.into_string(),
        next_number: 1,
        revision: 1,
    })
}

/// Renames the current prefix with a namespace revision CAS. Retired prefixes
/// retain the largest number that was visible while they were active. The
/// caller must already own the surrounding durable transaction.
pub(crate) fn rename_page_key_prefix(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
    expected_revision: i64,
    requested_prefix: &str,
    now: &str,
) -> Result<PageKeyNamespaceSnapshot, StoreError> {
    let current = current_page_key_namespace(connection, library_id, database_block_id)?
        .ok_or_else(|| not_found("Page-key namespace is not enabled for this Database"))?;
    if current.revision != expected_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            format!(
                "Page-key namespace is at revision {}, not {expected_revision}",
                current.revision
            ),
            false,
        ));
    }
    let requested = parse_requested_prefix(requested_prefix)?;
    if requested.as_str() == current.current_prefix {
        return Ok(current);
    }
    require_prefix_available(connection, library_id, &requested, database_block_id)?;

    let target_prefix = connection
        .query_row(
            "SELECT database_block_id, retired_at \
             FROM page_key_prefixes \
             WHERE library_id = ?1 AND normalized_prefix = ?2",
            params![library_id, requested.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if target_prefix
        .as_ref()
        .is_some_and(|(owner, _)| owner != database_block_id)
    {
        return Err(prefix_conflict(requested.as_str()));
    }

    let last_assigned = current
        .next_number
        .checked_sub(1)
        .ok_or_else(|| corrupt("Page-key namespace next_number is outside its valid range"))?;
    if last_assigned == 0 {
        connection.execute(
            "DELETE FROM page_key_prefixes \
             WHERE library_id = ?1 AND normalized_prefix = ?2 \
               AND database_block_id = ?3 AND retired_at IS NULL",
            params![library_id, current.current_prefix, database_block_id],
        )?;
    } else {
        let retired = connection.execute(
            "UPDATE page_key_prefixes \
             SET last_number = ?1, retired_at = ?2, revision = revision + 1 \
             WHERE library_id = ?3 AND normalized_prefix = ?4 \
               AND database_block_id = ?5 AND retired_at IS NULL",
            params![
                last_assigned,
                now,
                library_id,
                current.current_prefix,
                database_block_id
            ],
        )?;
        if retired != 1 {
            return Err(corrupt("Page-key namespace has no unique current prefix"));
        }
    }

    match target_prefix {
        Some((_, retired_at)) => {
            if retired_at.is_none() {
                return Err(corrupt(
                    "Page-key prefix registry contains two current prefixes",
                ));
            }
            connection.execute(
                "UPDATE page_key_prefixes \
                 SET last_number = NULL, activated_at = ?1, retired_at = NULL, \
                   revision = revision + 1 \
                 WHERE library_id = ?2 AND normalized_prefix = ?3 \
                   AND database_block_id = ?4",
                params![now, library_id, requested.as_str(), database_block_id],
            )?;
        }
        None => {
            connection.execute(
                "INSERT INTO page_key_prefixes(\
                   library_id, normalized_prefix, database_block_id, last_number, revision, \
                   activated_at, retired_at\
                 ) VALUES (?1, ?2, ?3, NULL, 1, ?4, NULL)",
                params![library_id, requested.as_str(), database_block_id, now],
            )?;
        }
    }

    let updated = connection.execute(
        "UPDATE page_key_namespaces \
         SET revision = revision + 1, updated_at = ?1 \
         WHERE database_block_id = ?2 AND library_id = ?3 AND revision = ?4",
        params![now, database_block_id, library_id, expected_revision],
    )?;
    if updated != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Page-key namespace revision changed during prefix rename",
            false,
        ));
    }
    current_page_key_namespace(connection, library_id, database_block_id)?
        .ok_or_else(|| corrupt("Page-key namespace disappeared during prefix rename"))
}

/// Ensures an immutable `(Database, Page) -> number` assignment. Disabled
/// standalone Databases return `None`. The caller must own the transaction so
/// assignment and counter changes commit or roll back together.
pub(crate) fn ensure_database_page_key(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
    page_block_id: &str,
    now: &str,
) -> Result<Option<PageKeyAssignment>, StoreError> {
    require_database_in_library(connection, library_id, database_block_id)?;
    require_page_in_library(connection, library_id, page_block_id)?;
    let Some(namespace) = current_page_key_namespace(connection, library_id, database_block_id)?
    else {
        return Ok(None);
    };
    require_page_database_membership_history(
        connection,
        library_id,
        database_block_id,
        page_block_id,
    )?;
    let existing = connection
        .query_row(
            "SELECT number FROM page_key_assignments \
             WHERE database_block_id = ?1 AND page_block_id = ?2",
            params![database_block_id, page_block_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(number) = existing {
        return Ok(Some(PageKeyAssignment {
            database_block_id: database_block_id.to_owned(),
            page_block_id: page_block_id.to_owned(),
            number,
            current_page_key: format_page_key(&namespace.current_prefix, number),
        }));
    }

    let number = namespace.next_number;
    let Some(next_number) = number.checked_add(1) else {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            format!("Page-key namespace for Database {database_block_id} is exhausted"),
            false,
        ));
    };
    connection.execute(
        "INSERT INTO page_key_assignments(\
           database_block_id, page_block_id, number, assigned_at\
         ) VALUES (?1, ?2, ?3, ?4)",
        params![database_block_id, page_block_id, number, now],
    )?;
    let updated = connection.execute(
        "UPDATE page_key_namespaces SET next_number = ?1, updated_at = ?2 \
         WHERE database_block_id = ?3 AND library_id = ?4 AND next_number = ?5",
        params![next_number, now, database_block_id, library_id, number],
    )?;
    if updated != 1 {
        return Err(conflict(
            "Page-key counter changed during allocation; retry the enclosing mutation",
        ));
    }
    Ok(Some(PageKeyAssignment {
        database_block_id: database_block_id.to_owned(),
        page_block_id: page_block_id.to_owned(),
        number,
        current_page_key: format_page_key(&namespace.current_prefix, number),
    }))
}

pub(crate) fn current_page_key_namespace(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
) -> Result<Option<PageKeyNamespaceSnapshot>, StoreError> {
    require_database_in_library(connection, library_id, database_block_id)?;
    let namespace = connection
        .query_row(
            "SELECT namespace.database_block_id, namespace.library_id, \
               prefix.normalized_prefix, namespace.next_number, namespace.revision \
             FROM page_key_namespaces namespace \
             JOIN page_key_prefixes prefix \
               ON prefix.database_block_id = namespace.database_block_id \
              AND prefix.library_id = namespace.library_id \
              AND prefix.retired_at IS NULL \
             WHERE namespace.database_block_id = ?1 AND namespace.library_id = ?2",
            params![database_block_id, library_id],
            |row| {
                Ok(PageKeyNamespaceSnapshot {
                    database_block_id: row.get(0)?,
                    library_id: row.get(1)?,
                    current_prefix: row.get(2)?,
                    next_number: row.get(3)?,
                    revision: row.get(4)?,
                })
            },
        )
        .optional()?;
    if namespace.is_some() || !namespace_exists(connection, database_block_id)? {
        return Ok(namespace);
    }
    Err(corrupt("Page-key namespace has no unique current prefix"))
}

pub(crate) fn current_page_key_for_page(
    connection: &Connection,
    library_id: &str,
    page_block_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            &format!(
                "SELECT prefix.normalized_prefix, assignment.number {CURRENT_PAGE_KEY_PAGE_JOINS} \
                 WHERE page.block_id = ?1 AND page.library_id = ?2"
            ),
            params![page_block_id, library_id],
            |row| {
                Ok(format_page_key(
                    &row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                ))
            },
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn current_page_keys_in_library(
    connection: &Connection,
    library_id: &str,
) -> Result<HashMap<String, String>, StoreError> {
    connection
        .prepare(&format!(
            "SELECT page.block_id, prefix.normalized_prefix, assignment.number \
                 {CURRENT_PAGE_KEY_PAGE_JOINS} WHERE page.library_id = ?1"
        ))?
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                format_page_key(&row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
            ))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(StoreError::from)
}

pub(crate) fn current_page_key_for_database_page(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
    page_block_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT prefix.normalized_prefix, assignment.number \
             FROM page_key_namespaces namespace \
             JOIN page_key_prefixes prefix \
               ON prefix.database_block_id = namespace.database_block_id \
              AND prefix.library_id = namespace.library_id \
              AND prefix.retired_at IS NULL \
             JOIN page_key_assignments assignment \
               ON assignment.database_block_id = namespace.database_block_id \
             JOIN pages page \
               ON page.block_id = assignment.page_block_id \
              AND page.library_id = namespace.library_id \
             WHERE namespace.database_block_id = ?1 AND namespace.library_id = ?2 \
               AND assignment.page_block_id = ?3",
            params![database_block_id, library_id, page_block_id],
            |row| {
                Ok(format_page_key(
                    &row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                ))
            },
        )
        .optional()
        .map_err(StoreError::from)
}

/// Resolves canonical candidates in the current Library before applying explicit
/// query selection and lifecycle rules. Project is a locator coordinate.
pub(crate) fn resolve_page_key_matches_in_library(
    connection: &Connection,
    library_id: &str,
    raw_page_key: &str,
) -> Result<Vec<PageKeyResolution>, StoreError> {
    let candidates = parse_page_key_search_candidates(raw_page_key);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut best_by_page = HashMap::<String, (usize, PageKeyResolution)>::new();
    for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if let Some(resolution) = resolve_parsed_page_key(connection, library_id, &candidate)? {
            match best_by_page.get_mut(&resolution.page_block_id) {
                Some((stored_index, stored)) if resolution.is_current && !stored.is_current => {
                    *stored_index = candidate_index;
                    *stored = resolution;
                }
                Some(_) => {}
                None => {
                    best_by_page.insert(
                        resolution.page_block_id.clone(),
                        (candidate_index, resolution),
                    );
                }
            }
        }
    }
    let mut resolutions = best_by_page.into_values().collect::<Vec<_>>();
    resolutions.sort_by(|(left_index, left), (right_index, right)| {
        left_index
            .cmp(right_index)
            .then_with(|| right.is_current.cmp(&left.is_current))
            .then_with(|| left.page_block_id.cmp(&right.page_block_id))
    });
    Ok(resolutions
        .into_iter()
        .map(|(_, resolution)| resolution)
        .collect())
}

#[cfg(test)]
pub(crate) fn resolve_unique_page_key_in_library(
    connection: &Connection,
    library_id: &str,
    raw_page_key: &str,
) -> Result<UniquePageKeyResolution, StoreError> {
    let mut resolutions =
        resolve_page_key_matches_in_library(connection, library_id, raw_page_key)?;
    Ok(match resolutions.len() {
        0 => UniquePageKeyResolution::NotFound,
        1 => UniquePageKeyResolution::Resolved(resolutions.pop().expect("one Page-key resolution")),
        _ => UniquePageKeyResolution::Ambiguous,
    })
}

fn resolve_parsed_page_key(
    connection: &Connection,
    library_id: &str,
    parsed: &ParsedPageKey,
) -> Result<Option<PageKeyResolution>, StoreError> {
    let matched_page_key = parsed.canonical();
    connection
        .query_row(
            "SELECT assignment.page_block_id, prefix.database_block_id, block.lifecycle, \
               current_source.home_database_block_id, current_prefix.normalized_prefix, \
               current_assignment.number \
             FROM page_key_prefixes prefix \
             JOIN page_key_assignments assignment \
               ON assignment.database_block_id = prefix.database_block_id \
              AND assignment.number = ?3 \
             JOIN pages page ON page.block_id = assignment.page_block_id \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id AND block.type = 'page' \
             LEFT JOIN data_sources current_source \
               ON page.parent_kind = 'data_source' AND current_source.id = page.parent_id \
             LEFT JOIN page_key_namespaces current_namespace \
               ON current_namespace.database_block_id = current_source.home_database_block_id \
              AND current_namespace.library_id = page.library_id \
             LEFT JOIN page_key_prefixes current_prefix \
               ON current_prefix.database_block_id = current_namespace.database_block_id \
              AND current_prefix.library_id = current_namespace.library_id \
              AND current_prefix.retired_at IS NULL \
             LEFT JOIN page_key_assignments current_assignment \
               ON current_assignment.database_block_id = current_namespace.database_block_id \
              AND current_assignment.page_block_id = page.block_id \
             WHERE prefix.library_id = ?1 AND prefix.normalized_prefix = ?2 \
               AND (prefix.retired_at IS NULL OR ?3 <= prefix.last_number)",
            params![library_id, parsed.normalized_prefix.as_str(), parsed.number],
            |row| {
                let page_block_id = row.get::<_, String>(0)?;
                let matched_database_block_id = row.get::<_, String>(1)?;
                let page_lifecycle = row.get::<_, String>(2)?;
                let current_database_block_id = row.get::<_, Option<String>>(3)?;
                let current_prefix = row.get::<_, Option<String>>(4)?;
                let current_number = row.get::<_, Option<i64>>(5)?;
                let current_page_key = current_prefix
                    .zip(current_number)
                    .map(|(prefix, number)| format_page_key(&prefix, number));
                let is_current = current_page_key.as_deref() == Some(matched_page_key.as_str());
                Ok(PageKeyResolution {
                    page_block_id,
                    matched_page_key: matched_page_key.clone(),
                    current_page_key,
                    matched_database_block_id,
                    current_database_block_id,
                    page_lifecycle,
                    is_current,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

fn available_suggested_prefix(
    connection: &Connection,
    library_id: &str,
    project_name: &str,
) -> Result<PageKeyPrefix, StoreError> {
    let base = suggest_page_key_prefix(project_name);
    if !prefix_exists(connection, library_id, base.as_str())? {
        return Ok(base);
    }

    let one_digit = format!("{}[0-9]", suggested_prefix_base(&base, 1)?);
    let two_digits = format!("{}[0-9][0-9]", suggested_prefix_base(&base, 2)?);
    let three_digits = format!("{}[0-9][0-9][0-9]", suggested_prefix_base(&base, 3)?);
    // GLOB also admits zero-padded suffixes. They are not candidates, but the
    // finite family maximum keeps them from truncating a later canonical key.
    let query_limit = MAX_SUGGESTED_PREFIX_FAMILY_ROWS;
    let reserved = connection
        .prepare(
            "SELECT normalized_prefix FROM page_key_prefixes \
             WHERE library_id = ?1 AND (normalized_prefix = ?2 \
               OR normalized_prefix GLOB ?3 \
               OR normalized_prefix GLOB ?4 \
               OR normalized_prefix GLOB ?5) \
             ORDER BY length(normalized_prefix), normalized_prefix \
             LIMIT ?6",
        )?
        .query_map(
            params![
                library_id,
                base.as_str(),
                one_digit,
                two_digits,
                three_digits,
                query_limit,
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<HashSet<_>>>()?;

    for ordinal in 2_i64..=MAX_SUGGESTED_PREFIX_ORDINAL {
        let suffix = ordinal.to_string();
        let candidate = format!("{}{suffix}", suggested_prefix_base(&base, suffix.len())?);
        let candidate = PageKeyPrefix::parse_requested(&candidate)
            .map_err(|_| corrupt("Suggested Page-key prefix is invalid"))?;
        if !reserved.contains(candidate.as_str()) {
            return Ok(candidate);
        }
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "No Page-key prefix remains available in this Library",
        false,
    ))
}

fn suggested_prefix_base(base: &PageKeyPrefix, suffix_length: usize) -> Result<&str, StoreError> {
    let available = MAX_PAGE_KEY_PREFIX_LENGTH
        .checked_sub(suffix_length)
        .filter(|available| *available > 0)
        .ok_or_else(|| corrupt("Suggested Page-key suffix exceeds the prefix bound"))?;
    Ok(&base.as_str()[..available.min(base.as_str().len())])
}

fn require_prefix_available(
    connection: &Connection,
    library_id: &str,
    prefix: &PageKeyPrefix,
    database_block_id: &str,
) -> Result<(), StoreError> {
    let owner = prefix_owner(connection, library_id, prefix.as_str())?;
    if owner.is_none() || owner.as_deref() == Some(database_block_id) {
        return Ok(());
    }
    Err(prefix_conflict(prefix.as_str()))
}

fn prefix_owner(
    connection: &Connection,
    library_id: &str,
    prefix: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT database_block_id FROM page_key_prefixes \
             WHERE library_id = ?1 AND normalized_prefix = ?2",
            params![library_id, prefix],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn prefix_exists(
    connection: &Connection,
    library_id: &str,
    prefix: &str,
) -> Result<bool, StoreError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM page_key_prefixes \
             WHERE library_id = ?1 AND normalized_prefix = ?2",
            params![library_id, prefix],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn namespace_exists(connection: &Connection, database_block_id: &str) -> Result<bool, StoreError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM page_key_namespaces WHERE database_block_id = ?1",
            [database_block_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn require_database_in_library(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM database_containers \
             WHERE block_id = ?1 AND library_id = ?2",
            params![database_block_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    Err(not_found("Database is not present in this Library"))
}

fn require_page_in_library(
    connection: &Connection,
    library_id: &str,
    page_block_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM pages WHERE block_id = ?1 AND library_id = ?2",
            params![page_block_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    Err(not_found("Page is not present in this Library"))
}

fn require_page_database_membership_history(
    connection: &Connection,
    library_id: &str,
    database_block_id: &str,
    page_block_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 \
             FROM data_source_page_memberships membership \
             JOIN data_sources source ON source.id = membership.data_source_id \
             WHERE membership.page_block_id = ?1 \
               AND source.home_database_block_id = ?2 \
               AND source.library_id = ?3 \
             LIMIT 1",
            params![page_block_id, database_block_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    Err(not_found("Page has no membership history in this Database"))
}

fn parse_requested_prefix(raw: &str) -> Result<PageKeyPrefix, StoreError> {
    PageKeyPrefix::parse_requested(raw).map_err(|error| match error {
        PageKeyParseError::InvalidPrefix | PageKeyParseError::InvalidPageKey => StoreError::new(
            StoreErrorCode::InvalidInput,
            "Project key must start with A-Z and contain 2-8 ASCII letters or digits",
            false,
        ),
    })
}

fn format_page_key(prefix: &str, number: i64) -> String {
    format!("{prefix}-{number}")
}

fn prefix_conflict(prefix: &str) -> StoreError {
    conflict(format!(
        "Page-key prefix {prefix} is already reserved in this Library"
    ))
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::{TempDir, tempdir};

    use crate::infrastructure::migration::prepare_profile_store;
    use crate::infrastructure::sqlite::{open_writer, with_immediate_transaction};

    use super::*;

    const NOW: &str = "2026-08-08T12:00:00.000Z";

    struct Fixture {
        _directory: TempDir,
        connection: Connection,
    }

    fn fixture() -> Fixture {
        let directory = tempdir().expect("Page-key Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        fs::create_dir_all(home.join("assets")).expect("assets");
        let mut connection = open_writer(&home.join("nodex.db")).expect("writer");
        prepare_profile_store(&mut connection, &home).expect("fresh store");
        with_immediate_transaction(&mut connection, |transaction| {
            crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
                transaction,
            )?;
            transaction.execute(
                "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                [NOW],
            )?;
            transaction.execute(
                "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                 VALUES ('library-1', 'profile-1', ?1, ?1)",
                [NOW],
            )?;
            transaction.execute(
                "INSERT INTO projects(id, name, created, updated, library_id) \
                 VALUES ('project-1', 'Lab', ?1, ?1, 'library-1')",
                [NOW],
            )?;
            seed_database(transaction, "database-1", "source-1")?;
            seed_database(transaction, "database-2", "source-2")?;
            seed_page(transaction, "page-1", "document-1", "source-1")?;
            seed_page(transaction, "page-2", "document-2", "source-1")?;
            seed_page(transaction, "page-3", "document-3", "source-1")?;
            Ok(())
        })
        .expect("seed authority");
        Fixture {
            _directory: directory,
            connection,
        }
    }

    fn seed_database(
        connection: &Connection,
        database_id: &str,
        source_id: &str,
    ) -> Result<(), StoreError> {
        connection.execute(
            "INSERT INTO blocks(\
               id, library_id, type, lifecycle, created_at, updated_at\
             ) VALUES (?1, 'library-1', 'database', 'active', ?2, ?2)",
            params![database_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO database_containers(\
               block_id, library_id, name, lifecycle, created_at, updated_at\
             ) VALUES (?1, 'library-1', ?1, 'active', ?2, ?2)",
            params![database_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO data_sources(\
               id, library_id, home_database_block_id, name, schema_key, lifecycle, \
               rank_key, created_at, updated_at\
             ) VALUES (?1, 'library-1', ?2, ?1, 'nodex.database', 'active', 'a', ?3, ?3)",
            params![source_id, database_id, NOW],
        )?;
        Ok(())
    }

    fn seed_page(
        connection: &Connection,
        page_id: &str,
        document_id: &str,
        source_id: &str,
    ) -> Result<(), StoreError> {
        connection.execute(
            "INSERT INTO documents(\
               id, library_id, schema_key, schema_version, created_at, updated_at\
             ) VALUES (?1, 'library-1', 'nodex.page', 3, ?2, ?2)",
            params![document_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO blocks(\
               id, library_id, type, lifecycle, created_at, updated_at\
             ) VALUES (?1, 'library-1', 'page', 'active', ?2, ?2)",
            params![page_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
             VALUES (?1, ?2, 'library-1', ?3)",
            params![page_id, document_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO pages(\
               block_id, library_id, document_id, parent_kind, parent_id, \
               created_at, updated_at\
             ) VALUES (?1, 'library-1', ?2, 'data_source', ?3, ?4, ?4)",
            params![page_id, document_id, source_id, NOW],
        )?;
        connection.execute(
            "INSERT INTO data_source_page_memberships(\
               id, data_source_id, page_block_id, created_at\
             ) VALUES (?1, ?2, ?3, ?4)",
            params![format!("membership-{page_id}"), source_id, page_id, NOW],
        )?;
        Ok(())
    }

    #[test]
    fn namespace_allocation_is_monotonic_idempotent_and_database_scoped() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            let namespace = create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                None,
                "Lab",
                NOW,
            )?;
            assert_eq!(namespace.current_prefix, "LAB");
            let first =
                ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)?
                    .expect("enabled namespace");
            let replay =
                ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)?
                    .expect("existing assignment");
            let second =
                ensure_database_page_key(transaction, "library-1", "database-1", "page-2", NOW)?
                    .expect("second assignment");
            assert_eq!(first.current_page_key, "LAB-1");
            assert_eq!(replay, first);
            assert_eq!(second.current_page_key, "LAB-2");
            assert!(
                ensure_database_page_key(transaction, "library-1", "database-2", "page-3", NOW,)?
                    .is_none()
            );
            Ok(())
        })
        .expect("allocate Page keys");
    }

    #[test]
    fn assignment_rejects_a_page_without_target_database_membership_history() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-2",
                Some("OPS"),
                "Operations",
                NOW,
            )?;
            let error =
                ensure_database_page_key(transaction, "library-1", "database-2", "page-1", NOW)
                    .expect_err("Page has never belonged to the target Database");
            assert_eq!(error.code, StoreErrorCode::NotFound);
            assert_eq!(
                transaction.query_row(
                    "SELECT next_number FROM page_key_namespaces \
                     WHERE database_block_id = 'database-2'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                1,
            );
            assert_eq!(
                transaction.query_row(
                    "SELECT count(*) FROM page_key_assignments \
                     WHERE database_block_id = 'database-2'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0,
            );
            Ok(())
        })
        .expect("reject assignment without Database membership history");
    }

    #[test]
    fn prefix_rename_retains_only_the_numbers_visible_under_the_old_prefix() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("lab"),
                "ignored",
                NOW,
            )?;
            for page_id in ["page-1", "page-2"] {
                ensure_database_page_key(transaction, "library-1", "database-1", page_id, NOW)?;
            }
            let stale = rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                2,
                "RND",
                "2026-08-08T12:01:00.000Z",
            )
            .expect_err("stale namespace revision");
            assert_eq!(stale.code, StoreErrorCode::RevisionConflict);
            let renamed = rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                1,
                "rnd",
                "2026-08-08T12:01:00.000Z",
            )?;
            assert_eq!(renamed.current_prefix, "RND");
            assert_eq!(renamed.revision, 2);
            let no_change = rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                2,
                "rnd",
                "2026-08-08T12:02:00.000Z",
            )?;
            assert_eq!(no_change.revision, 2);
            let third =
                ensure_database_page_key(transaction, "library-1", "database-1", "page-3", NOW)?
                    .expect("third assignment");
            assert_eq!(third.current_page_key, "RND-3");
            Ok(())
        })
        .expect("rename Page-key prefix");

        let UniquePageKeyResolution::Resolved(old) =
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "#lab-1")
                .expect("resolve old key")
        else {
            panic!("old alias");
        };
        assert_eq!(old.page_block_id, "page-1");
        assert_eq!(old.matched_page_key, "LAB-1");
        assert_eq!(old.current_page_key.as_deref(), Some("RND-1"));
        assert!(!old.is_current);
        assert!(
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "LAB-3")
                .expect("bounded alias lookup")
                == UniquePageKeyResolution::NotFound
        );
        let UniquePageKeyResolution::Resolved(current) =
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "RND-3")
                .expect("current lookup")
        else {
            panic!("current key");
        };
        assert!(current.is_current);
    }

    #[test]
    fn suggested_prefixes_are_unique_and_used_prefixes_remain_reserved() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            let first = create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                None,
                "Lab",
                NOW,
            )?;
            let second = create_page_key_namespace(
                transaction,
                "library-1",
                "database-2",
                None,
                "Lab",
                NOW,
            )?;
            assert_eq!(first.current_prefix, "LAB");
            assert_eq!(second.current_prefix, "LAB2");
            let conflict =
                rename_page_key_prefix(transaction, "library-1", "database-2", 1, "LAB", NOW)
                    .expect_err("Library prefix collision");
            assert_eq!(conflict.code, StoreErrorCode::Conflict);
            Ok(())
        })
        .expect("prefix registry");
    }

    #[test]
    fn suggested_prefix_collision_search_selects_the_first_dense_gap_in_memory() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            seed_retired_suggested_prefixes(transaction, 2..=64)?;

            let available = available_suggested_prefix(transaction, "library-1", "Lab")?;
            assert_eq!(available.as_str(), "LAB65");
            Ok(())
        })
        .expect("bounded dense prefix search");
    }

    #[test]
    fn suggested_prefix_collision_search_reports_typed_exhaustion_at_its_cap() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            seed_retired_suggested_prefixes(transaction, 2..=MAX_SUGGESTED_PREFIX_ORDINAL)?;

            let error = available_suggested_prefix(transaction, "library-1", "Lab")
                .expect_err("finite suggestion space must be explicit");
            assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
            Ok(())
        })
        .expect("typed prefix exhaustion");
    }

    #[test]
    fn suggested_prefix_candidates_truncate_an_eight_character_base_per_suffix_width() {
        let base = PageKeyPrefix::parse_requested("ABCDEFGH").expect("maximum-length prefix");
        assert_eq!(
            suggested_prefix_base(&base, 1).expect("one digit"),
            "ABCDEFG"
        );
        assert_eq!(
            suggested_prefix_base(&base, 2).expect("two digits"),
            "ABCDEF"
        );
        assert_eq!(
            suggested_prefix_base(&base, 3).expect("three digits"),
            "ABCDE"
        );

        for (ordinal, expected) in [(2, "ABCDEFG2"), (10, "ABCDEF10"), (999, "ABCDE999")] {
            let suffix = ordinal.to_string();
            let candidate = format!(
                "{}{suffix}",
                suggested_prefix_base(&base, suffix.len()).expect("bounded candidate")
            );
            assert_eq!(candidate, expected);
            assert!(PageKeyPrefix::parse_requested(&candidate).is_ok());
        }
    }

    fn seed_retired_suggested_prefixes(
        connection: &Connection,
        ordinals: impl IntoIterator<Item = i64>,
    ) -> Result<(), StoreError> {
        for ordinal in ordinals {
            connection.execute(
                "INSERT INTO page_key_prefixes(\
                   library_id, normalized_prefix, database_block_id, last_number, revision, \
                   activated_at, retired_at\
                 ) VALUES ('library-1', ?1, 'database-1', 1, 1, ?2, ?2)",
                params![format!("LAB{ordinal}"), NOW],
            )?;
        }
        Ok(())
    }

    #[test]
    fn prefix_preview_reports_create_current_and_reserved_authority_without_writes() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;

            let automatic = preview_page_key_prefix(transaction, "library-1", "Lab", None, None)?;
            assert_eq!(automatic.prefix, "LAB2");
            assert_eq!(automatic.availability, PageKeyPrefixAvailability::Available);
            assert_eq!(automatic.next_number, 1);

            let current = preview_page_key_prefix(
                transaction,
                "library-1",
                "Renamed Lab",
                Some("lab"),
                Some("database-1"),
            )?;
            assert_eq!(current.prefix, "LAB");
            assert_eq!(current.availability, PageKeyPrefixAvailability::Current);
            assert_eq!(current.alternative_prefix, None);

            let reserved = preview_page_key_prefix(
                transaction,
                "library-1",
                "Different Project Name",
                Some("LAB"),
                Some("database-2"),
            )?;
            assert_eq!(reserved.availability, PageKeyPrefixAvailability::Reserved);
            assert_eq!(reserved.alternative_prefix.as_deref(), Some("LAB2"));
            assert_eq!(reserved.next_number, 1);
            assert_eq!(
                transaction.query_row("SELECT count(*) FROM page_key_prefixes", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                1,
            );
            Ok(())
        })
        .expect("preview Page-key prefix");
    }

    #[test]
    fn namespace_settings_count_assignments_and_order_retained_prefixes() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)?;
            ensure_database_page_key(transaction, "library-1", "database-1", "page-2", NOW)?;
            rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                1,
                "RND",
                "2026-08-08T12:01:00.000Z",
            )?;
            rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                2,
                "OPS",
                "2026-08-08T12:02:00.000Z",
            )?;
            let settings = page_key_namespace_settings(transaction, "library-1", "database-1")?
                .expect("enabled namespace");
            assert_eq!(settings.current_prefix, "OPS");
            assert_eq!(settings.next_number, 3);
            assert_eq!(settings.assigned_page_count, 2);
            assert_eq!(settings.revision, 3);
            assert_eq!(
                settings.retired_prefixes,
                vec![
                    RetiredPageKeyPrefixSnapshot {
                        prefix: "LAB".to_owned(),
                        last_number: 2,
                    },
                    RetiredPageKeyPrefixSnapshot {
                        prefix: "RND".to_owned(),
                        last_number: 2,
                    },
                ]
            );
            Ok(())
        })
        .expect("read Page-key namespace settings");
    }

    #[test]
    fn unused_prefix_is_released_instead_of_retained() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            rename_page_key_prefix(
                transaction,
                "library-1",
                "database-1",
                1,
                "RND",
                "2026-08-08T12:01:00.000Z",
            )?;
            let released =
                preview_page_key_prefix(transaction, "library-1", "Lab", Some("LAB"), None)?;
            assert_eq!(released.availability, PageKeyPrefixAvailability::Available);
            let settings = page_key_namespace_settings(transaction, "library-1", "database-1")?
                .expect("enabled namespace");
            assert!(settings.retired_prefixes.is_empty());
            Ok(())
        })
        .expect("release unused prefix");
    }

    #[test]
    fn compact_lookup_preserves_every_registered_split_and_reports_ambiguity() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-2",
                Some("LAB1"),
                "Lab One",
                NOW,
            )?;
            transaction.execute(
                "UPDATE page_key_namespaces SET next_number = 13 \
                 WHERE database_block_id = 'database-1'",
                [],
            )?;
            transaction.execute(
                "UPDATE page_key_namespaces SET next_number = 3 \
                 WHERE database_block_id = 'database-2'",
                [],
            )?;
            transaction.execute(
                "INSERT INTO data_source_page_memberships( \
                   id, data_source_id, page_block_id, revision, created_at, removed_at \
                 ) VALUES ('membership-page-2-database-2-history', 'source-2', 'page-2', \
                   1, ?1, ?1)",
                [NOW],
            )?;
            ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)?;
            ensure_database_page_key(transaction, "library-1", "database-2", "page-2", NOW)?;
            Ok(())
        })
        .expect("seed ambiguous Page keys");

        let matches =
            resolve_page_key_matches_in_library(&fixture.connection, "library-1", "lab13")
                .expect("ambiguous lookup");
        assert_eq!(
            matches
                .iter()
                .map(|resolution| resolution.matched_page_key.as_str())
                .collect::<Vec<_>>(),
            ["LAB-13", "LAB1-3"],
        );
        assert_eq!(
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "lab13")
                .expect("unique lookup"),
            UniquePageKeyResolution::Ambiguous,
        );
        assert!(matches!(
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "LAB-13")
                .expect("explicit LAB lookup"),
            UniquePageKeyResolution::Resolved(_)
        ));
        assert!(matches!(
            resolve_unique_page_key_in_library(&fixture.connection, "library-1", "LAB1-3")
                .expect("explicit LAB1 lookup"),
            UniquePageKeyResolution::Resolved(_)
        ));
    }

    #[test]
    fn allocation_overflow_is_non_retryable_and_does_not_insert_an_assignment() {
        let mut fixture = fixture();
        with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            transaction.execute(
                "UPDATE page_key_namespaces SET next_number = ?1 \
                 WHERE database_block_id = 'database-1'",
                [i64::MAX],
            )?;
            let error =
                ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)
                    .expect_err("exhausted counter");
            assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
            assert!(!error.retryable);
            Ok(())
        })
        .expect("overflow is a domain result");
        let assignments: i64 = fixture
            .connection
            .query_row("SELECT count(*) FROM page_key_assignments", [], |row| {
                row.get(0)
            })
            .expect("assignment count");
        assert_eq!(assignments, 0);
    }

    #[test]
    fn enclosing_transaction_rollback_restores_the_assignment_and_counter_together() {
        let mut fixture = fixture();
        let error = with_immediate_transaction(&mut fixture.connection, |transaction| {
            create_page_key_namespace(
                transaction,
                "library-1",
                "database-1",
                Some("LAB"),
                "Lab",
                NOW,
            )?;
            ensure_database_page_key(transaction, "library-1", "database-1", "page-1", NOW)?;
            Err::<(), StoreError>(StoreError::new(
                StoreErrorCode::Conflict,
                "force enclosing mutation rollback",
                false,
            ))
        })
        .expect_err("forced rollback");
        assert_eq!(error.code, StoreErrorCode::Conflict);
        assert_eq!(
            fixture
                .connection
                .query_row("SELECT count(*) FROM page_key_namespaces", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("namespace count"),
            0
        );
        assert_eq!(
            fixture
                .connection
                .query_row("SELECT count(*) FROM page_key_assignments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("assignment count"),
            0
        );
    }
}
