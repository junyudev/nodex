use nodex_core_contracts::events::{
    LocalProjectionPatch, LocalProjectionScope, ProjectionEffect, ProjectionScopeKey,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::sqlite::{StoreError, StoreErrorCode};

pub(crate) const PROJECTION_SCOPE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProjectionScopeHead {
    pub revision: i64,
    pub covered_commit_seq: i64,
    pub effect_hash: String,
}

pub(crate) fn is_installed(connection: &Connection) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sqlite_schema
           WHERE type = 'table' AND name = 'projection_scope_heads'
         )",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1)
}

#[derive(Serialize)]
struct CanonicalProjectionEffect<'a> {
    hash_version: u32,
    scope: &'a ProjectionScopeKey,
    base_revision: i64,
    result_revision: i64,
    covered_commit_seq: i64,
    patch: &'a Option<LocalProjectionPatch>,
    requires_read_at_least: bool,
}

pub(crate) fn canonical_scope_key(
    scope: LocalProjectionScope,
) -> Result<ProjectionScopeKey, StoreError> {
    let encoded = serde_json::to_vec(&scope)
        .map_err(|_| corrupt("Projection scope cannot be canonically encoded"))?;
    Ok(ProjectionScopeKey {
        schema_version: PROJECTION_SCOPE_SCHEMA_VERSION,
        canonical_key: format!("v{PROJECTION_SCOPE_SCHEMA_VERSION}:{}", sha256(&encoded)),
        scope,
    })
}

pub(crate) fn read(
    connection: &Connection,
    store_epoch: &str,
    scope: &ProjectionScopeKey,
) -> Result<Option<ProjectionScopeHead>, StoreError> {
    validate_scope_key(scope)?;
    let row = connection
        .query_row(
            "SELECT scope_schema_version, scope_json, revision,
                    covered_commit_seq, effect_hash
             FROM projection_scope_heads
             WHERE store_epoch = ?1 AND scope_key = ?2",
            params![store_epoch, scope.canonical_key],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((schema_version, scope_json, revision, covered_commit_seq, effect_hash)) = row else {
        return Ok(None);
    };
    let expected_scope_json = encode_scope(&scope.scope)?;
    if schema_version != i64::from(scope.schema_version)
        || scope_json != expected_scope_json
        || revision < 1
        || covered_commit_seq < 1
        || !is_sha256(&effect_hash)
    {
        return Err(corrupt("Projection scope head is inconsistent"));
    }
    Ok(Some(ProjectionScopeHead {
        revision,
        covered_commit_seq,
        effect_hash,
    }))
}

pub(crate) fn compare_and_advance(
    connection: &Connection,
    store_epoch: &str,
    commit_seq: i64,
    scope: ProjectionScopeKey,
    expected_revision: i64,
    patch: Option<LocalProjectionPatch>,
    requires_read_at_least: bool,
) -> Result<ProjectionEffect, StoreError> {
    validate_scope_key(&scope)?;
    if expected_revision < 0 || commit_seq < 1 || (patch.is_none() && !requires_read_at_least) {
        return Err(corrupt("Projection scope transition is invalid"));
    }
    require_open_commit(connection, store_epoch, commit_seq)?;
    let result_revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| corrupt("Projection scope revision overflowed"))?;
    let effect_hash = projection_effect_hash(
        &scope,
        expected_revision,
        result_revision,
        commit_seq,
        &patch,
        requires_read_at_least,
    )?;
    let scope_json = encode_scope(&scope.scope)?;
    let changed = if expected_revision == 0 {
        connection.execute(
            "INSERT OR IGNORE INTO projection_scope_heads(
               store_epoch, scope_key, scope_schema_version, scope_json,
               revision, covered_commit_seq, effect_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                store_epoch,
                scope.canonical_key,
                i64::from(scope.schema_version),
                scope_json,
                result_revision,
                commit_seq,
                effect_hash,
            ],
        )?
    } else {
        connection.execute(
            "UPDATE projection_scope_heads
             SET revision = ?1, covered_commit_seq = ?2, effect_hash = ?3
             WHERE store_epoch = ?4 AND scope_key = ?5
               AND scope_schema_version = ?6 AND scope_json = ?7
               AND revision = ?8 AND covered_commit_seq < ?2",
            params![
                result_revision,
                commit_seq,
                effect_hash,
                store_epoch,
                scope.canonical_key,
                i64::from(scope.schema_version),
                scope_json,
                expected_revision,
            ],
        )?
    };
    if changed != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "Projection scope revision changed or this commit already advanced it",
            true,
        ));
    }
    Ok(ProjectionEffect {
        scope,
        base_revision: expected_revision,
        result_revision,
        covered_commit_seq: commit_seq,
        patch,
        requires_read_at_least,
        effect_hash,
    })
}

fn require_open_commit(
    connection: &Connection,
    store_epoch: &str,
    commit_seq: i64,
) -> Result<(), StoreError> {
    let open = connection
        .query_row(
            "SELECT 1 FROM local_commits
             WHERE store_epoch = ?1 AND commit_seq = ?2 AND finalized = 0",
            params![store_epoch, commit_seq],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if open {
        return Ok(());
    }
    Err(corrupt(
        "Projection scope transition requires its open semantic commit",
    ))
}

fn validate_scope_key(scope: &ProjectionScopeKey) -> Result<(), StoreError> {
    if scope.schema_version != PROJECTION_SCOPE_SCHEMA_VERSION {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Projection scope schema version is unsupported",
            false,
        ));
    }
    let expected = canonical_scope_key(scope.scope.clone())?;
    if expected.canonical_key == scope.canonical_key {
        return Ok(());
    }
    Err(corrupt("Projection scope key is not canonical"))
}

fn projection_effect_hash(
    scope: &ProjectionScopeKey,
    base_revision: i64,
    result_revision: i64,
    covered_commit_seq: i64,
    patch: &Option<LocalProjectionPatch>,
    requires_read_at_least: bool,
) -> Result<String, StoreError> {
    let encoded = serde_json::to_vec(&CanonicalProjectionEffect {
        hash_version: 1,
        scope,
        base_revision,
        result_revision,
        covered_commit_seq,
        patch,
        requires_read_at_least,
    })
    .map_err(|_| corrupt("Projection effect cannot be canonically encoded"))?;
    Ok(sha256(&encoded))
}

fn encode_scope(scope: &LocalProjectionScope) -> Result<String, StoreError> {
    serde_json::to_string(scope).map_err(|_| corrupt("Projection scope is invalid"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("projection scope fixture");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE local_commits (
                   commit_seq INTEGER PRIMARY KEY,
                   store_epoch TEXT NOT NULL,
                   finalized INTEGER NOT NULL,
                   UNIQUE(store_epoch, commit_seq)
                 ) STRICT;
                 CREATE TABLE projection_scope_heads (
                   store_epoch TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   scope_schema_version INTEGER NOT NULL,
                   scope_json TEXT NOT NULL,
                   revision INTEGER NOT NULL,
                   covered_commit_seq INTEGER NOT NULL,
                   effect_hash TEXT NOT NULL,
                   PRIMARY KEY(store_epoch, scope_key),
                   FOREIGN KEY(store_epoch, covered_commit_seq)
                     REFERENCES local_commits(store_epoch, commit_seq)
                 ) WITHOUT ROWID, STRICT;",
            )
            .expect("projection scope schema");
        connection
    }

    fn insert_open_commit(connection: &Connection, store_epoch: &str, commit_seq: i64) {
        connection
            .execute(
                "INSERT INTO local_commits(commit_seq, store_epoch, finalized)
                 VALUES (?1, ?2, 0)",
                params![commit_seq, store_epoch],
            )
            .expect("open commit");
    }

    fn page_scope() -> LocalProjectionScope {
        LocalProjectionScope::Page {
            project_id: "project-a".to_owned(),
            page_id: "page-a".to_owned(),
        }
    }

    fn page_patch() -> LocalProjectionPatch {
        LocalProjectionPatch::PageChanged {
            project_id: "project-a".to_owned(),
            page_id: "page-a".to_owned(),
        }
    }

    #[test]
    fn advances_one_scope_once_per_commit_and_allows_commit_sequence_gaps() {
        let connection = connection();
        insert_open_commit(&connection, "epoch-a", 1);
        let scope = canonical_scope_key(page_scope()).expect("canonical scope");
        let first = compare_and_advance(
            &connection,
            "epoch-a",
            1,
            scope.clone(),
            0,
            Some(page_patch()),
            false,
        )
        .expect("first advance");
        assert_eq!((first.base_revision, first.result_revision), (0, 1));

        let duplicate = compare_and_advance(
            &connection,
            "epoch-a",
            1,
            scope.clone(),
            1,
            Some(page_patch()),
            false,
        )
        .expect_err("same commit cannot advance one scope twice");
        assert_eq!(duplicate.code, StoreErrorCode::RevisionConflict);

        connection
            .execute(
                "UPDATE local_commits SET finalized = 1 WHERE commit_seq = 1",
                [],
            )
            .expect("seal first commit");
        insert_open_commit(&connection, "epoch-a", 9);
        let second = compare_and_advance(&connection, "epoch-a", 9, scope.clone(), 1, None, true)
            .expect("gapped commit advance");
        assert_eq!((second.base_revision, second.result_revision), (1, 2));
        assert_eq!(second.covered_commit_seq, 9);
        assert_eq!(
            read(&connection, "epoch-a", &scope).expect("read head"),
            Some(ProjectionScopeHead {
                revision: 2,
                covered_commit_seq: 9,
                effect_hash: second.effect_hash,
            })
        );
    }

    #[test]
    fn rollback_does_not_advance_a_scope_head() {
        let mut connection = connection();
        let scope = canonical_scope_key(page_scope()).expect("canonical scope");
        {
            let transaction = connection.transaction().expect("transaction");
            insert_open_commit(&transaction, "epoch-a", 1);
            compare_and_advance(
                &transaction,
                "epoch-a",
                1,
                scope.clone(),
                0,
                Some(page_patch()),
                false,
            )
            .expect("advance in transaction");
        }
        assert_eq!(
            read(&connection, "epoch-a", &scope).expect("read rolled back head"),
            None
        );
    }

    #[test]
    fn rejects_noncanonical_schema_and_store_epoch_mismatch() {
        let connection = connection();
        insert_open_commit(&connection, "epoch-b", 1);
        let mut unsupported = canonical_scope_key(page_scope()).expect("canonical scope");
        unsupported.schema_version += 1;
        let schema_error = compare_and_advance(
            &connection,
            "epoch-b",
            1,
            unsupported,
            0,
            Some(page_patch()),
            false,
        )
        .expect_err("unsupported schema");
        assert_eq!(schema_error.code, StoreErrorCode::UnsupportedSchema);

        let epoch_error = compare_and_advance(
            &connection,
            "epoch-a",
            1,
            canonical_scope_key(page_scope()).expect("canonical scope"),
            0,
            Some(page_patch()),
            false,
        )
        .expect_err("mismatched epoch");
        assert_eq!(epoch_error.code, StoreErrorCode::StoreCorrupt);
    }
}
