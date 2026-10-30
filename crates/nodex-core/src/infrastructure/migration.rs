use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};
#[cfg(test)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::SecondsFormat;
#[cfg(test)]
use rusqlite::backup::Backup;
use rusqlite::{Connection, MAIN_DB, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::database::repair_scheduled_page_indexes;
use crate::document::integrity::{
    materialization_derivation_for_store_revision, upgrade_document_markdown_derivation,
    validate_documents_for_store_revision, validate_restore_documents,
};
use crate::document::{
    migrate_block_children_contract, migrate_block_document_baselines,
    migrate_nodex_markdown_contract, repair_document_schema_projections,
    validate_block_children_migration_source, validate_nodex_markdown_migration_source,
};
use crate::domain::fractional_rank::materialize_order;
use crate::domain::identity::random_uuid_v7;

use super::migration_progress::report_bounded_progress;
#[cfg(test)]
use super::schema::install_current_schema;
use super::schema::{
    CURRENT_STORE_REVISION, install_current_schema_in_transaction, validate_schema_identity,
};
use super::sqlite::{
    StoreError, StoreErrorCode, open_immutable_reader, validate_store, with_immediate_transaction,
};
use super::store_validation::{
    DatabaseViewStorageContract, validate_core_metadata, validate_current_store,
    validate_migration_source_semantics,
};
use super::store_validation_receipt::{self, StoreValidationReceipt};

const BASELINE_STORE_REVISION: i64 = 130;
const CURRENT_DOCUMENT_SCHEMA_REVISION: i64 = 135;
const DATABASE_VIEW_V5_STORE_REVISION: i64 = 144;
const DATABASE_VIEW_V6_STORE_REVISION: i64 = 146;
const LIBRARY_FILES_STORE_REVISION: i64 = 152;
const CORE_SCHEMA_OWNER: &str = "rust_core";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePreparation {
    pub schema_version: i64,
    pub created_fresh: bool,
    pub migrated_from_version: Option<i64>,
    pub validation: StoreValidationDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreValidationDisposition {
    Deep,
    TrustedReceipt,
}

#[derive(Clone, Copy)]
pub(crate) enum CurrentStoreValidation<'a> {
    Deep,
    TrustedReceipt(&'a StoreValidationReceipt),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorePreparationEvent {
    MigrationStarted { from_version: i64, to_version: i64 },
    MigrationProgress { completed: u64, total: u64 },
}

#[derive(Clone, Copy)]
struct MigrationStep {
    from_revision: i64,
    to_revision: i64,
    apply: fn(&Connection, &MigrationContext) -> Result<(), StoreError>,
}

struct MigrationContext {
    source_revision: i64,
    target_revision: i64,
    backup_name: String,
    source_schema_fingerprint: &'static str,
    target_schema_fingerprint: &'static str,
    completed_at_unix_ms: i64,
}

const MIGRATION_STEPS: &[MigrationStep] = &[
    MigrationStep {
        from_revision: BASELINE_STORE_REVISION,
        to_revision: 131,
        apply: migrate_v130_to_v131,
    },
    MigrationStep {
        from_revision: 131,
        to_revision: 132,
        apply: migrate_v131_to_v132,
    },
    MigrationStep {
        from_revision: 132,
        to_revision: 133,
        apply: migrate_v132_to_v133,
    },
    MigrationStep {
        from_revision: 133,
        to_revision: 134,
        apply: migrate_v133_to_v134,
    },
    MigrationStep {
        from_revision: 134,
        to_revision: 135,
        apply: migrate_v134_to_v135,
    },
    MigrationStep {
        from_revision: 135,
        to_revision: 136,
        apply: migrate_v135_to_v136,
    },
    MigrationStep {
        from_revision: 136,
        to_revision: 137,
        apply: migrate_v136_to_v137,
    },
    MigrationStep {
        from_revision: 137,
        to_revision: 138,
        apply: migrate_v137_to_v138,
    },
    MigrationStep {
        from_revision: 138,
        to_revision: 139,
        apply: migrate_v138_to_v139,
    },
    MigrationStep {
        from_revision: 139,
        to_revision: 140,
        apply: migrate_v139_to_v140,
    },
    MigrationStep {
        from_revision: 140,
        to_revision: 141,
        apply: migrate_v140_to_v141,
    },
    MigrationStep {
        from_revision: 141,
        to_revision: 142,
        apply: migrate_v141_to_v142,
    },
    MigrationStep {
        from_revision: 142,
        to_revision: 143,
        apply: migrate_v142_to_v143,
    },
    MigrationStep {
        from_revision: 143,
        to_revision: 144,
        apply: migrate_v143_to_v144,
    },
    MigrationStep {
        from_revision: 144,
        to_revision: 145,
        apply: migrate_v144_to_v145,
    },
    MigrationStep {
        from_revision: 145,
        to_revision: 146,
        apply: migrate_v145_to_v146,
    },
    MigrationStep {
        from_revision: 146,
        to_revision: 147,
        apply: migrate_v146_to_v147,
    },
    MigrationStep {
        from_revision: 147,
        to_revision: 148,
        apply: migrate_v147_to_v148,
    },
    MigrationStep {
        from_revision: 148,
        to_revision: 149,
        apply: migrate_v148_to_v149,
    },
    MigrationStep {
        from_revision: 149,
        to_revision: 150,
        apply: migrate_v149_to_v150,
    },
    MigrationStep {
        from_revision: 150,
        to_revision: 151,
        apply: migrate_v150_to_v151,
    },
    MigrationStep {
        from_revision: 151,
        to_revision: 152,
        apply: migrate_v151_to_v152,
    },
    MigrationStep {
        from_revision: 152,
        to_revision: 159,
        apply: migrate_v152_to_v159,
    },
    MigrationStep {
        from_revision: 159,
        to_revision: 160,
        apply: migrate_v159_to_v160,
    },
    MigrationStep {
        from_revision: 160,
        to_revision: 161,
        apply: migrate_v160_to_v161,
    },
    MigrationStep {
        from_revision: 161,
        to_revision: 162,
        apply: migrate_v161_to_v162,
    },
    MigrationStep {
        from_revision: 162,
        to_revision: 163,
        apply: migrate_v162_to_v163,
    },
    MigrationStep {
        from_revision: 163,
        to_revision: 164,
        apply: migrate_v163_to_v164,
    },
    MigrationStep {
        from_revision: 164,
        to_revision: 165,
        apply: migrate_v164_to_v165,
    },
    MigrationStep {
        from_revision: 165,
        to_revision: 166,
        apply: migrate_v165_to_v166,
    },
    MigrationStep {
        from_revision: 166,
        to_revision: 167,
        apply: migrate_v166_to_v167,
    },
    MigrationStep {
        from_revision: 167,
        to_revision: 168,
        apply: migrate_v167_to_v168,
    },
    MigrationStep {
        from_revision: 168,
        to_revision: 169,
        apply: migrate_v168_to_v169,
    },
    MigrationStep {
        from_revision: 169,
        to_revision: 170,
        apply: migrate_v169_to_v170,
    },
    MigrationStep {
        from_revision: 170,
        to_revision: 171,
        apply: migrate_v170_to_v171,
    },
    MigrationStep {
        from_revision: 171,
        to_revision: 172,
        apply: migrate_v171_to_v172,
    },
    MigrationStep {
        from_revision: 172,
        to_revision: 173,
        apply: migrate_v172_to_v173,
    },
    MigrationStep {
        from_revision: 173,
        to_revision: 174,
        apply: migrate_v173_to_v174,
    },
    MigrationStep {
        from_revision: 174,
        to_revision: 175,
        apply: migrate_v174_to_v175,
    },
    MigrationStep {
        from_revision: 175,
        to_revision: 176,
        apply: migrate_v175_to_v176,
    },
    MigrationStep {
        from_revision: 176,
        to_revision: 177,
        apply: migrate_v176_to_v177,
    },
    MigrationStep {
        from_revision: 177,
        to_revision: 178,
        apply: migrate_v177_to_v178,
    },
    MigrationStep {
        from_revision: 178,
        to_revision: 179,
        apply: migrate_v178_to_v179,
    },
    MigrationStep {
        from_revision: 179,
        to_revision: 180,
        apply: migrate_v179_to_v180,
    },
    MigrationStep {
        from_revision: 180,
        to_revision: 181,
        apply: migrate_v180_to_v181,
    },
    MigrationStep {
        from_revision: 181,
        to_revision: 182,
        apply: migrate_v181_to_v182,
    },
    MigrationStep {
        from_revision: 182,
        to_revision: 183,
        apply: migrate_v182_to_v183,
    },
    MigrationStep {
        from_revision: 183,
        to_revision: 184,
        apply: migrate_v183_to_v184,
    },
    MigrationStep {
        from_revision: 184,
        to_revision: 185,
        apply: migrate_v184_to_v185,
    },
    MigrationStep {
        from_revision: 185,
        to_revision: 186,
        apply: migrate_v185_to_v186,
    },
    MigrationStep {
        from_revision: 186,
        to_revision: 187,
        apply: migrate_v186_to_v187,
    },
    MigrationStep {
        from_revision: 187,
        to_revision: 188,
        apply: migrate_v187_to_v188,
    },
    MigrationStep {
        from_revision: 188,
        to_revision: 189,
        apply: migrate_v188_to_v189,
    },
    MigrationStep {
        from_revision: 189,
        to_revision: 190,
        apply: migrate_v189_to_v190,
    },
    MigrationStep {
        from_revision: 190,
        to_revision: 191,
        apply: migrate_v190_to_v191,
    },
    MigrationStep {
        from_revision: 191,
        to_revision: 192,
        apply: migrate_v191_to_v192,
    },
    MigrationStep {
        from_revision: 192,
        to_revision: 193,
        apply: migrate_v192_to_v193,
    },
    MigrationStep {
        from_revision: 193,
        to_revision: 194,
        apply: migrate_v193_to_v194,
    },
];

fn resolve_migration_path(
    from_revision: i64,
    target_revision: i64,
    steps: &[MigrationStep],
) -> Option<Vec<MigrationStep>> {
    if from_revision >= target_revision {
        return None;
    }

    let mut cursor = from_revision;
    let mut path = Vec::new();
    while cursor < target_revision {
        let step = steps
            .iter()
            .copied()
            .find(|step| step.from_revision == cursor)?;
        if step.to_revision <= cursor || step.to_revision > target_revision {
            return None;
        }
        path.push(step);
        cursor = step.to_revision;
        if path.len() > steps.len() {
            return None;
        }
    }
    (cursor == target_revision).then_some(path)
}

pub fn prepare_profile_store(
    connection: &mut Connection,
    profile_home: &Path,
) -> Result<StorePreparation, StoreError> {
    prepare_profile_store_with_validation(
        connection,
        profile_home,
        &mut |_| {},
        CurrentStoreValidation::Deep,
    )
}

pub fn prepare_profile_store_with_observer(
    connection: &mut Connection,
    profile_home: &Path,
    observer: &mut dyn FnMut(StorePreparationEvent),
) -> Result<StorePreparation, StoreError> {
    prepare_profile_store_with_validation(
        connection,
        profile_home,
        observer,
        CurrentStoreValidation::Deep,
    )
}

/// Proves that an offline Profile-clone candidate is either a complete current
/// Store or an exact source accepted by the current migration graph. Unlike a
/// restore candidate, a clone intentionally preserves the source revision so
/// the target Core can exercise the production migration on first open.
pub(crate) fn validate_profile_clone_source(connection: &Connection) -> Result<i64, StoreError> {
    let version = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if version == CURRENT_STORE_REVISION {
        validate_current_store(connection)?;
        validate_restore_documents(connection)?;
        return Ok(version);
    }
    if resolve_migration_path(version, CURRENT_STORE_REVISION, MIGRATION_STEPS).is_none() {
        return Err(unsupported_schema(version));
    }
    validate_migration_source(connection, version)?;
    Ok(version)
}

/// What opening a Store would do in this build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreOpenDisposition {
    Install,
    Open,
    Upgrade { from_revision: i64 },
}

/// Decides how this build would open a Store from its identity alone: the
/// revision, its exact published physical schema, and Core ownership. Unlike
/// opening, it never writes, migrates, or repeats the deep content validation.
pub(crate) fn store_open_disposition(
    connection: &Connection,
) -> Result<StoreOpenDisposition, StoreError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if version == 0 && object_count == 0 {
        return Ok(StoreOpenDisposition::Install);
    }
    if version == CURRENT_STORE_REVISION {
        validate_schema_identity(connection, CURRENT_STORE_REVISION)?;
        validate_core_metadata(connection)?;
        return Ok(StoreOpenDisposition::Open);
    }
    if resolve_migration_path(version, CURRENT_STORE_REVISION, MIGRATION_STEPS).is_none() {
        return Err(unsupported_schema(version));
    }
    validate_migration_source_identity(connection, version)?;
    Ok(StoreOpenDisposition::Upgrade {
        from_revision: version,
    })
}

pub(crate) fn prepare_profile_store_with_validation(
    connection: &mut Connection,
    profile_home: &Path,
    observer: &mut dyn FnMut(StorePreparationEvent),
    current_store_validation: CurrentStoreValidation<'_>,
) -> Result<StorePreparation, StoreError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if version == 0 && object_count == 0 {
        install_fresh_profile(connection, unix_time_millis()?)?;
        validate_current_store(connection)?;
        return Ok(StorePreparation {
            schema_version: CURRENT_STORE_REVISION,
            created_fresh: true,
            migrated_from_version: None,
            validation: StoreValidationDisposition::Deep,
        });
    }
    if version == CURRENT_STORE_REVISION {
        if let CurrentStoreValidation::TrustedReceipt(receipt) = current_store_validation {
            validate_schema_identity(connection, CURRENT_STORE_REVISION)?;
            validate_core_metadata(connection)?;
            if store_validation_receipt::matches(receipt, connection)? {
                return Ok(StorePreparation {
                    schema_version: CURRENT_STORE_REVISION,
                    created_fresh: false,
                    migrated_from_version: None,
                    validation: StoreValidationDisposition::TrustedReceipt,
                });
            }
        }
        validate_current_store(connection)?;
        return Ok(StorePreparation {
            schema_version: CURRENT_STORE_REVISION,
            created_fresh: false,
            migrated_from_version: None,
            validation: StoreValidationDisposition::Deep,
        });
    }
    let Some(steps) = resolve_migration_path(version, CURRENT_STORE_REVISION, MIGRATION_STEPS)
    else {
        return Err(unsupported_schema(version));
    };

    migrate_store(connection, profile_home, observer, version, &steps)
}

#[cfg(test)]
fn migrate_baseline_store(
    connection: &mut Connection,
    profile_home: &Path,
    observer: &mut dyn FnMut(StorePreparationEvent),
    step: MigrationStep,
) -> Result<StorePreparation, StoreError> {
    migrate_store(
        connection,
        profile_home,
        observer,
        step.from_revision,
        &[step],
    )
}

fn migrate_store(
    connection: &mut Connection,
    profile_home: &Path,
    observer: &mut dyn FnMut(StorePreparationEvent),
    source_revision: i64,
    steps: &[MigrationStep],
) -> Result<StorePreparation, StoreError> {
    let target_revision = steps
        .last()
        .map(|step| step.to_revision)
        .ok_or_else(|| internal("Store migration path is empty"))?;
    // Source validation is intentionally reader-heavy on large Profiles. Tell
    // the launcher that migration preparation has begun before that work so
    // its bounded heartbeat remains active throughout validation and backup.
    for step in steps {
        observer(StorePreparationEvent::MigrationStarted {
            from_version: step.from_revision,
            to_version: step.to_revision,
        });
    }
    validate_migration_source(connection, source_revision)?;
    let backup_path =
        create_migration_backup(connection, profile_home, source_revision, target_revision)?;
    let backup_name = backup_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_profile("Core migration backup name is not valid UTF-8"))?
        .to_owned();
    let completed_at_unix_ms = i64::try_from(unix_time_millis()?)
        .map_err(|_| internal("Migration time exceeds SQLite integer range"))?;

    with_schema_rebuild_transaction(connection, |transaction| {
        for step in steps {
            let source = published_format(step.from_revision)?;
            let target = published_format(step.to_revision)?;
            let context = MigrationContext {
                source_revision: step.from_revision,
                target_revision: step.to_revision,
                backup_name: backup_name.clone(),
                source_schema_fingerprint: source.schema_fingerprint,
                target_schema_fingerprint: target.schema_fingerprint,
                completed_at_unix_ms,
            };
            (step.apply)(transaction, &context)?;
            validate_schema_identity(transaction, step.to_revision)?;
        }
        validate_current_store(transaction)
    })?;
    let mut reported_step = 0;
    for completed in 1..=steps.len() {
        report_bounded_progress(
            &mut |completed, total| {
                observer(StorePreparationEvent::MigrationProgress { completed, total });
            },
            u64::try_from(completed).map_err(|_| internal("Migration path is too large"))?,
            u64::try_from(steps.len()).map_err(|_| internal("Migration path is too large"))?,
            &mut reported_step,
        );
    }
    Ok(StorePreparation {
        schema_version: target_revision,
        created_fresh: false,
        migrated_from_version: Some(source_revision),
        validation: StoreValidationDisposition::Deep,
    })
}

fn validate_migration_source(
    connection: &Connection,
    source_revision: i64,
) -> Result<(), StoreError> {
    validate_store(connection)?;
    validate_migration_source_identity(connection, source_revision)?;
    let view_contract = if source_revision < DATABASE_VIEW_V5_STORE_REVISION {
        DatabaseViewStorageContract::V4
    } else if source_revision < DATABASE_VIEW_V6_STORE_REVISION {
        DatabaseViewStorageContract::V5
    } else {
        DatabaseViewStorageContract::V6
    };
    validate_migration_source_semantics(
        connection,
        view_contract,
        source_revision >= LIBRARY_FILES_STORE_REVISION,
        materialization_derivation_for_store_revision(source_revision)?,
    )?;
    if source_revision >= CURRENT_DOCUMENT_SCHEMA_REVISION {
        validate_nodex_markdown_migration_source(connection)?;
        validate_documents_for_store_revision(connection, source_revision)?;
    } else {
        validate_block_children_migration_source(connection)?;
    }
    Ok(())
}

fn validate_migration_source_identity(
    connection: &Connection,
    source_revision: i64,
) -> Result<(), StoreError> {
    validate_schema_identity(connection, source_revision)?;
    let metadata = connection.query_row(
        "SELECT schema_owner, projection_event_v2_floor, \
                (SELECT COALESCE(MAX(seq), 0) FROM change_log) \
         FROM core_store_metadata WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    if metadata.0 != CORE_SCHEMA_OWNER
        || !metadata
            .1
            .is_some_and(|floor| (1..=metadata.2 + 1).contains(&floor))
    {
        return Err(corrupt(format!(
            "v{source_revision} Store has invalid Core metadata"
        )));
    }
    Ok(())
}

fn unsupported_schema(version: i64) -> StoreError {
    StoreError::new(
        StoreErrorCode::UnsupportedSchema,
        format!(
            "Rust Core accepts the current v{CURRENT_STORE_REVISION} Store or a published predecessor with a registered migration path; received v{version}"
        ),
        false,
    )
}

fn migrate_v130_to_v131(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "ALTER TABLE core_store_metadata RENAME TO core_store_metadata_v130; \
         CREATE TABLE core_store_metadata ( \
           id INTEGER PRIMARY KEY CHECK (id = 1), \
           schema_owner TEXT NOT NULL CHECK (schema_owner = 'rust_core'), \
           projection_event_v2_floor INTEGER NOT NULL \
             CHECK (projection_event_v2_floor >= 1) \
         ) STRICT; \
         INSERT INTO core_store_metadata(id, schema_owner, projection_event_v2_floor) \
         SELECT id, schema_owner, projection_event_v2_floor \
         FROM core_store_metadata_v130; \
         DROP TABLE core_store_metadata_v130; \
         DROP TABLE core_legacy_imports; \
         CREATE TABLE core_store_migration_history ( \
           source_revision INTEGER NOT NULL CHECK (source_revision >= 1), \
           target_revision INTEGER NOT NULL CHECK (target_revision > source_revision), \
           source_schema_fingerprint TEXT NOT NULL \
             CHECK ( \
               length(source_schema_fingerprint) = 64 \
               AND source_schema_fingerprint NOT GLOB '*[^0-9a-f]*' \
             ), \
           target_schema_fingerprint TEXT NOT NULL \
             CHECK ( \
               length(target_schema_fingerprint) = 64 \
               AND target_schema_fingerprint NOT GLOB '*[^0-9a-f]*' \
             ), \
           backup_name TEXT NOT NULL \
             CHECK ( \
               length(backup_name) BETWEEN 1 AND 512 \
               AND instr(backup_name, '/') = 0 \
               AND instr(backup_name, '\\') = 0 \
             ), \
           completed_at_unix_ms INTEGER NOT NULL CHECK (completed_at_unix_ms >= 0), \
           PRIMARY KEY (source_revision, target_revision) \
         ) WITHOUT ROWID, STRICT;",
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v131_to_v132(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "CREATE TABLE structural_clipboard_bundles ( \
           bundle_id TEXT PRIMARY KEY, \
           capture_operation_id TEXT NOT NULL UNIQUE \
             REFERENCES block_mutations(mutation_id) ON DELETE CASCADE, \
           library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, \
           store_epoch TEXT NOT NULL, \
           capability_hash TEXT NOT NULL, \
           manifest_hash TEXT NOT NULL, \
           snapshot_json TEXT NOT NULL, \
           created_at TEXT NOT NULL, \
           CHECK (length(bundle_id) BETWEEN 1 AND 512), \
           CHECK (length(store_epoch) BETWEEN 1 AND 512), \
           CHECK (length(capability_hash) = 64 AND capability_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (length(snapshot_json) BETWEEN 2 AND 67108864 \
             AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'), \
           CHECK (length(created_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE structural_clipboard_leases ( \
           bundle_id TEXT PRIMARY KEY \
             REFERENCES structural_clipboard_bundles(bundle_id) ON DELETE CASCADE, \
           revision INTEGER NOT NULL CHECK (revision >= 1), \
           state TEXT NOT NULL CHECK (state IN ('active', 'released')), \
           released_at TEXT, \
           updated_at TEXT NOT NULL, \
           CHECK ((state = 'active' AND released_at IS NULL) \
             OR (state = 'released' AND length(released_at) > 0)), \
           CHECK (length(updated_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE structural_cut_claims ( \
           bundle_id TEXT PRIMARY KEY \
             REFERENCES structural_clipboard_bundles(bundle_id) ON DELETE CASCADE, \
           source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT, \
           source_root_ids_json TEXT NOT NULL, \
           delete_recipe_operation_id TEXT NOT NULL UNIQUE \
             REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE RESTRICT, \
           revision INTEGER NOT NULL CHECK (revision >= 1), \
           state TEXT NOT NULL CHECK (state IN ('available', 'consumed', 'revoked')), \
           consumed_by_operation_id TEXT \
             REFERENCES block_mutations(mutation_id) ON DELETE RESTRICT, \
           created_at TEXT NOT NULL, \
           updated_at TEXT NOT NULL, \
           CHECK (json_valid(source_root_ids_json) \
             AND json_type(source_root_ids_json) = 'array' \
             AND json_array_length(source_root_ids_json) BETWEEN 1 AND 10000), \
           CHECK ((state = 'consumed' AND consumed_by_operation_id IS NOT NULL) \
             OR (state <> 'consumed' AND consumed_by_operation_id IS NULL)), \
           CHECK (length(created_at) > 0), \
           CHECK (length(updated_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE structural_history_recipes ( \
           recipe_operation_id TEXT PRIMARY KEY \
             REFERENCES block_mutations(mutation_id) ON DELETE CASCADE, \
           library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, \
           project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, \
           store_epoch TEXT NOT NULL, \
           recipe_hash TEXT NOT NULL, \
           recipe_json TEXT NOT NULL, \
           state TEXT NOT NULL CHECK (state IN ('available', 'consumed', 'superseded')), \
           consumed_at TEXT, \
           superseded_by_recipe_operation_id TEXT \
             REFERENCES structural_history_recipes(recipe_operation_id) ON DELETE RESTRICT, \
           created_at TEXT NOT NULL, \
           CHECK (length(recipe_operation_id) BETWEEN 1 AND 512), \
           CHECK (length(store_epoch) BETWEEN 1 AND 512), \
           CHECK (length(recipe_hash) = 64 AND recipe_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (length(recipe_json) BETWEEN 2 AND 67108864 \
             AND json_valid(recipe_json) AND json_type(recipe_json) = 'object'), \
           CHECK ((state = 'available' AND consumed_at IS NULL \
                    AND superseded_by_recipe_operation_id IS NULL) \
             OR (state = 'consumed' AND length(consumed_at) > 0 \
                    AND superseded_by_recipe_operation_id IS NULL) \
             OR (state = 'superseded' AND length(consumed_at) > 0 \
                    AND superseded_by_recipe_operation_id IS NOT NULL)), \
           CHECK (length(created_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE structural_retention_members ( \
           authority_kind TEXT NOT NULL \
             CHECK (authority_kind IN ('clipboard_bundle', 'history_recipe')), \
           authority_id TEXT NOT NULL, \
           library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, \
           member_kind TEXT NOT NULL \
             CHECK (member_kind IN ('block', 'document', 'database', 'asset')), \
           member_id TEXT NOT NULL, \
           PRIMARY KEY (authority_kind, authority_id, member_kind, member_id), \
           CHECK (length(authority_id) BETWEEN 1 AND 512), \
           CHECK (length(member_id) BETWEEN 1 AND 1024) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_structural_retention_members_identity \
           ON structural_retention_members(library_id, member_kind, member_id); \
         CREATE INDEX idx_structural_history_recipes_state \
           ON structural_history_recipes(library_id, state, created_at); \
         CREATE TRIGGER structural_clipboard_bundles_are_immutable \
         BEFORE UPDATE ON structural_clipboard_bundles \
         BEGIN \
           SELECT RAISE(ABORT, 'Structural clipboard bundles are immutable'); \
         END; \
         CREATE TRIGGER structural_clipboard_leases_transition_once \
         BEFORE UPDATE ON structural_clipboard_leases \
         WHEN NOT (OLD.state = 'active' AND NEW.state = 'released' \
           AND NEW.revision = OLD.revision + 1 AND NEW.released_at IS NOT NULL \
           AND OLD.bundle_id = NEW.bundle_id) \
         BEGIN \
           SELECT RAISE(ABORT, 'Structural clipboard lease transition is invalid'); \
         END; \
         CREATE TRIGGER structural_cut_claims_transition_once \
         BEFORE UPDATE ON structural_cut_claims \
         WHEN NOT (OLD.state = 'available' AND NEW.state IN ('consumed', 'revoked') \
           AND NEW.revision = OLD.revision + 1 AND OLD.bundle_id = NEW.bundle_id \
           AND OLD.source_document_id = NEW.source_document_id \
           AND OLD.source_root_ids_json = NEW.source_root_ids_json \
           AND OLD.delete_recipe_operation_id = NEW.delete_recipe_operation_id \
           AND OLD.created_at = NEW.created_at) \
         BEGIN \
           SELECT RAISE(ABORT, 'Structural cut claim transition is invalid'); \
         END; \
         CREATE TRIGGER structural_history_recipes_transition_once \
         BEFORE UPDATE ON structural_history_recipes \
         WHEN NOT (OLD.state = 'available' AND NEW.state IN ('consumed', 'superseded') \
           AND NEW.consumed_at IS NOT NULL \
           AND OLD.recipe_operation_id = NEW.recipe_operation_id \
           AND OLD.library_id = NEW.library_id AND OLD.project_id = NEW.project_id \
           AND OLD.store_epoch = NEW.store_epoch \
           AND OLD.recipe_hash = NEW.recipe_hash AND OLD.recipe_json = NEW.recipe_json \
           AND OLD.created_at = NEW.created_at) \
         BEGIN \
           SELECT RAISE(ABORT, 'Structural history recipe transition is invalid'); \
         END; \
         CREATE TRIGGER structural_retention_members_are_immutable \
         BEFORE UPDATE ON structural_retention_members \
         BEGIN \
           SELECT RAISE(ABORT, 'Structural retention members are immutable'); \
         END;",
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v132_to_v133(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "CREATE TABLE project_session_pages ( \
           session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE, \
           page_id TEXT NOT NULL REFERENCES pages(block_id) ON DELETE CASCADE, \
           linked_at TEXT NOT NULL, \
           PRIMARY KEY (session_id, page_id), \
           CHECK (length(session_id) BETWEEN 1 AND 512), \
           CHECK (length(page_id) BETWEEN 1 AND 512), \
           CHECK (length(linked_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_project_session_pages_page \
           ON project_session_pages(page_id, session_id);",
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v133_to_v134(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "CREATE TABLE codex_queued_follow_up_ledgers ( \
           thread_id TEXT PRIMARY KEY REFERENCES codex_threads(thread_id) ON DELETE CASCADE, \
           revision INTEGER NOT NULL CHECK (revision >= 0), \
           ledger_hash TEXT NOT NULL CHECK (length(ledger_hash) = 64), \
           updated_at TEXT NOT NULL CHECK (length(updated_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE codex_queued_follow_up_payload_manifests ( \
           payload_sha256 TEXT PRIMARY KEY CHECK (length(payload_sha256) = 64), \
           schema_version INTEGER NOT NULL CHECK (schema_version = 1), \
           asset_uri TEXT NOT NULL UNIQUE CHECK ( \
             asset_uri LIKE 'nodex://assets/queued-follow-up-v1-%.json' \
           ), \
           byte_length INTEGER NOT NULL CHECK (byte_length >= 2) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE codex_queued_follow_up_payload_asset_refs ( \
           payload_sha256 TEXT NOT NULL REFERENCES codex_queued_follow_up_payload_manifests(payload_sha256) ON DELETE CASCADE, \
           ordinal INTEGER NOT NULL CHECK (ordinal >= 0), \
           asset_uri TEXT NOT NULL CHECK (asset_uri LIKE 'nodex://assets/%'), \
           sha256 TEXT NOT NULL CHECK (length(sha256) = 64), \
           byte_length INTEGER NOT NULL CHECK (byte_length >= 0), \
           PRIMARY KEY (payload_sha256, ordinal), \
           UNIQUE (payload_sha256, asset_uri) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE codex_queued_follow_up_entries ( \
           thread_id TEXT NOT NULL REFERENCES codex_queued_follow_up_ledgers(thread_id) ON DELETE CASCADE, \
           follow_up_id TEXT NOT NULL, \
           position INTEGER NOT NULL CHECK (position >= 0), \
           client_user_message_id TEXT NOT NULL, \
           created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), \
           pause_kind TEXT CHECK (pause_kind IN ('interrupted', 'failed')), \
           pause_reason TEXT, \
           payload_sha256 TEXT NOT NULL REFERENCES codex_queued_follow_up_payload_manifests(payload_sha256), \
           PRIMARY KEY (thread_id, follow_up_id), \
           UNIQUE (thread_id, position), \
           UNIQUE (thread_id, client_user_message_id), \
           CHECK (length(trim(follow_up_id)) BETWEEN 1 AND 512), \
           CHECK (length(trim(client_user_message_id)) BETWEEN 1 AND 512), \
           CHECK ( \
             (pause_kind IS NULL AND pause_reason IS NULL) \
             OR (pause_kind IS NOT NULL AND length(trim(pause_reason)) BETWEEN 1 AND 4096) \
           ) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_codex_queued_follow_up_entries_payload \
           ON codex_queued_follow_up_entries(payload_sha256); \
         CREATE TABLE codex_queued_follow_up_manifest_gc ( \
           asset_uri TEXT PRIMARY KEY CHECK ( \
             asset_uri LIKE 'nodex://assets/queued-follow-up-v1-%.json' \
           ), \
           sha256 TEXT NOT NULL CHECK (length(sha256) = 64), \
           enqueued_at TEXT NOT NULL CHECK (length(enqueued_at) > 0), \
           attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), \
           last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR length(last_attempt_at) > 0), \
           last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 4096) \
         ) WITHOUT ROWID, STRICT;",
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v134_to_v135(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    let evidence = migrate_block_children_contract(connection, context.completed_at_unix_ms)?;
    connection.execute_batch(
        "ALTER TABLE core_store_migration_history ADD COLUMN evidence_json TEXT NOT NULL \
           DEFAULT '{}' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object');",
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            serde_json::to_string(&evidence)
                .map_err(|_| internal("Block children migration evidence could not be encoded"))?,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v135_to_v136(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    // The large ledgers are not rewritten during startup. Existing delivery
    // sizes are populated into the companion table by bounded maintenance.
    connection.execute_batch(
        "CREATE TABLE local_commit_retention_metadata ( \
           store_epoch TEXT NOT NULL, commit_seq INTEGER NOT NULL, \
           sealed_at_ms INTEGER NOT NULL CHECK (sealed_at_ms >= 0), \
           delivery_bytes INTEGER NOT NULL CHECK (delivery_bytes >= 0), \
           PRIMARY KEY (store_epoch, commit_seq), \
           FOREIGN KEY (store_epoch, commit_seq) \
             REFERENCES local_commits(store_epoch, commit_seq) ON DELETE CASCADE, \
           CHECK (length(store_epoch) BETWEEN 1 AND 512) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE detached_module_receipts ( \
           module_name TEXT NOT NULL, operation_id TEXT NOT NULL, profile_id TEXT NOT NULL, \
           project_id TEXT, adapter_kind TEXT NOT NULL, operation_kind TEXT NOT NULL, \
           store_epoch TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, \
           event_sequence INTEGER, local_commit_seq INTEGER NOT NULL CHECK (local_commit_seq >= 1), \
           commit_manifest_hash TEXT NOT NULL, committed_at TEXT NOT NULL, \
           detached_at_ms INTEGER NOT NULL CHECK (detached_at_ms >= 0), \
           PRIMARY KEY (module_name, operation_id), \
           CHECK (module_name IN ( \
             'library', 'database', 'owned_document', 'project_workspace', \
             'automation', 'store_administration' \
           )), \
           CHECK (length(operation_id) BETWEEN 1 AND 512), \
           CHECK (length(profile_id) BETWEEN 1 AND 512), \
           CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 512), \
           CHECK (adapter_kind IN ('electron_host', 'loopback_http', 'native_cli', 'agent', 'test')), \
           CHECK (length(operation_kind) BETWEEN 1 AND 128), \
           CHECK (length(store_epoch) BETWEEN 1 AND 512), \
           CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (json_valid(result_json) AND json_type(result_json) = 'object'), \
           CHECK (event_sequence IS NULL OR event_sequence >= 1), \
           CHECK (length(commit_manifest_hash) = 64 \
             AND commit_manifest_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (length(committed_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE module_receipt_retention_metadata ( \
           module_name TEXT NOT NULL, operation_id TEXT NOT NULL, \
           issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0), \
           expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= issued_at_ms), \
           receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0), \
           PRIMARY KEY (module_name, operation_id), \
           CHECK (module_name IN ( \
             'library', 'database', 'owned_document', 'project_workspace', \
             'automation', 'store_administration' \
           )), \
           CHECK (length(operation_id) BETWEEN 1 AND 512) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE document_version_retention_index ( \
           version_id TEXT PRIMARY KEY \
             REFERENCES document_versions(version_id) ON DELETE CASCADE, \
           checkpoint_hash TEXT NOT NULL, \
           member_count INTEGER NOT NULL CHECK (member_count >= 0), \
           indexed_at TEXT NOT NULL, \
           CHECK (length(checkpoint_hash) = 64 \
             AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'), \
           CHECK (length(indexed_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE document_version_retention_members ( \
           version_id TEXT NOT NULL \
             REFERENCES document_version_retention_index(version_id) ON DELETE CASCADE, \
           member_kind TEXT NOT NULL CHECK (member_kind IN ('block', 'database_view')), \
           member_id TEXT NOT NULL, \
           PRIMARY KEY (version_id, member_kind, member_id), \
           CHECK (length(member_id) BETWEEN 1 AND 1024) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_document_version_retention_members_identity \
           ON document_version_retention_members(member_kind, member_id, version_id); \
         CREATE TABLE block_retention_state ( \
           id INTEGER PRIMARY KEY CHECK (id = 1), \
           maintenance_revision INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_revision >= 0), \
           updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE TABLE block_retention_deferrals ( \
           root_block_id TEXT PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE, \
           evaluated_commit_seq INTEGER NOT NULL CHECK (evaluated_commit_seq >= 0), \
           retry_after_ms INTEGER NOT NULL CHECK (retry_after_ms >= 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_block_retention_deferrals_retry \
           ON block_retention_deferrals(retry_after_ms, root_block_id); \
         CREATE INDEX idx_blocks_library_lifecycle_updated \
           ON blocks(library_id, lifecycle, updated_at DESC, id DESC); \
         DROP INDEX idx_projection_scope_heads_commit; \
         ALTER TABLE projection_scope_heads RENAME TO projection_scope_heads_v135; \
         CREATE TABLE projection_scope_heads ( \
           store_epoch TEXT NOT NULL, scope_key TEXT NOT NULL, \
           scope_schema_version INTEGER NOT NULL CHECK (scope_schema_version >= 1), \
           scope_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), \
           covered_commit_seq INTEGER NOT NULL CHECK (covered_commit_seq >= 1), \
           effect_hash TEXT NOT NULL, PRIMARY KEY (store_epoch, scope_key), \
           CHECK (length(store_epoch) BETWEEN 1 AND 512), \
           CHECK (length(scope_key) BETWEEN 1 AND 128), \
           CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'), \
           CHECK (length(effect_hash) = 64 AND effect_hash NOT GLOB '*[^0-9a-f]*') \
         ) WITHOUT ROWID, STRICT; \
         INSERT INTO projection_scope_heads \
           SELECT * FROM projection_scope_heads_v135; \
         DROP TABLE projection_scope_heads_v135; \
         CREATE INDEX idx_projection_scope_heads_commit \
           ON projection_scope_heads(store_epoch, covered_commit_seq); \
         CREATE TABLE operational_journal_state ( \
           id INTEGER PRIMARY KEY CHECK (id = 1), \
           commit_head_seq INTEGER NOT NULL DEFAULT 0 CHECK (commit_head_seq >= 0), \
           replay_floor_seq INTEGER NOT NULL DEFAULT 0 CHECK (replay_floor_seq >= 0), \
           maintenance_revision INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_revision >= 0), \
           retained_commit_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_commit_count >= 0), \
           retained_delivery_bytes INTEGER NOT NULL DEFAULT 0 \
             CHECK (retained_delivery_bytes >= 0), \
           delivery_pressure_active INTEGER NOT NULL DEFAULT 0 \
             CHECK (delivery_pressure_active IN (0, 1)), \
           pending_metadata_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_metadata_count >= 0), \
           metadata_backfill_cursor_seq INTEGER NOT NULL DEFAULT 0 \
             CHECK (metadata_backfill_cursor_seq >= 0), \
           retained_receipt_count INTEGER NOT NULL DEFAULT 0 \
             CHECK (retained_receipt_count >= 0), \
           retained_receipt_bytes INTEGER NOT NULL DEFAULT 0 \
             CHECK (retained_receipt_bytes >= 0), \
           receipt_pressure_active INTEGER NOT NULL DEFAULT 0 \
             CHECK (receipt_pressure_active IN (0, 1)), \
           pending_receipt_metadata_count INTEGER NOT NULL DEFAULT 0 \
             CHECK (pending_receipt_metadata_count >= 0), \
           receipt_backfill_cursor_module TEXT, \
           receipt_backfill_cursor_operation_id TEXT, \
           receipt_floor_at TEXT, \
           receipt_floor_module TEXT, \
           receipt_floor_operation_id TEXT, \
           operation_identity_cutover_at TEXT NOT NULL, \
           last_pruned_commit_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_pruned_commit_seq >= 0), \
           policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1), \
           updated_at TEXT NOT NULL, \
           CHECK (receipt_floor_at IS NULL OR length(receipt_floor_at) > 0), \
           CHECK ( \
             (receipt_backfill_cursor_module IS NULL \
               AND receipt_backfill_cursor_operation_id IS NULL) \
             OR (receipt_backfill_cursor_module IN ( \
                 'library', 'database', 'owned_document', 'project_workspace', \
                 'automation', 'store_administration' \
               ) \
               AND length(receipt_backfill_cursor_operation_id) BETWEEN 1 AND 512) \
           ), \
           CHECK ( \
             (receipt_floor_at IS NULL AND receipt_floor_module IS NULL \
               AND receipt_floor_operation_id IS NULL) \
             OR (receipt_floor_at IS NOT NULL \
               AND receipt_floor_module IN ( \
                 'library', 'database', 'owned_document', 'project_workspace', \
                 'automation', 'store_administration' \
               ) \
               AND length(receipt_floor_operation_id) BETWEEN 1 AND 512) \
           ), \
           CHECK (length(operation_identity_cutover_at) > 0) \
         ) WITHOUT ROWID, STRICT; \
         CREATE INDEX idx_local_commits_retention \
           ON local_commits(store_epoch, committed_at, commit_seq); \
         CREATE INDEX idx_local_commit_retention_metadata_age \
           ON local_commit_retention_metadata(store_epoch, sealed_at_ms, commit_seq); \
         CREATE INDEX idx_document_versions_source_change \
           ON document_versions(source_change_seq) WHERE source_change_seq IS NOT NULL; \
         CREATE INDEX idx_database_module_receipts_change_log \
           ON database_module_receipts(change_log_seq) WHERE change_log_seq IS NOT NULL; \
         CREATE INDEX idx_core_module_receipts_event_sequence \
           ON core_module_receipts(event_sequence) WHERE event_sequence IS NOT NULL; \
         CREATE INDEX idx_core_module_receipts_retention \
           ON core_module_receipts(committed_at, module_name, operation_id); \
         CREATE INDEX idx_detached_module_receipts_retention \
           ON detached_module_receipts(detached_at_ms, local_commit_seq); \
         CREATE INDEX idx_detached_module_receipts_expiry \
           ON detached_module_receipts(operation_kind, committed_at, module_name, operation_id); \
         CREATE INDEX idx_module_receipt_retention_expiry \
           ON module_receipt_retention_metadata(expires_at_ms, issued_at_ms, module_name, operation_id); \
         CREATE INDEX idx_module_receipt_retention_prune \
           ON module_receipt_retention_metadata(issued_at_ms, module_name, operation_id);",
    )?;
    connection.execute(
        "INSERT INTO block_retention_state(id, maintenance_revision, updated_at_ms) \
         VALUES (1, 0, ?1)",
        [context.completed_at_unix_ms],
    )?;
    connection.execute(
        "INSERT INTO operational_journal_state( \
           id, commit_head_seq, replay_floor_seq, maintenance_revision, \
           retained_commit_count, retained_delivery_bytes, pending_metadata_count, \
           retained_receipt_count, retained_receipt_bytes, \
           pending_receipt_metadata_count, operation_identity_cutover_at, \
           last_pruned_commit_seq, policy_version, updated_at \
         ) VALUES (1, \
           COALESCE((SELECT max(commit_seq) FROM local_commits WHERE finalized = 1), 0), \
           COALESCE((SELECT min(commit_seq) FROM local_commits WHERE finalized = 1), 0), \
           0, \
           (SELECT count(*) FROM local_commits WHERE finalized = 1), 0, \
           (SELECT count(*) FROM local_commits WHERE finalized = 1), \
           (SELECT count(*) FROM core_module_receipts), 0, \
           (SELECT count(*) FROM core_module_receipts), ?1, \
           0, 1, ?1)",
        [timestamp_from_unix_ms(context.completed_at_unix_ms)?],
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}')",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v136_to_v137(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "DROP TRIGGER page_read_model_validate_insert;
         DROP TRIGGER page_read_model_validate_update;
         CREATE TRIGGER page_read_model_validate_insert BEFORE INSERT ON page_read_model
         WHEN NOT EXISTS (
           SELECT 1 FROM blocks block
           JOIN pages page ON page.block_id = block.id
           JOIN block_documents ownership
             ON ownership.block_id = page.block_id
            AND ownership.document_id = page.document_id
            AND ownership.library_id = page.library_id
           JOIN documents document ON document.id = page.document_id
           LEFT JOIN library_block_placements placement
             ON placement.block_id = page.block_id AND page.parent_kind = 'library'
           WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
             AND block.type = 'page' AND page.parent_kind = NEW.parent_kind
             AND page.parent_id = NEW.parent_id
             AND page.document_id = NEW.document_id
             AND document.library_id = NEW.library_id
             AND document.generation = NEW.document_generation
             AND document.head_seq = NEW.document_projected_seq
             AND document.schema_version = NEW.document_schema_version
             AND document.authority = NEW.document_authority
             AND block.lifecycle = NEW.lifecycle
             AND block.placement_revision = NEW.placement_revision
             AND block.metadata_revision = NEW.metadata_revision
             AND (
               (page.parent_kind = 'library' AND block.lifecycle <> 'deleted'
                 AND placement.rank_key = NEW.library_rank_key)
               OR ((page.parent_kind <> 'library' OR block.lifecycle = 'deleted')
                 AND NEW.library_rank_key IS NULL)
             )
         ) OR (
           NEW.membership_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM data_source_page_memberships membership
             JOIN data_sources source ON source.id = membership.data_source_id
             WHERE membership.id = NEW.membership_id
               AND membership.page_block_id = NEW.page_block_id
               AND membership.removed_at IS NULL
               AND source.home_database_block_id = NEW.database_block_id
           )
         ) OR (
           NEW.view_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM database_views view
             JOIN data_source_page_memberships membership
               ON membership.id = NEW.membership_id
              AND membership.data_source_id = view.data_source_id
             WHERE view.id = NEW.view_id AND view.database_block_id = NEW.database_block_id
           )
         ) BEGIN
           SELECT RAISE(ABORT, 'Page read model source coordinates are invalid or stale');
         END;
         CREATE TRIGGER page_read_model_validate_update BEFORE UPDATE ON page_read_model
         WHEN NOT EXISTS (
           SELECT 1 FROM blocks block
           JOIN pages page ON page.block_id = block.id
           JOIN block_documents ownership
             ON ownership.block_id = page.block_id
            AND ownership.document_id = page.document_id
            AND ownership.library_id = page.library_id
           JOIN documents document ON document.id = page.document_id
           LEFT JOIN library_block_placements placement
             ON placement.block_id = page.block_id AND page.parent_kind = 'library'
           WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
             AND block.type = 'page' AND page.parent_kind = NEW.parent_kind
             AND page.parent_id = NEW.parent_id
             AND page.document_id = NEW.document_id
             AND document.library_id = NEW.library_id
             AND document.generation = NEW.document_generation
             AND document.head_seq = NEW.document_projected_seq
             AND document.schema_version = NEW.document_schema_version
             AND document.authority = NEW.document_authority
             AND block.lifecycle = NEW.lifecycle
             AND block.placement_revision = NEW.placement_revision
             AND block.metadata_revision = NEW.metadata_revision
             AND (
               (page.parent_kind = 'library' AND block.lifecycle <> 'deleted'
                 AND placement.rank_key = NEW.library_rank_key)
               OR ((page.parent_kind <> 'library' OR block.lifecycle = 'deleted')
                 AND NEW.library_rank_key IS NULL)
             )
         ) OR (
           NEW.membership_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM data_source_page_memberships membership
             JOIN data_sources source ON source.id = membership.data_source_id
             WHERE membership.id = NEW.membership_id
               AND membership.page_block_id = NEW.page_block_id
               AND membership.removed_at IS NULL
               AND source.home_database_block_id = NEW.database_block_id
           )
         ) OR (
           NEW.view_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM database_views view
             JOIN data_source_page_memberships membership
               ON membership.id = NEW.membership_id
              AND membership.data_source_id = view.data_source_id
             WHERE view.id = NEW.view_id AND view.database_block_id = NEW.database_block_id
           )
         ) BEGIN
           SELECT RAISE(ABORT, 'Page read model source coordinates are invalid or stale');
         END;
         DROP TRIGGER scheduled_page_index_require_page_insert;
         DROP TRIGGER scheduled_page_index_require_page_update;
         CREATE TRIGGER scheduled_page_index_require_page_insert BEFORE INSERT ON scheduled_page_index
         WHEN NOT EXISTS (
           SELECT 1 FROM blocks block
           JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id
           JOIN block_documents ownership
             ON ownership.block_id = page.block_id
            AND ownership.document_id = page.document_id
            AND ownership.library_id = page.library_id
           WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
             AND block.type = 'page'
             AND block.lifecycle = NEW.lifecycle
             AND block.metadata_revision = NEW.source_metadata_revision
         ) BEGIN
           SELECT RAISE(ABORT, 'Scheduled Page index owner must be a Page in the Library');
         END;
         CREATE TRIGGER scheduled_page_index_require_page_update
         BEFORE UPDATE OF page_block_id, library_id, lifecycle, source_metadata_revision
         ON scheduled_page_index
         WHEN NOT EXISTS (
           SELECT 1 FROM blocks block
           JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id
           JOIN block_documents ownership
             ON ownership.block_id = page.block_id
            AND ownership.document_id = page.document_id
            AND ownership.library_id = page.library_id
           WHERE block.id = NEW.page_block_id AND block.library_id = NEW.library_id
             AND block.type = 'page'
             AND block.lifecycle = NEW.lifecycle
             AND block.metadata_revision = NEW.source_metadata_revision
         ) BEGIN
           SELECT RAISE(ABORT, 'Scheduled Page index owner must be a Page in the Library');
         END;",
    )?;
    migrate_block_children_contract(connection, context.completed_at_unix_ms)?;
    let document = repair_document_schema_projections(connection, context.completed_at_unix_ms)?;
    let completed_at = timestamp_from_unix_ms(context.completed_at_unix_ms)?;
    let refreshed_scheduled_pages = repair_scheduled_page_indexes(connection, &completed_at)?;
    let evidence = serde_json::json!({
        "document": document,
        "refreshedScheduledPages": refreshed_scheduled_pages,
    });
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            serde_json::to_string(&evidence).map_err(|_| internal(
                "Document projection repair evidence could not be encoded"
            ))?,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v137_to_v138(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v137_to_v138.sql"))?;
    connection.execute(
        "INSERT INTO page_file_manifests(page_id, library_id, revision, updated_at) \
         SELECT block_id, library_id, 0, updated_at FROM pages",
        [],
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object('page_file_manifests', \
           (SELECT count(*) FROM page_file_manifests)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v138_to_v139(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v138_to_v139.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object('page_file_manifests', \
           (SELECT count(*) FROM page_file_manifests)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v139_to_v140(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v139_to_v140.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object('page_file_placements', \
           (SELECT count(*) FROM block_asset_refs WHERE page_file_id IS NOT NULL)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v140_to_v141(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v140_to_v141.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'page_file_versions', (SELECT count(*) FROM page_file_versions), \
           'page_files', (SELECT count(*) FROM page_files)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v141_to_v142(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v141_to_v142.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'sidebar_sections', (SELECT count(*) FROM workspace_sidebar_sections), \
           'sidebar_section_items', (SELECT count(*) FROM workspace_sidebar_section_items)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

#[derive(Debug)]
struct LegacyDatabaseView {
    id: String,
    database_id: String,
    data_source_id: String,
    name: String,
    layout: String,
    config_json: String,
    revision: i64,
    lifecycle: String,
    created_at: String,
    updated_at: String,
}

fn migrate_view_definition_for_layout(encoded: &str, layout: &str) -> Result<String, StoreError> {
    let layout = match layout {
        "board" => nodex_core_contracts::database::DatabaseViewLayout::Board,
        "list" => nodex_core_contracts::database::DatabaseViewLayout::List,
        _ => return Err(internal("Legacy Database View layout is unsupported")),
    };
    crate::database::view_contract::upgrade_legacy_definition_json(encoded, layout)
        .map_err(internal)
}

fn migrate_view_override_for_layout(encoded: &str, layout: &str) -> Result<String, StoreError> {
    let mut value = serde_json::from_str::<Value>(encoded)
        .map_err(|_| internal("Legacy Database View preference is invalid"))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| internal("Legacy Database View preference is not an object"))?;
    root.remove("layout");
    if let Some(mut layouts) = root
        .remove("layouts")
        .and_then(|candidate| candidate.as_object().cloned())
        && let Some(display) = layouts.remove(layout)
    {
        root.insert("display".to_owned(), display);
    }
    serde_json::to_string(&value)
        .map_err(|_| internal("Migrated Database View preference cannot be encoded"))
}

fn migrated_view_name(name: &str, layout: &str) -> String {
    let normalized = name.trim();
    if normalized.is_empty()
        || normalized.eq_ignore_ascii_case("kanban")
        || normalized.eq_ignore_ascii_case("board")
        || normalized.eq_ignore_ascii_case("list")
    {
        return if layout == "board" { "Board" } else { "List" }.to_owned();
    }
    let suffix = if layout == "board" { "Board" } else { "List" };
    format!("{normalized} · {suffix}")
}

fn unique_migrated_view_name(
    database_id: &str,
    candidate: String,
    used_names: &mut std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
) -> String {
    let used = used_names.entry(database_id.to_owned()).or_default();
    let mut suffix = 1_u64;
    loop {
        let name = if suffix == 1 {
            candidate.clone()
        } else {
            format!("{candidate} {suffix}")
        };
        if used.insert(name.to_lowercase()) {
            return name;
        }
        suffix += 1;
    }
}

fn migrate_v142_to_v143(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v142_to_v143.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'sidebar_sections', (SELECT count(*) FROM workspace_sidebar_sections), \
           'sidebar_section_items', (SELECT count(*) FROM workspace_sidebar_section_items), \
           'sidebar_section_host_links', \
             (SELECT count(*) FROM workspace_sidebar_section_host_links)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v143_to_v144(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v143_to_v144.sql"))?;
    let views = connection
        .prepare(
            "SELECT id, database_block_id, data_source_id, name, layout, config_json, \
                    revision, lifecycle, created_at, updated_at \
             FROM database_views ORDER BY database_block_id, rank_key, id",
        )?
        .query_map([], |row| {
            Ok(LegacyDatabaseView {
                id: row.get(0)?,
                database_id: row.get(1)?,
                data_source_id: row.get(2)?,
                name: row.get(3)?,
                layout: row.get(4)?,
                config_json: row.get(5)?,
                revision: row.get(6)?,
                lifecycle: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut expanded_orders = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut used_names = std::collections::BTreeMap::new();
    for view in views {
        let retained_layout = view.layout.as_str();
        let sibling_layout = match retained_layout {
            "board" => "list",
            "list" => "board",
            _ => return Err(internal("Legacy Database View layout is unsupported")),
        };
        let sibling_id = random_uuid_v7()
            .map_err(|_| internal("Migrated Database View identity entropy failed"))?;
        let retained_name = unique_migrated_view_name(
            &view.database_id,
            migrated_view_name(&view.name, retained_layout),
            &mut used_names,
        );
        let sibling_name = unique_migrated_view_name(
            &view.database_id,
            migrated_view_name(&view.name, sibling_layout),
            &mut used_names,
        );
        expanded_orders
            .entry(view.database_id.clone())
            .or_default()
            .extend([view.id.clone(), sibling_id.clone()]);
        let retained_config =
            migrate_view_definition_for_layout(&view.config_json, retained_layout)?;
        let sibling_config = migrate_view_definition_for_layout(&view.config_json, sibling_layout)?;
        connection.execute(
            "UPDATE database_views SET name = ?1, config_json = ?2 WHERE id = ?3",
            params![retained_name, retained_config, view.id],
        )?;
        connection.execute(
            "INSERT INTO database_views( \
               id, database_block_id, data_source_id, name, layout, config_json, revision, \
               rank_key, lifecycle, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '0', ?8, ?9, ?10)",
            params![
                sibling_id,
                view.database_id,
                view.data_source_id,
                sibling_name,
                sibling_layout,
                sibling_config,
                view.revision,
                view.lifecycle,
                view.created_at,
                view.updated_at,
            ],
        )?;
        connection.execute(
            "INSERT INTO database_view_page_positions( \
               view_id, page_block_id, rank_key, revision, created_at, updated_at \
             ) SELECT ?1, page_block_id, rank_key, revision, created_at, updated_at \
               FROM database_view_page_positions WHERE view_id = ?2",
            params![sibling_id, view.id],
        )?;
        connection.execute(
            "INSERT INTO database_view_collapsed_occurrences( \
               profile_id, view_id, target_kind, occurrence_key, collapsed_at \
             ) SELECT profile_id, ?1, target_kind, occurrence_key, collapsed_at \
               FROM database_view_collapsed_occurrences WHERE view_id = ?2",
            params![sibling_id, view.id],
        )?;
        let preferences = connection
            .prepare(
                "SELECT profile_id, presentation_override_json, revision, created_at, updated_at \
                 FROM database_view_personal_presentations WHERE view_id = ?1",
            )?
            .query_map([&view.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (profile_id, encoded, revision, created_at, updated_at) in preferences {
            let retained = migrate_view_override_for_layout(&encoded, retained_layout)?;
            let sibling = migrate_view_override_for_layout(&encoded, sibling_layout)?;
            connection.execute(
                "UPDATE database_view_personal_presentations \
                 SET presentation_override_json = ?1 WHERE profile_id = ?2 AND view_id = ?3",
                params![retained, profile_id, view.id],
            )?;
            connection.execute(
                "INSERT INTO database_view_personal_presentations( \
                   profile_id, view_id, presentation_override_json, revision, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![profile_id, sibling_id, sibling, revision, created_at, updated_at],
            )?;
        }
    }
    for (database_id, view_ids) in expanded_orders {
        let ranks = materialize_order(&view_ids).map_err(|error| {
            internal(format!("Migrated View order is invalid: {}", error.message))
        })?;
        for (view_id, rank_key) in ranks {
            connection.execute(
                "UPDATE database_views SET rank_key = ?1 WHERE database_block_id = ?2 AND id = ?3",
                params![rank_key, database_id, view_id],
            )?;
        }
    }
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'database_views', (SELECT count(*) FROM database_views), \
           'page_layouts', (SELECT count(*) FROM data_source_page_layouts)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v144_to_v145(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v144_to_v145.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'retired_property_ids', (SELECT count(*) FROM retired_data_source_property_ids)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v145_to_v146(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v145_to_v146.sql"))?;

    let views = connection
        .prepare("SELECT id, data_source_id, config_json FROM database_views ORDER BY id")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut property_types_by_source = std::collections::BTreeMap::new();
    for (_, data_source_id, _) in &views {
        if property_types_by_source.contains_key(data_source_id) {
            continue;
        }
        let property_types = connection
            .prepare(
                "SELECT id, value_type FROM data_source_properties \
                 WHERE data_source_id = ?1 ORDER BY id",
            )?
            .query_map([data_source_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>()?;
        property_types_by_source.insert(data_source_id.clone(), property_types);
    }
    for (view_id, data_source_id, encoded) in &views {
        let property_types = property_types_by_source
            .get(data_source_id)
            .ok_or_else(|| internal("Database View migration lost its Property registry"))?;
        let upgraded =
            crate::database::view_contract::upgrade_v5_definition_json(encoded, &|property_id| {
                property_types.get(property_id).cloned()
            })
            .map_err(internal)?;
        connection.execute(
            "UPDATE database_views SET config_json = ?1 WHERE id = ?2",
            params![upgraded, view_id],
        )?;
    }

    let preferences = connection
        .prepare(
            "SELECT preference.profile_id, preference.view_id, view.data_source_id, \
                    preference.preferences_json \
             FROM database_view_personal_preferences preference \
             JOIN database_views view ON view.id = preference.view_id \
             ORDER BY preference.profile_id, preference.view_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (profile_id, view_id, data_source_id, encoded) in preferences {
        let property_types = property_types_by_source
            .get(&data_source_id)
            .ok_or_else(|| {
                internal("Database View preference migration lost its Property registry")
            })?;
        let upgraded = upgrade_v5_preferences_json(&encoded, &|property_id| {
            property_types.get(property_id).cloned()
        })?;
        connection.execute(
            "UPDATE database_view_personal_preferences SET preferences_json = ?1 \
             WHERE profile_id = ?2 AND view_id = ?3",
            params![upgraded, profile_id, view_id],
        )?;
    }

    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'database_views', (SELECT count(*) FROM database_views), \
           'personal_preferences', (SELECT count(*) FROM database_view_personal_preferences)))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn normalize_filter_value_arity(filter: &mut Value) -> Result<u64, StoreError> {
    let node = filter
        .as_object_mut()
        .ok_or_else(|| internal("Database View filter repair found a non-object node"))?;
    match node.get("kind").and_then(Value::as_str) {
        Some("group") => {
            let children = node
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| internal("Database View filter repair found invalid children"))?;
            children.iter_mut().try_fold(0_u64, |count, child| {
                normalize_filter_value_arity(child).map(|repaired| count + repaired)
            })
        }
        Some("clause") => {
            let operator = node
                .get("operator")
                .and_then(Value::as_str)
                .ok_or_else(|| internal("Database View filter repair found no operator"))?;
            let valueless = matches!(operator, "is_empty" | "is_not_empty");
            if valueless && node.remove("value").is_some() {
                return Ok(1);
            }
            if !valueless && !node.contains_key("value") {
                node.insert("value".to_owned(), Value::Null);
                return Ok(1);
            }
            Ok(0)
        }
        _ => Err(internal(
            "Database View filter repair found an unsupported node kind",
        )),
    }
}

fn normalize_stored_view_filter_arities(value: &mut Value) -> Result<u64, StoreError> {
    let mut repaired = 0;
    if let Some(property_filters) = value
        .pointer_mut("/rules/propertyFilters")
        .and_then(Value::as_array_mut)
    {
        for filter in property_filters {
            if let Some(clause) = filter.get_mut("clause") {
                repaired += normalize_filter_value_arity(clause)?;
            }
        }
    }
    if let Some(advanced_filter) = value.pointer_mut("/rules/advancedFilter")
        && !advanced_filter.is_null()
    {
        repaired += normalize_filter_value_arity(advanced_filter)?;
    }
    Ok(repaired)
}

fn normalize_stored_preference_filter_arities(value: &mut Value) -> Result<u64, StoreError> {
    let mut repaired = 0;
    if let Some(property_filters) = value
        .pointer_mut("/rules_override/property_filters")
        .and_then(Value::as_array_mut)
    {
        for filter in property_filters {
            if let Some(clause) = filter.get_mut("clause") {
                repaired += normalize_filter_value_arity(clause)?;
            }
        }
    }
    if let Some(advanced_filter) = value.pointer_mut("/rules_override/advanced_filter/filter") {
        repaired += normalize_filter_value_arity(advanced_filter)?;
    }
    Ok(repaired)
}

fn migrate_v146_to_v147(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v146_to_v147.sql"))?;

    let views = connection
        .prepare("SELECT id, config_json FROM database_views ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut repaired_view_clauses = 0_u64;
    for (view_id, encoded) in views {
        let mut value = serde_json::from_str::<Value>(&encoded)
            .map_err(|_| internal("Database View filter repair found invalid config JSON"))?;
        let repaired = normalize_stored_view_filter_arities(&mut value)?;
        if repaired == 0 {
            continue;
        }
        repaired_view_clauses += repaired;
        connection.execute(
            "UPDATE database_views SET config_json = ?1 WHERE id = ?2",
            params![value.to_string(), view_id],
        )?;
    }

    let preferences = connection
        .prepare(
            "SELECT profile_id, view_id, preferences_json \
             FROM database_view_personal_preferences ORDER BY profile_id, view_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut repaired_preference_clauses = 0_u64;
    for (profile_id, view_id, encoded) in preferences {
        let mut value = serde_json::from_str::<Value>(&encoded)
            .map_err(|_| internal("Database View filter repair found invalid preference JSON"))?;
        let repaired = normalize_stored_preference_filter_arities(&mut value)?;
        if repaired == 0 {
            continue;
        }
        repaired_preference_clauses += repaired;
        connection.execute(
            "UPDATE database_view_personal_preferences SET preferences_json = ?1 \
             WHERE profile_id = ?2 AND view_id = ?3",
            params![value.to_string(), profile_id, view_id],
        )?;
    }
    let repaired_view_clauses = i64::try_from(repaired_view_clauses)
        .map_err(|_| internal("Database View filter repair count exceeded its bound"))?;
    let repaired_preference_clauses = i64::try_from(repaired_preference_clauses)
        .map_err(|_| internal("Database View preference repair count exceeded its bound"))?;

    connection.execute(
        "INSERT INTO core_store_migration_history( \
           source_revision, target_revision, source_schema_fingerprint, \
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object( \
           'repaired_view_filter_clauses', ?7, \
           'repaired_preference_filter_clauses', ?8))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            repaired_view_clauses,
            repaired_preference_clauses,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v147_to_v148(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v147_to_v148.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object(
           'subagent_projection_tables', 6))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v148_to_v149(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v148_to_v149.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object(
           'removed_thread_runtime_binding_columns', 2,
           'removed_automation_runtime_binding_columns', 2))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v149_to_v150(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v149_to_v150.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object(
           'explicit_agent_backend_bindings', 2,
           'durable_backend_session_tables', 1))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v150_to_v151(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v150_to_v151.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object(
           'durable_recovery_drafts', 1))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v151_to_v152(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    let evidence = super::library_files_migration::migrate_v151_to_v152(
        connection,
        context.completed_at_unix_ms,
    )?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            evidence,
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v152_to_v159(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v152_to_v159.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(
           source_revision, target_revision, source_schema_fingerprint,
           target_schema_fingerprint, backup_name, completed_at_unix_ms, evidence_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object('surface_history_and_complete_view_order', 1))",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v159_to_v160(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    let now: String = connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1 / 1000.0, 'unixepoch')",
        [context.completed_at_unix_ms],
        |row| row.get(0),
    )?;
    let evidence = crate::document::migrate_document_assets(connection, &now)?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision, target_revision,
           source_schema_fingerprint, target_schema_fingerprint, backup_name,
           completed_at_unix_ms, evidence_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            serde_json::to_string(&evidence)
                .map_err(|_| internal("Asset migration evidence cannot be encoded"))?
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v160_to_v161(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    // Historical Turns have no proven execution policy and remain read-only.
    connection.execute_batch("ALTER TABLE nodex_agent_turn_authorities ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1 CHECK (read_only IN (0, 1));")?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision, target_revision,
           source_schema_fingerprint, target_schema_fingerprint, backup_name,
           completed_at_unix_ms, evidence_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            r#"{"historical_turns_read_only":true}"#
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v161_to_v162(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch("ALTER TABLE codex_scheduled_automations ADD COLUMN notification_policy TEXT CHECK (notification_policy IS NULL OR notification_policy = 'failed_runs_only');")?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision, target_revision,
           source_schema_fingerprint, target_schema_fingerprint, backup_name,
           completed_at_unix_ms, evidence_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.source_revision,
            context.target_revision,
            context.source_schema_fingerprint,
            context.target_schema_fingerprint,
            context.backup_name,
            context.completed_at_unix_ms,
            r#"{"automation_notification_preferences":true}"#
        ],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v162_to_v163(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch("ALTER TABLE codex_scheduled_automations RENAME COLUMN target_thread_id TO target_session_id;
        UPDATE codex_scheduled_automations SET
          status = CASE WHEN status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM project_session_threads WHERE thread_id = target_session_id) THEN 'PAUSED' ELSE status END,
          next_run_at = CASE WHEN NOT EXISTS (SELECT 1 FROM project_session_threads WHERE thread_id = target_session_id) THEN NULL ELSE next_run_at END,
          target_session_id = (SELECT session_id FROM project_session_threads WHERE thread_id = target_session_id)
        WHERE kind = 'heartbeat';")?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint, context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms, r#"{"automation_session_targets":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v163_to_v164(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch("ALTER TABLE codex_scheduled_automations ADD COLUMN project_id TEXT CHECK (project_id IS NULL OR (project_id = trim(project_id) AND length(project_id) BETWEEN 1 AND 512));
        UPDATE codex_scheduled_automations SET project_id = (
          SELECT CASE WHEN count(*) = 1 THEN min(p.id) ELSE NULL END FROM projects p
          WHERE p.lifecycle = 'active' AND json_array_length(cwds_json) > 0
            AND NOT EXISTS (SELECT 1 FROM json_each(cwds_json) cwd WHERE NOT EXISTS (SELECT 1 FROM project_sources source WHERE source.project_id = p.id AND source.root = cwd.value))
        ) WHERE kind = 'cron';
        UPDATE codex_scheduled_automations SET status = CASE WHEN status = 'ACTIVE' THEN 'PAUSED' ELSE status END, next_run_at = NULL
          WHERE kind = 'cron' AND project_id IS NULL AND (json_array_length(cwds_json) > 0 OR execution_environment <> 'local' OR local_environment_config_path IS NOT NULL);")?;
    connection.execute("INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![context.source_revision,context.target_revision,context.source_schema_fingerprint,context.target_schema_fingerprint,context.backup_name,context.completed_at_unix_ms,r#"{"automation_project_targets":true}"#])?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v168_to_v169(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v168_to_v169.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"retired_queued_payload_ledgers":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v169_to_v170(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v169_to_v170.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"thread_workspace_transition_state":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v170_to_v171(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v170_to_v171.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"retired_subagent_lifecycle_ledger":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v171_to_v172(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v171_to_v172.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"native_claude_backend":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// Inbox entries record which Inbox owns their decision instead of inferring it from where
/// their Page lives.
fn migrate_v183_to_v184(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v183_to_v184.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_decisions":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v185_to_v186(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v185_to_v186.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"page_layout_hides_empty_properties":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// Inbox handoffs freeze the Library images of the messages they deliver.
fn migrate_v186_to_v187(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v186_to_v187.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_handoff_images":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// Inbox entries carry the user's importance mark.
fn migrate_v187_to_v188(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v187_to_v188.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_entries_important":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// Derivation changes are Store format changes even when the canonical Yrs
/// schema is unchanged. The source was proven before the migration backup.
fn migrate_v188_to_v189(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v188_to_v189.sql"))?;
    migrate_block_document_baselines(connection, context.completed_at_unix_ms)?;
    let rebuilt = upgrade_document_markdown_derivation(connection)?;
    validate_restore_documents(connection)?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            json!({"document_materialization_derivation": 3, "rebuilt_documents": rebuilt}).to_string()],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v190_to_v191(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v190_to_v191.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"temporary_side_chats":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// All unreleased Nodex Markdown document normalizations share this version.
fn migrate_v191_to_v192(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    let evidence = migrate_nodex_markdown_contract(connection, context.completed_at_unix_ms)?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            serde_json::to_string(&evidence).map_err(|_| internal("Nodex Markdown migration evidence could not be encoded"))?],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v189_to_v190(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v189_to_v190.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"session_search_usage":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v193_to_v194(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v193_to_v194.sql"))?;
    migrate_inbox_handoff_images(connection)?;
    migrate_inbox_content_bases(connection)?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_content_fingerprints":true,"inbox_send_advice":true,"inbox_frozen_suggestion_inputs":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// A legacy Inbox basis has no File-version binding. Even a matching Document head
/// cannot prove current bytes: File replacement does not advance that head. Only a
/// never-replaced File is unambiguous; uncertain evidence must remain outdated.
fn legacy_inbox_image_hash(
    connection: &Connection,
    file_id: &str,
) -> Result<Option<String>, StoreError> {
    use rusqlite::OptionalExtension;
    Ok(connection.query_row(
        "SELECT version.blob_hash FROM library_files file JOIN file_versions version ON version.file_id=file.file_id AND version.version=1 WHERE file.file_id=?1 AND file.head_version=1 AND NOT EXISTS(SELECT 1 FROM file_versions other WHERE other.file_id=file.file_id AND other.version<>1)",
        [file_id], |row| row.get(0),
    ).optional()?)
}

/// Pre-v194 handoffs retained image identities but no reviewed digests. Never attach a
/// newer head to that confirmation; ambiguous or collected images remain unavailable.
fn migrate_inbox_handoff_images(connection: &Connection) -> Result<(), StoreError> {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxMessageImage;
    let rows = connection
        .prepare("SELECT proposal_id,images_json FROM inbox_handoffs")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (proposal_id, json) in rows {
        let sources: Vec<String> = serde_json::from_str(&json)
            .map_err(|_| corrupt("Stored Inbox handoff images are invalid"))?;
        let images = sources
            .into_iter()
            .map(|source| {
                let file_id = crate::domain::derived_records::parse_page_file_source(&source)
                    .ok_or_else(|| corrupt("Stored Inbox image is not a Library File"))?;
                let content_hash =
                    legacy_inbox_image_hash(connection, &file_id)?.unwrap_or_else(|| {
                        crate::document::sha256(
                            format!("unavailable-inbox-handoff-image:{proposal_id}:{file_id}")
                                .as_bytes(),
                        )
                    });
                Ok(ProjectWorkspaceInboxMessageImage {
                    source,
                    file_id,
                    content_hash,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        connection.execute(
            "UPDATE inbox_handoffs SET images_json=?2 WHERE proposal_id=?1",
            params![
                proposal_id,
                serde_json::to_string(&images)
                    .map_err(|_| corrupt("Stored Inbox handoff images are invalid"))?
            ],
        )?;
    }
    Ok(())
}

/// Legacy coordinates are decoded only here. Retained Yrs history recovers the actual
/// written text; pruned history keeps a distinct fingerprint so it cannot claim to be current.
pub(crate) fn migrate_inbox_content_bases(connection: &Connection) -> Result<(), StoreError> {
    use rusqlite::OptionalExtension;
    #[derive(Deserialize)]
    struct LegacyBasis {
        page_id: String,
        generation: i64,
        head_seq: i64,
    }
    fn historical_content(
        connection: &Connection,
        old: &LegacyBasis,
    ) -> Result<Option<crate::workspace::inbox_content::MessageContent>, StoreError> {
        let retained: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_entries WHERE page_id=?1)",
            [&old.page_id],
            |row| row.get(0),
        )?;
        if !retained {
            return Ok(None);
        }
        let document_id = connection
            .query_row(
                "SELECT document_id FROM pages WHERE block_id=?1",
                [&old.page_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(document_id) = document_id else {
            return Ok(None);
        };
        let repository =
            crate::infrastructure::document_repository::DocumentReadRepository::new(connection);
        let Some(head) = repository.document_head(&document_id)? else {
            return Ok(None);
        };
        if head.generation != old.generation || old.head_seq > head.head_seq {
            return Ok(None);
        }
        let snapshot = repository.latest_snapshot(&head.id, old.generation, old.head_seq)?;
        let mut through = snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.snapshot_seq);
        let mut engine = match snapshot {
            Some(snapshot) => crate::document::YrsDocumentEngine::from_full_state_v1(
                &head.id,
                &snapshot.snapshot_update,
            )
            .map_err(|_| corrupt("Stored Inbox snapshot is invalid"))?,
            None => crate::document::YrsDocumentEngine::new(&head.id),
        };
        for update in repository.updates_between(&head.id, old.generation, through, old.head_seq)? {
            if update.seq != through + 1 {
                return Ok(None);
            }
            let candidate = engine
                .prepare_update_v1(&update.update_blob)
                .map_err(|_| corrupt("Stored Inbox update is invalid"))?;
            engine
                .commit_candidate(candidate)
                .map_err(|_| corrupt("Stored Inbox update is invalid"))?;
            through = update.seq;
        }
        if through != old.head_seq {
            return Ok(None);
        }
        let schema = crate::document::BlockDocumentSchema::from_identity(
            &head.schema_key,
            head.schema_version,
        )
        .ok_or_else(|| corrupt("Stored Inbox schema is unavailable"))?;
        let decoded = crate::document::decode_block_document(engine.document(), schema)
            .map_err(|_| corrupt("Stored Inbox document is invalid"))?;
        let materialized = crate::document::materialize_decoded_document(&decoded)
            .map_err(|_| corrupt("Stored Inbox text is invalid"))?;
        let mut content = crate::workspace::inbox_content::content_from_markdown(
            connection,
            materialized.markdown,
        )?;
        for image in &mut content.images {
            let Some(hash) = legacy_inbox_image_hash(connection, &image.file_id)? else {
                return Ok(None);
            };
            image.content_hash = hash;
        }
        Ok(Some(content))
    }
    fn migrate_basis(connection: &Connection, value: &Value) -> Result<Value, StoreError> {
        let old: LegacyBasis = serde_json::from_value(value.clone())
            .map_err(|_| corrupt("Stored Inbox basis is invalid"))?;
        let hash = historical_content(connection, &old)?
            .map(|content| content.fingerprint())
            .unwrap_or_else(|| {
                crate::document::sha256(format!("unavailable-inbox-content:{value}").as_bytes())
            });
        Ok(json!({"page_id":old.page_id,"content_hash":hash}))
    }
    for (table, key) in [
        ("inbox_proposals", "proposal_id"),
        ("inbox_suggestion_requests", "request_id"),
        ("core_automation_firings", "dispatch_id"),
    ] {
        let column = if table == "core_automation_firings" {
            "hold_basis_json"
        } else {
            "basis_json"
        };
        let rows = connection
            .prepare(&format!("SELECT {key},{column} FROM {table}"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, json) in rows {
            let value: Value = serde_json::from_str(&json)
                .map_err(|_| corrupt("Stored Inbox basis is invalid"))?;
            if table == "inbox_suggestion_requests" {
                let library_id: String = connection.query_row(
                    "SELECT library_id FROM inbox_suggestion_requests WHERE request_id=?1",
                    [&id],
                    |row| row.get(0),
                )?;
                let mut inputs = Vec::new();
                let mut offset = 0;
                let mut available = true;
                for member in value
                    .as_array()
                    .ok_or_else(|| corrupt("Stored Inbox request basis is invalid"))?
                {
                    let old: LegacyBasis = serde_json::from_value(member.clone())
                        .map_err(|_| corrupt("Stored Inbox request basis is invalid"))?;
                    let Some(content) = historical_content(connection, &old)? else {
                        available = false;
                        break;
                    };
                    if content.markdown.len() > crate::workspace::inbox_content::MAX_MESSAGE_BYTES
                        || offset + content.images.len()
                            > crate::workspace::inbox_content::MAX_SUGGESTION_IMAGES
                    {
                        available = false;
                        break;
                    }
                    let count = content.images.len();
                    inputs.push(crate::workspace::frozen_input_for_content(
                        connection,
                        &library_id,
                        &old.page_id,
                        content,
                        offset,
                    )?);
                    offset += count;
                }
                if available && !inputs.is_empty() {
                    connection.execute(
                        "UPDATE inbox_suggestion_requests SET inputs_json=?2 WHERE request_id=?1",
                        params![
                            id,
                            serde_json::to_string(&inputs)
                                .map_err(|_| corrupt("Stored Inbox request inputs are invalid"))?
                        ],
                    )?;
                } else {
                    connection.execute("UPDATE inbox_entries SET suggestion_state='failed',suggestion_error='Saved suggestion inputs are unavailable. Request a new suggestion.',revision=revision+1 WHERE suggestion_request_id=?1 AND suggestion_state='pending'", [&id])?;
                    connection.execute("UPDATE inbox_suggestion_requests SET state='failed' WHERE request_id=?1 AND state='pending'", [&id])?;
                }
            }
            let basis = if let Some(members) = value.as_array() {
                Value::Array(
                    members
                        .iter()
                        .map(|member| migrate_basis(connection, member))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            } else {
                migrate_basis(connection, &value)?
            };
            connection.execute(
                &format!("UPDATE {table} SET {column}=?2 WHERE {key}=?1"),
                params![id, basis.to_string()],
            )?;
        }
    }
    Ok(())
}

fn migrate_v192_to_v193(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v192_to_v193.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"scheduled_inbox_firings":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v184_to_v185(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v184_to_v185.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_concrete_suggestions":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v182_to_v183(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v182_to_v183.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox_scope":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v176_to_v177(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v176_to_v177.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"block_erasure":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

/// Agent Runtime authority is derived from the Session binding on every use; per-Run admission
/// rows and their mirrored Turn authorities have no remaining reader.
fn migrate_v181_to_v182(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v181_to_v182.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"derived_agent_runtime_authority":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v180_to_v181(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v180_to_v181.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"native_session_execution_identity":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v179_to_v180(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    while crate::library::prepare_editor_history_replacement_step(connection)? {}
    connection.execute_batch(include_str!("../../schema/migrations/v179_to_v180.sql"))?;
    let next_epoch = format!(
        "epoch:{}",
        random_uuid_v7().map_err(|_| internal("Store epoch entropy is unavailable"))?
    );
    connection.execute(
        "UPDATE block_store_metadata SET store_epoch=?1,updated_at=?2 WHERE id=1",
        params![
            next_epoch,
            chrono::DateTime::from_timestamp_millis(context.completed_at_unix_ms)
                .ok_or_else(|| internal("Migration timestamp is invalid"))?
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        ],
    )?;
    crate::library::discard_replaced_editor_history(connection)?;
    connection.execute("INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![context.source_revision,context.target_revision,context.source_schema_fingerprint,context.target_schema_fingerprint,context.backup_name,context.completed_at_unix_ms,r#"{"profile_access":true,"delivery_epoch_replaced":true}"#])?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v178_to_v179(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v178_to_v179.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"automation_session_runs":true,"stable_dispatches":true,"execution_cleanup":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v175_to_v176(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v175_to_v176.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"inbox":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v177_to_v178(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v177_to_v178.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"agent_runtime_session_bindings":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v174_to_v175(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v174_to_v175.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"opencode_backend":true,"runtime_options":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v173_to_v174(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v173_to_v174.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"native_session_scope":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v172_to_v173(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v172_to_v173.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"native_conversation_preferences_and_turn_facts":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v167_to_v168(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v167_to_v168.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"queued_message_documents":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v166_to_v167(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v166_to_v167.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"identity_scoped_thread_read_state":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v164_to_v165(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v164_to_v165.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"optional_actor_attribution":true,"relocation_library_coordinate":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn migrate_v165_to_v166(
    connection: &Connection,
    context: &MigrationContext,
) -> Result<(), StoreError> {
    connection.execute_batch(include_str!("../../schema/migrations/v165_to_v166.sql"))?;
    connection.execute(
        "INSERT INTO core_store_migration_history(source_revision,target_revision,source_schema_fingerprint,target_schema_fingerprint,backup_name,completed_at_unix_ms,evidence_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![context.source_revision, context.target_revision, context.source_schema_fingerprint,
            context.target_schema_fingerprint, context.backup_name, context.completed_at_unix_ms,
            r#"{"retained_payload_bytes_preserved":true}"#],
    )?;
    connection.pragma_update(None, "user_version", context.target_revision)?;
    Ok(())
}

fn upgrade_v5_preferences_json(
    encoded: &str,
    property_type: &impl Fn(&str) -> Option<String>,
) -> Result<String, StoreError> {
    let mut presentation = serde_json::from_str::<Map<String, Value>>(encoded)
        .map_err(|_| internal("Legacy Database View preference is invalid"))?;
    let mut rules = Map::new();
    // The v145 typed writer encoded an absent optional Filter as JSON null.
    // That value means "inherit the shared Filter", not a malformed Filter AST.
    if let Some(filter) = presentation
        .remove("filter")
        .filter(|filter| !filter.is_null())
    {
        let filter = crate::database::view_contract::upgrade_v5_filter_value(filter, property_type)
            .map_err(internal)?;
        let empty = filter
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "group")
            && filter
                .get("operator")
                .and_then(Value::as_str)
                .is_some_and(|operator| operator == "and")
            && filter
                .get("children")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
        let filter = if filter.get("kind").and_then(Value::as_str) == Some("clause") {
            json!({ "kind": "group", "operator": "and", "children": [filter] })
        } else {
            filter
        };
        rules.insert(
            "advanced_filter".to_owned(),
            if empty {
                json!({ "kind": "none" })
            } else {
                json!({ "kind": "filter", "filter": filter })
            },
        );
    }
    if let Some(sort) = presentation.remove("sort") {
        rules.insert("sorts".to_owned(), sort);
    }
    serde_json::to_string(&json!({
        "rules_override": rules,
        "presentation_override": presentation,
    }))
    .map_err(|_| internal("Database View preferences cannot be encoded"))
}

fn install_fresh_profile(connection: &mut Connection, now: u64) -> Result<(), StoreError> {
    install_fresh_profile_with(connection, |transaction| {
        initialize_fresh_profile(transaction, now)
    })
}

fn timestamp_from_unix_ms(value: i64) -> Result<String, StoreError> {
    chrono::DateTime::from_timestamp_millis(value)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| internal("Migration timestamp exceeds the supported range"))
}

fn install_fresh_profile_with<T>(
    connection: &mut Connection,
    initialize: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    with_immediate_transaction(connection, |transaction| {
        install_current_schema_in_transaction(transaction)?;
        initialize(transaction)
    })
}

fn initialize_fresh_profile(connection: &Connection, now: u64) -> Result<(), StoreError> {
    let now = i64::try_from(now)
        .map_err(|_| internal("Profile initialization time exceeds SQLite integer range"))?;
    let updated_at = timestamp_from_unix_ms(now)?;
    connection.execute(
        "INSERT INTO core_store_metadata( \
               id, schema_owner, projection_event_v2_floor \
             ) VALUES (1, ?1, 1)",
        [CORE_SCHEMA_OWNER],
    )?;
    connection.execute(
        "INSERT INTO nodex_agent_token_keys(id, key_material) VALUES (1, randomblob(32))",
        [],
    )?;
    connection.execute(
        "INSERT INTO core_automation_runtime_metadata( \
               id, jitter_salt, created_at_unix_ms \
             ) VALUES (1, lower(hex(randomblob(16))), ?1)",
        [now],
    )?;
    connection.execute(
        "INSERT INTO block_retention_state(id, maintenance_revision, updated_at_ms) \
         VALUES (1, 0, ?1)",
        [now],
    )?;
    connection.execute(
        "INSERT INTO operational_journal_state( \
           id, commit_head_seq, replay_floor_seq, maintenance_revision, \
           retained_commit_count, retained_delivery_bytes, pending_metadata_count, \
           retained_receipt_count, retained_receipt_bytes, \
           pending_receipt_metadata_count, operation_identity_cutover_at, \
           last_pruned_commit_seq, policy_version, updated_at \
         ) VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?1, 0, 1, ?1)",
        [updated_at],
    )?;
    Ok(())
}

fn create_migration_backup(
    connection: &Connection,
    profile_home: &Path,
    source_revision: i64,
    target_revision: i64,
) -> Result<PathBuf, StoreError> {
    let directory = prepare_migration_backup_directory(profile_home)?;
    let pending_path = directory.join(format!(
        ".v{source_revision}-to-v{target_revision}.pending.db"
    ));
    if let Ok(metadata) = fs::symlink_metadata(&pending_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_profile(
                "Core migration pending backup must be a regular file",
            ));
        }
        fs::remove_file(&pending_path).map_err(io_error)?;
    }
    connection.backup(
        MAIN_DB,
        &pending_path,
        None::<fn(rusqlite::backup::Progress)>,
    )?;
    File::open(&pending_path)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)?;
    validate_migration_backup(&pending_path, source_revision)?;
    let digest = file_sha256(&pending_path)?;
    let backup_path = directory.join(format!(
        "v{source_revision}-to-v{target_revision}-{digest}.db"
    ));
    if let Ok(metadata) = fs::symlink_metadata(&backup_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_profile(
                "Core migration backup must be a regular file",
            ));
        }
        validate_migration_backup(&backup_path, source_revision)?;
        if file_sha256(&backup_path)? != digest {
            return Err(corrupt(
                "Content-addressed migration backup digest diverges",
            ));
        }
        fs::remove_file(&pending_path).map_err(io_error)?;
    } else {
        fs::rename(&pending_path, &backup_path).map_err(io_error)?;
    }
    File::open(&directory)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)?;
    Ok(backup_path)
}

fn prepare_migration_backup_directory(profile_home: &Path) -> Result<PathBuf, StoreError> {
    let mut directory = profile_home.to_path_buf();
    for component in ["backups", "core-migrations"] {
        directory.push(component);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid_profile(
                    "Core migration backup ancestry must contain only real directories",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(io_error)?;
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(directory)
}

fn validate_migration_backup(path: &Path, source_revision: i64) -> Result<(), StoreError> {
    let backup = open_immutable_reader(path)?;
    let version: i64 = backup.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != source_revision {
        return Err(corrupt(format!(
            "Migration backup has unexpected schema v{version}"
        )));
    }
    validate_store(&backup)?;
    validate_schema_identity(&backup, source_revision)
}

fn file_sha256(path: &Path) -> Result<String, StoreError> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            return Ok(hex::encode(digest.finalize()));
        }
        digest.update(&buffer[..read]);
    }
}

fn with_schema_rebuild_transaction<T>(
    connection: &mut Connection,
    operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let foreign_keys_enabled: bool =
        connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, bool>(0))?;
    let legacy_alter_table_enabled: bool =
        connection.query_row("PRAGMA legacy_alter_table", [], |row| row.get::<_, bool>(0))?;
    if foreign_keys_enabled {
        connection.pragma_update(None, "foreign_keys", false)?;
    }
    let result = with_immediate_transaction(connection, |transaction| {
        let owns_maintenance_context =
            super::legacy_visibility_migration::enter_migration_maintenance_context(transaction)?;
        let value = operation(transaction)?;
        super::legacy_visibility_migration::leave_migration_maintenance_context(
            transaction,
            owns_maintenance_context,
        )?;
        Ok(value)
    });
    // Both pragmas are connection state rather than transaction state. Restore
    // them after commit or rollback so a failed rebuild cannot poison a retry.
    let restore_legacy_alter_table =
        connection.pragma_update(None, "legacy_alter_table", legacy_alter_table_enabled);
    let restore_foreign_keys = if foreign_keys_enabled {
        connection.pragma_update(None, "foreign_keys", true)
    } else {
        Ok(())
    };
    match (result, restore_legacy_alter_table, restore_foreign_keys) {
        (Ok(value), Ok(()), Ok(())) => Ok(value),
        (Err(error), _, _) => Err(error),
        (Ok(_), Err(error), _) | (Ok(_), Ok(()), Err(error)) => Err(StoreError::from(error)),
    }
}

pub fn expected_store_schema_fingerprint(revision: i64) -> Result<String, StoreError> {
    published_format(revision).map(|format| format.schema_fingerprint.to_owned())
}

fn published_format(revision: i64) -> Result<nodex_store_format::PublishedStoreFormat, StoreError> {
    let revision = u32::try_from(revision).map_err(|_| unsupported_revision(revision))?;
    nodex_store_format::published_store_format(revision)
        .ok_or_else(|| unsupported_revision(i64::from(revision)))
}

fn unsupported_revision(revision: i64) -> StoreError {
    StoreError::new(
        StoreErrorCode::UnsupportedSchema,
        format!("No published Store identity exists for v{revision}"),
        false,
    )
}

fn unix_time_millis() -> Result<u64, StoreError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| internal(format!("System clock is before the Unix epoch: {error}")))?;
    u64::try_from(duration.as_millis())
        .map_err(|_| internal("System time exceeds the migration timestamp range"))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn invalid_profile(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidProfile, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn io_error(error: std::io::Error) -> StoreError {
    internal(format!(
        "Store migration filesystem operation failed: {error}"
    ))
}

#[cfg(test)]
static TEST_CURRENT_STORE_TEMPLATE: OnceLock<Mutex<Connection>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn prepare_test_current_store(
    connection: &mut Connection,
    _profile_home: &Path,
) -> Result<(), StoreError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if version != 0 || object_count != 0 {
        return Ok(());
    }
    let template = test_current_store_template()?;
    let template = template
        .lock()
        .map_err(|_| corrupt("Test Store template lock is poisoned"))?;
    let backup = Backup::new(&template, connection)?;
    backup.run_to_completion(1_024, Duration::ZERO, None)?;
    drop(backup);
    with_immediate_transaction(connection, |transaction| {
        initialize_fresh_profile(transaction, unix_time_millis()?)
    })?;
    crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(connection)
}

#[cfg(test)]
fn test_current_store_template() -> Result<&'static Mutex<Connection>, StoreError> {
    if let Some(template) = TEST_CURRENT_STORE_TEMPLATE.get() {
        return Ok(template);
    }
    let mut connection = Connection::open_in_memory()?;
    connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    install_current_schema(&mut connection)?;
    let _ = TEST_CURRENT_STORE_TEMPLATE.set(Mutex::new(connection));
    TEST_CURRENT_STORE_TEMPLATE
        .get()
        .ok_or_else(|| corrupt("Test Store template was not initialized"))
}

#[cfg(test)]
#[path = "migration_derivation_tests.rs"]
mod derivation_tests;

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use rusqlite::OptionalExtension;
    use serde_json::{Value, json};
    use tempfile::tempdir;

    use super::super::sqlite::open_writer;
    use super::*;

    fn no_op_migration(
        _connection: &Connection,
        _context: &MigrationContext,
    ) -> Result<(), StoreError> {
        Ok(())
    }

    fn assert_migration_events(events: &[StorePreparationEvent], from_revision: i64) {
        let starts = MIGRATION_STEPS
            .iter()
            .filter(|step| step.from_revision >= from_revision)
            .map(|step| StorePreparationEvent::MigrationStarted {
                from_version: step.from_revision,
                to_version: step.to_revision,
            })
            .collect::<Vec<_>>();
        assert_eq!(&events[..starts.len()], starts.as_slice());
        let total = starts.len() as u64;
        let progress = &events[starts.len()..];
        assert!(!progress.is_empty() && progress.len() <= 20);
        let mut previous = 0;
        for event in progress {
            let StorePreparationEvent::MigrationProgress {
                completed,
                total: reported_total,
            } = event
            else {
                panic!("Only progress follows migration starts");
            };
            assert_eq!(*reported_total, total);
            assert!(*completed > previous && *completed <= total);
            previous = *completed;
        }
        assert_eq!(previous, total, "progress ends at completed migration");
    }

    fn expected_migration_step_count(from_revision: i64) -> i64 {
        i64::try_from(
            MIGRATION_STEPS
                .iter()
                .filter(|step| step.from_revision >= from_revision)
                .count(),
        )
        .expect("migration count fits i64")
    }

    #[test]
    fn v142_sidebar_sections_gain_library_scoped_keys_without_losing_state() {
        let mut connection = Connection::open_in_memory().expect("v142 Store");
        connection
            .pragma_update(None, "foreign_keys", true)
            .expect("foreign keys");
        connection
            .execute_batch(
                "CREATE TABLE libraries(id TEXT PRIMARY KEY, created_at TEXT NOT NULL); \
                 CREATE TABLE projects(id TEXT PRIMARY KEY); \
                 CREATE TABLE project_sessions(id TEXT PRIMARY KEY); \
                 CREATE TABLE core_store_migration_history( \
                   source_revision INTEGER NOT NULL, target_revision INTEGER NOT NULL, \
                   source_schema_fingerprint TEXT NOT NULL, \
                   target_schema_fingerprint TEXT NOT NULL, backup_name TEXT NOT NULL, \
                   completed_at_unix_ms INTEGER NOT NULL, evidence_json TEXT NOT NULL); \
                 CREATE TABLE local_commit_visibility_context( \
                   id INTEGER PRIMARY KEY CHECK (id = 1), \
                   mode TEXT NOT NULL CHECK (mode IN ('active', 'overlay', 'maintenance')), \
                   store_epoch TEXT, commit_seq INTEGER, \
                   CHECK ( \
                     (mode IN ('active', 'overlay') \
                       AND store_epoch IS NOT NULL AND commit_seq IS NOT NULL) \
                     OR (mode = 'maintenance' \
                       AND store_epoch IS NULL AND commit_seq IS NULL))); \
                 INSERT INTO libraries(id, created_at) \
                   VALUES ('library-1', '2026-08-30T00:00:00.000Z'); \
                 INSERT INTO projects(id) VALUES ('project-1');",
            )
            .expect("v141 Sidebar Section parents");
        connection
            .execute_batch(include_str!("../../schema/migrations/v141_to_v142.sql"))
            .expect("published v142 Sidebar Section schema");
        connection
            .execute_batch(
                "INSERT INTO workspace_sidebar_sections( \
                   section_id, library_id, kind, name, rank_key, revision, lifecycle, \
                   deleted_at, created_at, updated_at \
                 ) VALUES ( \
                   'section:custom', 'library-1', 'custom', 'Custom', 2000000000000, \
                   3, 'active', NULL, '2026-08-30T00:00:00.000Z', \
                   '2026-08-30T00:01:00.000Z'); \
                 INSERT INTO workspace_sidebar_section_items( \
                   placement_id, section_id, section_kind, project_id, session_id, rank_key, \
                   revision, created_at, updated_at \
                 ) VALUES ( \
                   'project:project-1', 'section:custom', 'custom', 'project-1', NULL, 0, 2, \
                   '2026-08-30T00:00:00.000Z', '2026-08-30T00:01:00.000Z'); \
                 INSERT INTO workspace_sidebar_section_host_links( \
                   section_id, host_id, remote_section_id, sync_state, observed_generation, \
                   last_error, updated_at \
                 ) VALUES ( \
                   'section:custom', 'local', 'remote:1', 'ready', 7, NULL, \
                   '2026-08-30T00:01:00.000Z');",
            )
            .expect("v142 Sidebar Section state");

        let source = published_format(142).expect("v142 format");
        let target = published_format(143).expect("v143 format");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v142_to_v143(
                transaction,
                &MigrationContext {
                    source_revision: 142,
                    target_revision: 143,
                    backup_name: "v142-to-v143-test.db".to_owned(),
                    source_schema_fingerprint: source.schema_fingerprint,
                    target_schema_fingerprint: target.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("migrate v142 Sidebar Sections");

        let migrated = connection
            .query_row(
                "SELECT section.library_id, section.name, section.revision, \
                        item.library_id, item.revision, link.library_id, link.remote_section_id, \
                        link.observed_generation \
                 FROM workspace_sidebar_sections section \
                 JOIN workspace_sidebar_section_items item \
                   ON item.library_id = section.library_id \
                  AND item.section_id = section.section_id \
                 JOIN workspace_sidebar_section_host_links link \
                   ON link.library_id = section.library_id \
                  AND link.section_id = section.section_id \
                 WHERE section.library_id = 'library-1' \
                   AND section.section_id = 'section:custom'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .expect("migrated Sidebar Section state");
        assert_eq!(
            migrated,
            (
                "library-1".to_owned(),
                "Custom".to_owned(),
                3,
                "library-1".to_owned(),
                2,
                "library-1".to_owned(),
                "remote:1".to_owned(),
                7,
            )
        );
        let foreign_key_failures = connection
            .prepare("PRAGMA foreign_key_check")
            .expect("foreign key check")
            .query_map([], |_| Ok(()))
            .expect("foreign key rows")
            .count();
        assert_eq!(foreign_key_failures, 0);
    }

    #[test]
    fn v146_preference_upgrade_separates_rules_from_presentation() {
        let upgraded = upgrade_v5_preferences_json(
            &json!({
                "filter": {
                    "kind": "clause",
                    "propertyId": "tags",
                    "operator": "contains",
                    "value": "tag-a"
                },
                "sort": [{
                    "field": { "kind": "created" },
                    "direction": "desc",
                    "nulls": "last"
                }],
                "group": null,
                "display": { "showDescription": false }
            })
            .to_string(),
            &|property_id| (property_id == "tags").then(|| "multi_select".to_owned()),
        )
        .expect("upgrade personal preferences");
        let value = serde_json::from_str::<Value>(&upgraded).expect("preference JSON");

        assert_eq!(
            value["rules_override"]["advanced_filter"]["filter"]["children"][0]["operator"],
            "multi_select_contains_all"
        );
        assert_eq!(
            value["rules_override"]["advanced_filter"]["filter"]["children"][0]["value"],
            json!(["tag-a"])
        );
        assert_eq!(value["rules_override"]["sorts"][0]["direction"], "desc");
        assert!(value["presentation_override"].get("filter").is_none());
        assert!(value["presentation_override"].get("sort").is_none());
        assert_eq!(
            value["presentation_override"]["display"]["showDescription"],
            false
        );
    }

    #[test]
    fn v146_preference_upgrade_accepts_a_null_filter_override() {
        let upgraded = upgrade_v5_preferences_json(
            &json!({
                "filter": null,
                "sort": null,
                "group": null,
                "display": { "showDescription": null }
            })
            .to_string(),
            &|_| None,
        )
        .expect("upgrade an empty personal filter override");
        let value = serde_json::from_str::<Value>(&upgraded).expect("preference JSON");

        assert!(value["rules_override"].get("advanced_filter").is_none());
        assert!(value["rules_override"]["sorts"].is_null());
        assert!(value["presentation_override"].get("filter").is_none());
        assert!(value["presentation_override"]["group"].is_null());
        assert!(value["presentation_override"]["display"]["showDescription"].is_null());
    }

    #[test]
    fn v147_filter_repair_restores_the_operator_value_arity() {
        let mut filter = json!({
            "kind": "group",
            "operator": "and",
            "children": [
                {
                    "kind": "clause",
                    "propertyId": "status",
                    "operator": "select_is"
                },
                {
                    "kind": "clause",
                    "propertyId": "assignee",
                    "operator": "is_empty",
                    "value": null
                }
            ]
        });

        assert_eq!(
            normalize_filter_value_arity(&mut filter).expect("repair"),
            2
        );
        assert!(filter["children"][0].get("value").is_some());
        assert!(filter["children"][0]["value"].is_null());
        assert!(filter["children"][1].get("value").is_none());
        assert_eq!(
            normalize_filter_value_arity(&mut filter).expect("idempotent"),
            0
        );
    }

    #[test]
    fn v147_migration_repairs_durable_and_personal_filter_json() {
        let mut connection = Connection::open_in_memory().expect("Store");
        install_current_schema(&mut connection).expect("current schema");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("maintenance writes");
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("fixture without authority graph");
        connection
            .pragma_update(None, "user_version", 146)
            .expect("mark v146 Store");
        connection
            .execute(
                "INSERT INTO database_views( \
                   id, database_block_id, data_source_id, name, layout, config_json, \
                   revision, rank_key, lifecycle, created_at, updated_at \
                 ) VALUES ('view:repair', 'database:repair', 'source:repair', 'Repair', \
                   'board', ?1, 1, 'a', 'active', '2026-08-30T00:00:00.000Z', \
                   '2026-08-30T00:00:00.000Z')",
                [json!({
                    "rules": {
                        "propertyFilters": [],
                        "advancedFilter": {
                            "kind": "group",
                            "operator": "and",
                            "children": [{
                                "kind": "clause",
                                "propertyId": "status",
                                "operator": "select_is"
                            }]
                        }
                    }
                })
                .to_string()],
            )
            .expect("legacy View");
        connection
            .execute(
                "INSERT INTO database_view_personal_preferences( \
                   profile_id, view_id, preferences_json, revision, created_at, updated_at \
                 ) VALUES ('profile:repair', 'view:repair', ?1, 1, \
                   '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')",
                [json!({
                    "rules_override": {
                        "property_filters": [],
                        "advanced_filter": {
                            "kind": "filter",
                            "filter": {
                                "kind": "group",
                                "operator": "and",
                                "children": [{
                                    "kind": "clause",
                                    "propertyId": "assignee",
                                    "operator": "select_is"
                                }]
                            }
                        }
                    },
                    "presentation_override": {}
                })
                .to_string()],
            )
            .expect("legacy personal preferences");
        let source = published_format(146).expect("v146 format");
        let target = published_format(147).expect("v147 format");

        migrate_v146_to_v147(
            &connection,
            &MigrationContext {
                source_revision: 146,
                target_revision: 147,
                backup_name: "v146-filter-repair.db".to_owned(),
                source_schema_fingerprint: source.schema_fingerprint,
                target_schema_fingerprint: target.schema_fingerprint,
                completed_at_unix_ms: 1,
            },
        )
        .expect("repair filter arity");

        let view = connection
            .query_row(
                "SELECT config_json FROM database_views WHERE id = 'view:repair'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|encoded| serde_json::from_str::<Value>(&encoded).expect("View JSON"))
            .expect("repaired View");
        let preferences = connection
            .query_row(
                "SELECT preferences_json FROM database_view_personal_preferences \
                 WHERE profile_id = 'profile:repair' AND view_id = 'view:repair'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|encoded| serde_json::from_str::<Value>(&encoded).expect("preference JSON"))
            .expect("repaired preferences");
        assert!(view["rules"]["advancedFilter"]["children"][0]["value"].is_null());
        assert!(
            preferences["rules_override"]["advanced_filter"]["filter"]["children"][0]["value"]
                .is_null()
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version"),
            147
        );
    }

    #[test]
    fn migration_path_orders_every_revision_until_current() {
        let steps = [
            MigrationStep {
                from_revision: 130,
                to_revision: 131,
                apply: no_op_migration,
            },
            MigrationStep {
                from_revision: 131,
                to_revision: 132,
                apply: no_op_migration,
            },
        ];

        let path = resolve_migration_path(130, 132, &steps).expect("contiguous migration path");

        assert_eq!(
            path.iter()
                .map(|step| (step.from_revision, step.to_revision))
                .collect::<Vec<_>>(),
            vec![(130, 131), (131, 132)]
        );
        assert!(resolve_migration_path(129, 132, &steps).is_none());
        assert!(resolve_migration_path(131, 133, &steps).is_none());
    }

    #[test]
    fn migration_schema_converges_exactly_with_fresh_schema() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut migrated = open_writer(&directory.path().join("nodex.db")).expect("writer");
        with_schema_rebuild_transaction(&mut migrated, |transaction| {
            for step in MIGRATION_STEPS {
                let source = published_format(step.from_revision)?;
                let target = published_format(step.to_revision)?;
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "schema-convergence.db".to_owned(),
                        source_schema_fingerprint: source.schema_fingerprint,
                        target_schema_fingerprint: target.schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
            }
            Ok(())
        })
        .expect("apply migration DDL");

        let mut fresh = Connection::open_in_memory().expect("fresh Store");
        install_current_schema(&mut fresh).expect("install current schema");
        let migrated_inventory = crate::infrastructure::schema::read_schema_inventory(&migrated)
            .expect("migrated inventory");
        let fresh_inventory =
            crate::infrastructure::schema::read_schema_inventory(&fresh).expect("fresh inventory");
        let differences = fresh_inventory
            .iter()
            .filter_map(|(key, fresh_sql)| {
                let migrated_sql = migrated_inventory.get(key);
                (migrated_sql != Some(fresh_sql)).then(|| {
                    format!(
                        "{} {}\nfresh: {}\nmigrated: {}",
                        key.object_type,
                        key.name,
                        fresh_sql,
                        migrated_sql.map_or("<missing>", String::as_str)
                    )
                })
            })
            .collect::<Vec<_>>();
        assert!(
            differences.is_empty() && migrated_inventory.len() == fresh_inventory.len(),
            "{}",
            differences.join("\n\n")
        );
    }

    #[test]
    fn v143_kanban_view_migrates_to_distinct_board_and_list_views() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            for step in MIGRATION_STEPS
                .iter()
                .take_while(|step| step.to_revision <= 141)
            {
                let source = published_format(step.from_revision)?;
                let target = published_format(step.to_revision)?;
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "v141-view-identity.db".to_owned(),
                        source_schema_fingerprint: source.schema_fingerprint,
                        target_schema_fingerprint: target.schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
            }
            Ok(())
        })
        .expect("install v141 schema");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("maintenance writes");
        let library_id = connection
            .query_row("SELECT id FROM libraries ORDER BY id LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("Library");
        let profile_id = connection
            .query_row("SELECT id FROM profiles ORDER BY id LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("Profile");
        let database_id = "database:view-identity".to_owned();
        let data_source_id = "source:view-identity".to_owned();
        let view_id = "01890f44-7f00-7000-8000-000000000001".to_owned();
        let deleted_view_id = "01890f44-7f00-7000-8000-000000000002".to_owned();
        let board_display = serde_json::json!({
            "fields": [{ "kind": "property", "propertyId": "status" }],
            "propertyOrder": ["status"],
            "showEmptyGroups": false,
            "showDescription": true
        });
        let list_display = serde_json::json!({
            "fields": [{ "kind": "property", "propertyId": "status" }],
            "propertyOrder": ["status"],
            "showEmptyGroups": true,
            "showDescription": false
        });
        let legacy_definition = serde_json::json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 4,
            "filter": { "kind": "group", "operator": "and", "children": [] },
            "presentation": {
                "sort": [{
                    "field": { "kind": "manual" },
                    "direction": "asc",
                    "nulls": "last"
                }],
                "group": null,
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "layouts": {
                    "board": {
                        "fields": board_display["fields"].clone(),
                        "showEmptyGroups": board_display["showEmptyGroups"].clone(),
                        "showDescription": board_display["showDescription"].clone()
                    },
                    "list": {
                        "fields": list_display["fields"].clone(),
                        "showEmptyGroups": list_display["showEmptyGroups"].clone(),
                        "showDescription": list_display["showDescription"].clone()
                    }
                }
            }
        });
        connection
            .execute(
                "INSERT INTO blocks( \
                   id, library_id, type, lifecycle, created_at, updated_at \
                 ) VALUES (?1, ?2, 'database', 'active', '2026-08-29T00:00:00.000Z', \
                   '2026-08-29T00:00:00.000Z')",
                params![database_id, library_id],
            )
            .expect("legacy Database Block");
        connection
            .execute(
                "INSERT INTO database_containers( \
                   block_id, library_id, name, lifecycle, created_at, updated_at \
                 ) VALUES (?1, ?2, 'Migration fixture', 'active', \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                params![database_id, library_id],
            )
            .expect("legacy Database");
        connection
            .execute(
                "INSERT INTO data_sources( \
                   id, library_id, home_database_block_id, name, schema_key, lifecycle, \
                   rank_key, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 'Tasks', 'nodex.database', 'active', 'a', \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                params![data_source_id, library_id, database_id],
            )
            .expect("legacy Data Source");
        connection
            .execute(
                "INSERT INTO data_source_properties( \
                   data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                   created_at, updated_at \
                 ) VALUES (?1, 'status', 'Status', 'select', '{\"options\":[]}', 'a', \
                   'active', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                [&data_source_id],
            )
            .expect("legacy Property");
        connection
            .execute(
                "INSERT INTO database_views( \
                   id, database_block_id, data_source_id, name, default_layout, config_json, \
                   revision, rank_key, lifecycle, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 'kanban', 'board', ?4, 3, 'a', 'active', \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                params![
                    view_id,
                    database_id,
                    data_source_id,
                    legacy_definition.to_string()
                ],
            )
            .expect("legacy View");
        connection
            .execute(
                "INSERT INTO database_views( \
                   id, database_block_id, data_source_id, name, default_layout, config_json, \
                   revision, rank_key, lifecycle, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 'kanban', 'list', ?4, 5, 'b', 'deleted', \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                params![
                    deleted_view_id,
                    database_id,
                    data_source_id,
                    legacy_definition.to_string()
                ],
            )
            .expect("deleted legacy View");
        connection
            .execute(
                "UPDATE database_containers SET default_view_id = ?1 WHERE block_id = ?2",
                params![view_id, database_id],
            )
            .expect("legacy default View");
        connection
            .execute(
                "INSERT INTO blocks( \
                   id, library_id, type, lifecycle, created_at, updated_at \
                 ) VALUES ('page:view-identity', ?1, 'page', 'active', \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                [&library_id],
            )
            .expect("legacy positioned Page");
        connection
            .execute(
                "INSERT INTO documents( \
                   id, library_id, schema_key, schema_version, created_at, updated_at \
                 ) VALUES ('document:view-identity', ?1, 'nodex.page', 3, \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                [&library_id],
            )
            .expect("legacy Page Document");
        connection
            .execute(
                "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                 VALUES ('page:view-identity', 'document:view-identity', ?1, \
                   '2026-08-29T00:00:00.000Z')",
                [&library_id],
            )
            .expect("legacy Page Document ownership");
        connection
            .execute(
                "INSERT INTO pages( \
                   block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
                 ) VALUES ('page:view-identity', ?1, 'document:view-identity', 'data_source', ?2, \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                params![library_id, data_source_id],
            )
            .expect("legacy Data Source Page");
        connection
            .execute(
                "INSERT INTO data_source_page_memberships( \
                   id, data_source_id, page_block_id, revision, created_at \
                 ) VALUES ('membership:view-identity', ?1, 'page:view-identity', 1, \
                   '2026-08-29T00:00:00.000Z')",
                [&data_source_id],
            )
            .expect("legacy active membership");
        connection
            .execute(
                "INSERT INTO database_view_page_positions( \
                   view_id, page_block_id, rank_key, revision, created_at, updated_at \
                 ) VALUES (?1, 'page:view-identity', 'position-a', 4, \
                   '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')",
                [&view_id],
            )
            .expect("legacy manual position");
        connection
            .execute(
                "INSERT INTO database_view_collapsed_occurrences( \
                   profile_id, view_id, target_kind, occurrence_key, collapsed_at \
                 ) VALUES (?1, ?2, 'group', 'GROUP_fixture', '2026-08-29T00:00:00.000Z')",
                params![profile_id, view_id],
            )
            .expect("legacy collapsed group");
        let property_count = 1;
        connection
            .execute(
                "INSERT INTO database_view_personal_presentations( \
                   profile_id, view_id, presentation_override_json, revision, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 7, '2026-08-29T00:00:00.000Z', \
                   '2026-08-29T00:00:00.000Z')",
                params![
                    profile_id,
                    view_id,
                    serde_json::json!({
                        "layout": "list",
                        "layouts": {
                            "board": { "cardPreview": "none" },
                            "list": { "wrapProperties": true }
                        },
                        "visibleFields": ["title"]
                    })
                    .to_string(),
                ],
            )
            .expect("legacy personal View presentation");

        connection
            .execute("DELETE FROM local_commit_visibility_context", [])
            .expect("finish fixture maintenance writes");

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v141_to_v142(
                transaction,
                &MigrationContext {
                    source_revision: 141,
                    target_revision: 142,
                    backup_name: "v141-view-identity.db".to_owned(),
                    source_schema_fingerprint: published_format(141)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(142)?.schema_fingerprint,
                    completed_at_unix_ms: 2,
                },
            )
        })
        .expect("install published v142 schema");

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v142_to_v143(
                transaction,
                &MigrationContext {
                    source_revision: 142,
                    target_revision: 143,
                    backup_name: "v142-view-identity.db".to_owned(),
                    source_schema_fingerprint: published_format(142)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(143)?.schema_fingerprint,
                    completed_at_unix_ms: 3,
                },
            )
        })
        .expect("install published v143 schema");

        validate_migration_source(&connection, 143)
            .expect("published v143 View config is a valid migration source");

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v143_to_v144(
                transaction,
                &MigrationContext {
                    source_revision: 143,
                    target_revision: 144,
                    backup_name: "v141-view-identity.db".to_owned(),
                    source_schema_fingerprint: published_format(143)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(144)?.schema_fingerprint,
                    completed_at_unix_ms: 4,
                },
            )
        })
        .expect("migrate View identities");

        let views = connection
            .prepare(
                "SELECT id, name, layout, config_json, rank_key \
                 FROM database_views WHERE database_block_id = ?1 ORDER BY rank_key, id",
            )
            .expect("migrated View query")
            .query_map([&database_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .expect("migrated View rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("migrated Views");
        assert_eq!(views.len(), 4);
        assert_eq!(views[0].0, view_id);
        assert_ne!(views[0].0, views[1].0);
        assert_eq!(
            (&views[0].1, &views[0].2),
            (&"Board".to_owned(), &"board".to_owned())
        );
        assert_eq!(
            (&views[1].1, &views[1].2),
            (&"List".to_owned(), &"list".to_owned())
        );
        assert_ne!(views[0].4, views[1].4);
        assert_eq!(
            (&views[2].0, &views[2].1, &views[2].2),
            (&deleted_view_id, &"List 2".to_owned(), &"list".to_owned())
        );
        assert_eq!(
            (&views[3].1, &views[3].2),
            (&"Board 2".to_owned(), &"board".to_owned())
        );
        assert_eq!(&views[3].0[14..15], "7");
        assert!(matches!(&views[3].0[19..20], "8" | "9" | "a" | "b"));
        let deleted_lifecycles = connection
            .query_row(
                "SELECT count(*) FROM database_views \
                 WHERE database_block_id = ?1 AND lifecycle = 'deleted'",
                [&database_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("deleted View siblings");
        assert_eq!(deleted_lifecycles, 2);
        for (encoded, expected_display) in
            [(&views[0].3, board_display), (&views[1].3, list_display)]
        {
            let definition = serde_json::from_str::<Value>(encoded).expect("migrated definition");
            assert_eq!(definition.get("schemaVersion"), Some(&Value::from(5)));
            assert!(definition.pointer("/presentation/layouts").is_none());
            assert_eq!(
                definition.pointer("/presentation/display"),
                Some(&expected_display)
            );
            crate::database::view_contract::decode_v5_definition_validation_json(encoded)
                .expect("migrated definition satisfies the v5 typed contract");
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT default_view_id FROM database_containers WHERE block_id = ?1",
                    [&database_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("default View"),
            view_id
        );

        let preferences = connection
            .prepare(
                "SELECT presentation_override_json FROM database_view_personal_presentations \
                 WHERE profile_id = ?1 AND view_id IN (?2, ?3) ORDER BY view_id",
            )
            .expect("personal View presentation query")
            .query_map(params![profile_id, views[0].0, views[1].0], |row| {
                row.get::<_, String>(0)
            })
            .expect("personal View presentation rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("personal View presentations");
        assert_eq!(preferences.len(), 2);
        for encoded in preferences {
            let preference = serde_json::from_str::<Value>(&encoded).expect("migrated preference");
            assert!(preference.get("layout").is_none());
            assert!(preference.get("layouts").is_none());
            assert!(preference.get("display").is_some());
            assert_eq!(
                preference.get("visibleFields"),
                Some(&serde_json::json!(["title"]))
            );
        }
        for table in [
            "database_view_page_positions",
            "database_view_collapsed_occurrences",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT count(*) FROM {table} WHERE view_id IN (?1, ?2)"),
                        params![views[0].0, views[1].0],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("copied View-scoped state"),
                2
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM database_view_page_positions \
                     WHERE view_id = ?1 AND rank_key = 'position-a' AND revision = 4",
                    [&views[1].0],
                    |row| row.get::<_, i64>(0),
                )
                .expect("copied manual position"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM data_source_page_layout_entries \
                     WHERE data_source_id = ?1 AND visibility = 'always_show'",
                    [&data_source_id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("seeded Page layout"),
            property_count
        );
        let columns = connection
            .prepare("SELECT name FROM pragma_table_info('database_views') ORDER BY cid")
            .expect("View columns")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("View column rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("View columns");
        assert!(columns.contains(&"layout".to_owned()));
        assert!(!columns.contains(&"default_layout".to_owned()));
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM local_commit_visibility_context",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("migration VisibilityDeltaJournal context"),
            0
        );
        validate_schema_identity(&connection, 144).expect("exact published v144 schema");
    }

    #[test]
    fn v140_page_file_history_survives_rehome_and_previous_owner_deletion() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            for step in MIGRATION_STEPS
                .iter()
                .take_while(|step| step.to_revision <= 140)
            {
                let source = published_format(step.from_revision)?;
                let target = published_format(step.to_revision)?;
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "v140-page-file-history.db".to_owned(),
                        source_schema_fingerprint: source.schema_fingerprint,
                        target_schema_fingerprint: target.schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
            }
            Ok(())
        })
        .expect("install v140 schema");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("maintenance writes");
        let library_id = connection
            .query_row("SELECT id FROM libraries LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("fixture Library");
        with_immediate_transaction(&mut connection, |transaction| {
            for (page_id, document_id) in [
                ("page:file-old-owner", "document:file-old-owner"),
                ("page:file-new-owner", "document:file-new-owner"),
            ] {
                transaction.execute(
                    "INSERT INTO blocks(id, library_id, type, lifecycle, placement_revision, \
                       metadata_revision, created_at, updated_at) \
                     VALUES (?1, ?2, 'page', 'active', 1, 1, 'now', 'now')",
                    params![page_id, library_id],
                )?;
                transaction.execute(
                    "INSERT INTO documents(id, library_id, generation, head_seq, schema_key, \
                       schema_version, state_vector, state_hash, readiness, authority, created_at, \
                       updated_at, sync_engine) \
                     VALUES (?1, ?2, 1, 0, 'nodex.page', 3, X'', '', 'pending_genesis', \
                       'legacy_shadow', 'now', 'now', 'yjs')",
                    params![document_id, library_id],
                )?;
                transaction.execute(
                    "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                     VALUES (?1, ?2, ?3, 'now')",
                    params![page_id, document_id, library_id],
                )?;
                transaction.execute(
                    "INSERT INTO pages(block_id, library_id, document_id, parent_kind, parent_id, \
                       created_at, updated_at) VALUES (?1, ?2, ?3, 'library', ?2, 'now', 'now')",
                    params![page_id, library_id, document_id],
                )?;
                if page_id == "page:file-old-owner" {
                    transaction.execute(
                        "UPDATE page_file_manifests SET revision = 1, updated_at = 'now' \
                         WHERE page_id = ?1 AND library_id = ?2",
                        params![page_id, library_id],
                    )?;
                }
            }
            let blob_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            transaction.execute(
                "INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, \
                   created_at) VALUES (?1, 'fixture.bin', 1, 'now')",
                [blob_hash],
            )?;
            transaction.execute(
                "INSERT INTO page_file_versions(file_id, version, library_id, owner_page_id, \
                   manifest_revision, change_kind, logical_path, path_key, mime_type, blob_hash, \
                   byte_length, actor_id, operation_id, occurred_at) VALUES \
                   ('file:history', 1, ?1, 'page:file-old-owner', 1, 'create', 'original.txt', \
                    'original.txt', 'text/plain', ?2, 1, 'actor', 'operation:create', 'now')",
                params![library_id, blob_hash],
            )?;
            transaction.execute(
                "UPDATE page_file_manifests SET revision = 2, updated_at = 'later' \
                 WHERE page_id = 'page:file-old-owner' AND library_id = ?1",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
                 VALUES ('page:file-old-owner', ?1, 'renamed.txt', 'file:history')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO page_file_versions(file_id, version, library_id, owner_page_id, \
                   manifest_revision, change_kind, logical_path, path_key, mime_type, blob_hash, \
                   byte_length, actor_id, operation_id, occurred_at) VALUES \
                   ('file:history', 2, ?1, 'page:file-old-owner', 2, 'rename', 'renamed.txt', \
                    'renamed.txt', 'text/plain', ?2, 1, 'actor', 'operation:rename', 'now')",
                params![library_id, blob_hash],
            )?;
            transaction.execute(
                "INSERT INTO page_files(file_id, library_id, owner_page_id, logical_path, path_key, \
                   mime_type, byte_length, current_version, state, created_by_actor_id, created_at, \
                   updated_at) VALUES ('file:history', ?1, 'page:file-old-owner', 'renamed.txt', \
                   'renamed.txt', 'text/plain', 1, 2, 'live', 'actor', 'now', 'now')",
                [&library_id],
            )?;
            Ok(())
        })
        .expect("seed v140 Page File history");

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v140_to_v141(
                transaction,
                &MigrationContext {
                    source_revision: 140,
                    target_revision: 141,
                    backup_name: "v140-page-file-history.db".to_owned(),
                    source_schema_fingerprint: published_format(140)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(141)?.schema_fingerprint,
                    completed_at_unix_ms: 2,
                },
            )
        })
        .expect("migrate Page File history");

        with_immediate_transaction(&mut connection, |transaction| {
            transaction.execute(
                "UPDATE page_file_manifests SET revision = revision + 1 \
                 WHERE page_id IN ('page:file-old-owner', 'page:file-new-owner')",
                [],
            )?;
            transaction.execute(
                "DELETE FROM page_file_namespace WHERE file_id = 'file:history'",
                [],
            )?;
            transaction.execute(
                "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
                 VALUES ('page:file-new-owner', ?1, 'renamed.txt', 'file:history')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO page_file_versions(file_id, version, library_id, owner_page_id, \
                   manifest_revision, change_kind, logical_path, path_key, mime_type, blob_hash, \
                   byte_length, actor_id, operation_id, occurred_at) VALUES \
                   ('file:history', 3, ?1, 'page:file-new-owner', 1, 'rehome', 'renamed.txt', \
                    'renamed.txt', 'text/plain', \
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, \
                    'actor', 'operation:rehome', 'now')",
                [&library_id],
            )?;
            transaction.execute(
                "UPDATE page_files SET owner_page_id = 'page:file-new-owner', current_version = 3, \
                   updated_at = 'later' WHERE file_id = 'file:history'",
                [],
            )?;
            transaction.execute(
                "DELETE FROM block_documents WHERE block_id = 'page:file-old-owner'",
                [],
            )?;
            transaction.execute("DELETE FROM blocks WHERE id = 'page:file-old-owner'", [])?;
            Ok(())
        })
        .expect("rehome and remove previous owner");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM page_file_versions WHERE file_id = 'file:history'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("history count"),
            3
        );
        assert_eq!(
            connection
                .prepare(
                    "SELECT owner_page_id FROM page_file_versions WHERE file_id = 'file:history' \
                     ORDER BY version",
                )
                .expect("history owners")
                .query_map([], |row| row.get::<_, String>(0))
                .expect("history owner rows")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("history owners"),
            vec![
                "page:file-old-owner".to_owned(),
                "page:file-old-owner".to_owned(),
                "page:file-new-owner".to_owned(),
            ]
        );
        connection
            .execute(
                "DELETE FROM block_documents WHERE block_id = 'page:file-new-owner'",
                [],
            )
            .expect("detach current owner Document");
        connection
            .execute("DELETE FROM blocks WHERE id = 'page:file-new-owner'", [])
            .expect("remove current owner");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM page_file_versions WHERE file_id = 'file:history'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("deleted history count"),
            0
        );
    }

    fn install_baseline_fixture(home: &Path) {
        fs::write(
            home.join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v130.db"),
        )
        .expect("frozen v130 Store");
    }

    fn install_v131_fixture(home: &Path) {
        install_baseline_fixture(home);
        let mut connection = open_writer(&home.join("nodex.db")).expect("v130 writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v130_to_v131(
                transaction,
                &MigrationContext {
                    source_revision: 130,
                    target_revision: 131,
                    backup_name: "published-v131-fixture.db".to_owned(),
                    source_schema_fingerprint: published_format(130)
                        .expect("v130 format")
                        .schema_fingerprint,
                    target_schema_fingerprint: published_format(131)
                        .expect("v131 format")
                        .schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )?;
            validate_schema_identity(transaction, 131)
        })
        .expect("published v131 fixture");
    }

    fn install_v132_fixture(home: &Path) {
        fs::write(
            home.join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v132.db"),
        )
        .expect("frozen v132 Store");
    }

    fn install_v133_fixture(home: &Path) {
        fs::write(
            home.join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v133.db"),
        )
        .expect("frozen v133 Store");
    }

    fn install_v136_fixture(home: &Path) {
        fs::write(
            home.join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v136.db"),
        )
        .expect("frozen v136 Store");
    }

    fn install_v148_fixture(home: &Path) {
        install_intermediate_fixture(home, 148);
    }

    pub(super) fn install_intermediate_fixture(home: &Path, target_revision: i64) {
        install_v136_fixture(home);
        let mut connection = open_writer(&home.join("nodex.db")).expect("v136 writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            for step in MIGRATION_STEPS
                .iter()
                .filter(|step| step.from_revision >= 136 && step.to_revision <= target_revision)
            {
                let source = published_format(step.from_revision)?;
                let target = published_format(step.to_revision)?;
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: format!("published-v{target_revision}-fixture.db"),
                        source_schema_fingerprint: source.schema_fingerprint,
                        target_schema_fingerprint: target.schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
                validate_schema_identity(transaction, step.to_revision)?;
            }
            Ok(())
        })
        .expect("published intermediate fixture");
    }

    fn install_v151_fixture(home: &Path) {
        install_intermediate_fixture(home, 151);
    }

    fn profile_secrets(connection: &Connection) -> (Vec<u8>, String) {
        let token = connection
            .query_row(
                "SELECT key_material FROM nodex_agent_token_keys WHERE id = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .expect("Agent token key");
        let jitter = connection
            .query_row(
                "SELECT jitter_salt FROM core_automation_runtime_metadata WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("automation jitter salt");
        (token, jitter)
    }

    #[test]
    fn fresh_store_installs_current_schema_without_history() {
        let directory = tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let preparation = prepare_profile_store(&mut connection, directory.path()).expect("fresh");
        assert_eq!(
            preparation,
            StorePreparation {
                schema_version: CURRENT_STORE_REVISION,
                created_fresh: true,
                migrated_from_version: None,
                validation: StoreValidationDisposition::Deep,
            }
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .expect("history"),
            0
        );
        let first_secrets = profile_secrets(&connection);
        assert_eq!(first_secrets.0.len(), 32);
        assert!(!first_secrets.1.is_empty());

        let second_directory = tempdir().expect("second Profile");
        let mut second = open_writer(&second_directory.path().join("nodex.db")).expect("writer");
        prepare_profile_store(&mut second, second_directory.path()).expect("second fresh Store");
        let second_secrets = profile_secrets(&second);
        assert_ne!(first_secrets.0, second_secrets.0);
        assert_ne!(first_secrets.1, second_secrets.1);
        validate_current_store(&connection).expect("current Store");
    }

    #[test]
    fn fresh_store_creation_rolls_back_schema_when_profile_initialization_fails() {
        let directory = tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let error = install_fresh_profile_with(&mut connection, |transaction| {
            initialize_fresh_profile(transaction, 1)?;
            Err::<(), _>(corrupt("injected Profile initialization failure"))
        })
        .expect_err("fresh creation failure");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("schema objects"),
            0
        );

        prepare_profile_store(&mut connection, directory.path())
            .expect("fresh creation remains retryable");
        validate_current_store(&connection).expect("retried current Store");
    }

    #[test]
    fn profile_clone_validation_tracks_the_document_schema_migration_boundary() {
        let baseline = tempdir().expect("baseline Profile");
        install_baseline_fixture(baseline.path());
        let baseline_connection =
            open_writer(&baseline.path().join("nodex.db")).expect("baseline writer");
        assert_eq!(
            validate_profile_clone_source(&baseline_connection).expect("v130 clone source"),
            BASELINE_STORE_REVISION
        );
        drop(baseline_connection);

        let migrated = tempdir().expect("v135 Profile");
        install_baseline_fixture(migrated.path());
        let mut connection = open_writer(&migrated.path().join("nodex.db")).expect("v130 writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            for step in MIGRATION_STEPS.iter().take(5) {
                let source = published_format(step.from_revision)?;
                let target = published_format(step.to_revision)?;
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "profile-clone-validation.db".to_owned(),
                        source_schema_fingerprint: source.schema_fingerprint,
                        target_schema_fingerprint: target.schema_fingerprint,
                        completed_at_unix_ms: 1_777_000_000_000,
                    },
                )?;
                validate_schema_identity(transaction, step.to_revision)?;
            }
            Ok(())
        })
        .expect("v135 migration source");
        assert_eq!(
            validate_profile_clone_source(&connection).expect("v135 clone source"),
            CURRENT_DOCUMENT_SCHEMA_REVISION
        );
    }

    #[test]
    fn baseline_store_migrates_once_and_converges_with_fresh_schema() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let baseline_secrets = profile_secrets(&connection);
        let mut events = Vec::new();
        let preparation =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect("migrate baseline");
        assert_eq!(preparation.migrated_from_version, Some(130));
        assert_migration_events(&events, 130);
        let history = connection
            .prepare(
                "SELECT source_revision, target_revision, source_schema_fingerprint, \
                        target_schema_fingerprint, backup_name, completed_at_unix_ms \
                 FROM core_store_migration_history ORDER BY source_revision",
            )
            .expect("history query")
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .expect("migration history")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("migration history rows");
        assert_eq!(
            history.len(),
            usize::try_from(expected_migration_step_count(130))
                .expect("migration count fits usize")
        );
        assert_eq!((history[0].0, history[0].1), (130, 131));
        assert_eq!((history[1].0, history[1].1), (131, 132));
        assert_eq!((history[2].0, history[2].1), (132, 133));
        assert_eq!((history[3].0, history[3].1), (133, 134));
        assert_eq!((history[4].0, history[4].1), (134, 135));
        assert_eq!((history[5].0, history[5].1), (135, 136));
        assert_eq!((history[6].0, history[6].1), (136, 137));
        assert_eq!((history[7].0, history[7].1), (137, 138));
        assert_eq!((history[8].0, history[8].1), (138, 139));
        assert_eq!((history[9].0, history[9].1), (139, 140));
        assert_eq!((history[10].0, history[10].1), (140, 141));
        assert_eq!((history[11].0, history[11].1), (141, 142));
        assert_eq!((history[12].0, history[12].1), (142, 143));
        assert_eq!((history[13].0, history[13].1), (143, 144));
        assert_eq!((history[14].0, history[14].1), (144, 145));
        assert_eq!((history[15].0, history[15].1), (145, 146));
        assert_eq!((history[16].0, history[16].1), (146, 147));
        assert_eq!((history[17].0, history[17].1), (147, 148));
        assert_eq!((history[18].0, history[18].1), (148, 149));
        assert_eq!((history[19].0, history[19].1), (149, 150));
        assert_eq!(
            history[0].2,
            published_format(130)
                .expect("v130 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[0].3,
            published_format(131)
                .expect("v131 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[1].2,
            published_format(131)
                .expect("v131 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[1].3,
            published_format(132)
                .expect("v132 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[2].2,
            published_format(132)
                .expect("v132 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[2].3,
            published_format(133)
                .expect("v133 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[3].2,
            published_format(133)
                .expect("v133 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[3].3,
            published_format(134)
                .expect("v134 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[4].3,
            published_format(135)
                .expect("v135 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[5].3,
            published_format(136)
                .expect("v136 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[11].3,
            published_format(142)
                .expect("v142 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[12].3,
            published_format(143)
                .expect("v143 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[13].3,
            published_format(144)
                .expect("v144 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[14].3,
            published_format(145)
                .expect("v145 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[15].3,
            published_format(146)
                .expect("v146 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[16].3,
            published_format(147)
                .expect("v147 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[17].3,
            published_format(148)
                .expect("v148 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[18].3,
            published_format(149)
                .expect("v149 format")
                .schema_fingerprint
        );
        assert_eq!(
            history[19].3,
            published_format(150)
                .expect("v150 format")
                .schema_fingerprint
        );
        assert!(history.iter().all(|row| row.4 == history[0].4));
        assert!(
            history[0]
                .4
                .starts_with(&format!("v130-to-v{CURRENT_STORE_REVISION}-"))
        );
        assert!(history[0].4.ends_with(".db"));
        assert!(history.iter().all(|row| row.5 > 0));
        let backup_path = directory
            .path()
            .join("backups/core-migrations")
            .join(&history[0].4);
        let backup_metadata = fs::symlink_metadata(&backup_path).expect("migration backup");
        assert!(backup_metadata.is_file());
        assert!(!backup_metadata.file_type().is_symlink());
        assert_eq!(profile_secrets(&connection), baseline_secrets);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version"),
            CURRENT_STORE_REVISION
        );
        validate_schema_identity(&connection, CURRENT_STORE_REVISION).expect("converged schema");
        drop(connection);

        let mut reopened = open_writer(&directory.path().join("nodex.db")).expect("reopen");
        let reopened_preparation =
            prepare_profile_store(&mut reopened, directory.path()).expect("current reopen");
        assert_eq!(reopened_preparation.migrated_from_version, None);
        assert_eq!(
            reopened
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .expect("stable history"),
            expected_migration_step_count(130)
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .expect("backups")
                .count(),
            1
        );
    }

    #[test]
    fn published_v131_store_migrates_directly_to_current() {
        let directory = tempdir().expect("Profile");
        install_v131_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let mut events = Vec::new();

        let preparation =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect("migrate v131");

        assert_eq!(preparation.migrated_from_version, Some(131));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        assert_migration_events(&events, 131);
        validate_current_store(&connection).expect("current Store");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("migration history"),
            1 + expected_migration_step_count(131)
        );
    }

    #[test]
    fn frozen_v132_store_migrates_directly_to_current_once() {
        let directory = tempdir().expect("Profile");
        install_v132_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        validate_schema_identity(&connection, 132).expect("exact frozen v132 Store");
        let mut events = Vec::new();

        let preparation =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect("migrate v132");

        assert_eq!(preparation.migrated_from_version, Some(132));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        assert_migration_events(&events, 132);
        validate_current_store(&connection).expect("current Store");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("migration history"),
            expected_migration_step_count(132)
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM project_session_pages", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .expect("Page–Session relation table"),
            0
        );
        drop(connection);

        let mut reopened = open_writer(&directory.path().join("nodex.db")).expect("reopen");
        let reopened_preparation =
            prepare_profile_store(&mut reopened, directory.path()).expect("current reopen");
        assert_eq!(reopened_preparation.migrated_from_version, None);
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .expect("backups")
                .count(),
            1
        );
    }

    #[test]
    fn published_v133_store_migrates_to_queued_follow_up_schema_once() {
        let directory = tempdir().expect("Profile");
        install_v133_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        validate_schema_identity(&connection, 133).expect("exact published v133 Store");
        let mut events = Vec::new();

        let preparation =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect("migrate v133");

        assert_eq!(preparation.migrated_from_version, Some(133));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        assert_migration_events(&events, 133);
        validate_current_store(&connection).expect("current Store");
        let table = "codex_queued_message_state";
        let exists = connection
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                [table],
                |_| Ok(()),
            )
            .optional()
            .expect("schema query")
            .is_some();
        assert!(exists, "missing {table}");
        assert!(
            connection
                .query_row(
                    "SELECT 1 FROM sqlite_schema WHERE type = 'table' \
                     AND name = 'codex_queued_follow_up_manifest_gc'",
                    [],
                    |_| Ok(()),
                )
                .optional()
                .expect("legacy queue GC schema query")
                .is_none()
        );
    }

    #[test]
    fn retiring_subagent_lifecycle_ledger_preserves_discovery_and_status() {
        let mut connection = Connection::open_in_memory().expect("fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .unwrap();
        for step in MIGRATION_STEPS
            .iter()
            .filter(|step| step.from_revision >= 164 && step.to_revision <= 170)
        {
            with_schema_rebuild_transaction(&mut connection, |transaction| {
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        source_schema_fingerprint: published_format(step.from_revision)?
                            .schema_fingerprint,
                        target_schema_fingerprint: published_format(step.to_revision)?
                            .schema_fingerprint,
                        backup_name: "fixture".to_owned(),
                        completed_at_unix_ms: 1,
                    },
                )
            })
            .unwrap();
        }
        validate_schema_identity(&connection, 170).expect("exact predecessor");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .unwrap();
        connection.execute_batch(r#"
          INSERT INTO profiles(id,created_at,updated_at) VALUES ('profile','today','today');
          INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES ('library','profile','today','today');
          INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at) VALUES ('root',1,1,'today'),('child',1,1,'today');
          INSERT INTO workspace_subagent_universes VALUES ('local','epoch',1,'root',NULL,1,1,'today');
          INSERT INTO workspace_subagent_discovery_pages VALUES ('local','epoch',1,'root','page', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL,1,'today');
          INSERT INTO workspace_subagent_descendants VALUES ('local','epoch',1,'root','child','root','page','today');
          INSERT INTO workspace_subagent_status_evidence VALUES ('local','epoch',1,'root','child','done','completion',5,100,'today');
          INSERT INTO workspace_subagent_lifecycle_operations VALUES ('operation','library','local','epoch',1,'root','archive','today','today');
          INSERT INTO workspace_subagent_lifecycle_members VALUES ('operation','child','unresolved',1,'unavailable',100);
        "#).unwrap();
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v170_to_v171(
                transaction,
                &MigrationContext {
                    source_revision: 170,
                    target_revision: 171,
                    source_schema_fingerprint: published_format(170)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(171)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 2,
                },
            )
        })
        .unwrap();
        validate_schema_identity(&connection, 171).expect("exact target");
        let retained: (String, String, i64, i64) = connection.query_row(
            "SELECT d.parent_thread_id,s.status,s.source_revision,u.discovery_complete FROM workspace_subagent_descendants d JOIN workspace_subagent_status_evidence s USING(host_id,source_epoch,generation,root_thread_id,thread_id) JOIN workspace_subagent_universes u USING(host_id,source_epoch,generation,root_thread_id)",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(retained, ("root".to_owned(), "done".to_owned(), 5, 1));
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM codex_threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM workspace_subagent_discovery_pages",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(connection.query_row("SELECT json_extract(evidence_json,'$.retired_subagent_lifecycle_ledger') FROM core_store_migration_history WHERE source_revision=170 AND target_revision=171", [], |row| row.get::<_,bool>(0)).unwrap());
    }

    #[test]
    fn automation_session_migration_preserves_review_history_and_existing_lease_identity() {
        let mut connection = Connection::open_in_memory().expect("fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .unwrap();
        for step in MIGRATION_STEPS
            .iter()
            .filter(|step| step.from_revision >= 164 && step.to_revision <= 178)
        {
            with_schema_rebuild_transaction(&mut connection, |transaction| {
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        source_schema_fingerprint: published_format(step.from_revision)?
                            .schema_fingerprint,
                        target_schema_fingerprint: published_format(step.to_revision)?
                            .schema_fingerprint,
                        backup_name: "fixture".to_owned(),
                        completed_at_unix_ms: 1,
                    },
                )
            })
            .unwrap();
        }
        validate_schema_identity(&connection, 178).expect("exact predecessor");
        connection.execute_batch("INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,prompt,rrule,created_at,updated_at)
            VALUES ('report','cron','ACTIVE','Report','Prompt','FREQ=DAILY',1,1);
          INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at) VALUES ('native:legacy',1,1,'today');
          INSERT INTO project_sessions(id,no_thread_fallback_title,\"order\",created_at,updated_at)
            VALUES ('session:legacy','Report',0,'today','today');
          INSERT INTO project_session_threads(session_id,thread_id,linked_at) VALUES ('session:legacy','native:legacy','today');
          INSERT INTO codex_automation_runs(thread_id,automation_id,status,thread_title,archived_assistant_message,created_at,updated_at,run_revision)
            VALUES ('native:legacy','report','ARCHIVED','Retained report','Full captured review body',1,2,7),
              ('pending:legacy','report','IN_PROGRESS','Preparing',NULL,1,1,1);
          INSERT INTO core_automation_leases(lease_id,automation_id,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms)
            VALUES ('lease:legacy','report',0,1,'claimed',0,100);").unwrap();
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v178_to_v179(
                transaction,
                &MigrationContext {
                    source_revision: 178,
                    target_revision: 179,
                    source_schema_fingerprint: published_format(178)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(179)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 2,
                },
            )
        })
        .unwrap();
        validate_schema_identity(&connection, 179).expect("fresh and migrated schemas converge");
        let retained = connection.query_row("SELECT run_id,session_id,status,session_title,archived_assistant_message,run_revision
            FROM core_automation_runs WHERE run_id='native:legacy'", [], |row| Ok((row.get::<_,String>(0)?,
                row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,i64>(5)?))).unwrap();
        assert_eq!(
            retained,
            (
                "native:legacy".to_owned(),
                "session:legacy".to_owned(),
                "ARCHIVED".to_owned(),
                "Retained report".to_owned(),
                "Full captured review body".to_owned(),
                7
            )
        );
        let pending = connection
            .query_row(
                "SELECT session_id IS NULL FROM core_automation_runs WHERE run_id='pending:legacy'",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap();
        assert!(pending);
        let lease = connection.query_row("SELECT dispatch_id,definition_revision,attempt FROM core_automation_leases WHERE lease_id='lease:legacy'", [],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))).unwrap();
        assert_eq!(lease, ("lease:legacy".to_owned(), 1, 1));
        assert!(connection.execute("UPDATE core_automation_runs SET session_id='another-session' WHERE run_id='native:legacy'", []).is_err());
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .unwrap();
        connection.execute_batch("INSERT INTO profiles(id,created_at,updated_at) VALUES ('profile:retained','today','today');
          INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES ('library:retained','profile:retained','today','today');
          INSERT INTO block_store_metadata(id,store_epoch,created_at,updated_at) VALUES (1,'epoch:old','today','today');
          INSERT INTO project_sessions(id,no_thread_fallback_title,\"order\",created_at,updated_at) VALUES ('session:runtime','Runtime',0,'today','today');
          INSERT INTO project_session_execution_bindings(session_id,runtime_id,runtime_thread_id,launch_request_id,launch_request_hash,bound_at)
            VALUES ('session:runtime','engine:stable','thread:stable','launch:stable','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','today');
          INSERT INTO nodex_agent_runtime_execution_cleanups(cleanup_id,library_id,session_id,runtime_id,runtime_thread_id,created_at,acknowledged_at)
            VALUES ('cleanup:stable','library:retained','session:deleted','engine:stable','thread:deleted','today','today');
          INSERT INTO change_log(store_epoch,kind,payload_json,committed_at,projection_impact_json) VALUES ('epoch:old','owned_document.document_invalidated','{\"module\":\"owned_document\",\"kind\":\"document_invalidated\",\"reason\":\"access_changed\",\"documentId\":\"retained\",\"generation\":1,\"headSeq\":1}','today','{\"kind\":\"none\"}');").unwrap();
        let context = MigrationContext {
            source_revision: 179,
            target_revision: 180,
            source_schema_fingerprint: published_format(179).unwrap().schema_fingerprint,
            target_schema_fingerprint: published_format(180).unwrap().schema_fingerprint,
            backup_name: "fixture".into(),
            completed_at_unix_ms: 3,
        };
        let failed = with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v179_to_v180(transaction, &context)?;
            Err::<(), _>(internal("Injected publication failure"))
        })
        .unwrap_err();
        assert_eq!(failed.message, "Injected publication failure");
        validate_schema_identity(&connection, 179).expect("failed upgrade rolled back every table");
        assert_eq!(
            connection
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "epoch:old"
        );
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v179_to_v180(transaction, &context)
        })
        .unwrap();
        validate_schema_identity(&connection, 180).expect("Profile schema converges");
        assert_ne!(
            connection
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "epoch:old"
        );
        assert_eq!(connection.query_row("SELECT runtime_id,runtime_thread_id,launch_request_id FROM project_session_execution_bindings WHERE session_id='session:runtime'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap(),("engine:stable".into(),"thread:stable".into(),"launch:stable".into()));
        assert_eq!(
            connection
                .query_row(
                    "SELECT dispatch_id FROM core_automation_leases WHERE lease_id='lease:legacy'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "lease:legacy"
        );
        assert_eq!(connection.query_row("SELECT archived_assistant_message FROM core_automation_runs WHERE run_id='native:legacy'",[],|r|r.get::<_,String>(0)).unwrap(),"Full captured review body");
        assert_eq!(connection.query_row("SELECT acknowledged_at FROM nodex_agent_runtime_execution_cleanups WHERE cleanup_id='cleanup:stable'",[],|r|r.get::<_,String>(0)).unwrap(),"today");
        assert_eq!(connection.query_row("SELECT json_extract(payload_json,'$.reason') FROM change_log WHERE kind='owned_document.document_invalidated'",[],|r|r.get::<_,String>(0)).unwrap(),"owner_deleted");
    }

    #[test]
    fn recovery_bundle_migration_preserves_exact_legacy_bytes_and_resource_roots() {
        let mut connection = Connection::open_in_memory().expect("fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .unwrap();
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            transaction.execute_batch(include_str!("../../schema/migrations/v164_to_v165.sql"))?;
            Ok(())
        })
        .unwrap();
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .unwrap();
        connection.execute_batch("INSERT INTO profiles(id,created_at,updated_at) VALUES ('profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES ('library','profile','today','today');").unwrap();
        let payload = "{ \"source\": \"保留\", \"bytes\": [0,255] }";
        let hash =
            nodex_core_contracts::document::recovery_bundle::payload_hash(payload.as_bytes());
        connection.execute("INSERT INTO document_recovery_drafts(library_id,draft_id,document_id,source_store_epoch,generation,created_at,received_at,payload_json,payload_hash,byte_length) VALUES ('library','draft','document','epoch',1,'today','today',?1,?2,?3)", params![payload,hash,payload.len() as i64]).unwrap();
        connection
            .execute(
                "INSERT INTO document_recovery_asset_roots VALUES ('library','draft',?1)",
                ["a".repeat(64)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO document_recovery_file_snapshots VALUES ('library','draft','{}',?1)",
                ["b".repeat(64)],
            )
            .unwrap();
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v165_to_v166(
                transaction,
                &MigrationContext {
                    source_revision: 165,
                    target_revision: 166,
                    source_schema_fingerprint: published_format(165)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(166)?.schema_fingerprint,
                    backup_name: "fixture".into(),
                    completed_at_unix_ms: 1,
                },
            )
        })
        .unwrap();
        validate_schema_identity(&connection, 166).unwrap();
        let stored = connection.query_row("SELECT payload_encoding,payload,payload_hash,byte_length FROM document_recovery_drafts", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?))).unwrap();
        assert_eq!(
            stored,
            (
                "legacy_json".into(),
                payload.as_bytes().to_vec(),
                hash,
                payload.len() as i64
            )
        );
        for table in [
            "document_recovery_asset_roots",
            "document_recovery_file_snapshots",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    fn projectless_actor_migration_preserves_authority_and_prevents_actor_rebinding() {
        let mut connection = Connection::open_in_memory().expect("historical fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .expect("published schema");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("historical maintenance");
        connection.execute_batch("INSERT INTO profiles(id,created_at,updated_at) VALUES ('profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES ('library','profile','today','today'); INSERT INTO projects(id,library_id,name,created,updated) VALUES ('project','library','Project','today','today');").expect("historical scope");
        connection.execute("INSERT INTO nodex_agent_turn_authorities(thread_id,turn_id,root_thread_id,
          actor_project_id,library_id,profile_id,store_epoch,scope,source,authority_fingerprint,
          provenance_version,created_at,read_only) VALUES ('thread','turn','thread','project','library',
          'profile','epoch','project','project_turn',?1,1,'today',0)", ["a".repeat(64)]).expect("historical authority");
        connection
            .execute(
                "INSERT INTO managed_blobs VALUES (?1,'asset',1,'today')",
                ["b".repeat(64)],
            )
            .expect("historical blob");
        connection
            .execute(
                "INSERT INTO prepared_blob_receipts(receipt_id,project_id,library_id,store_epoch,
          content_hash,byte_length,operation_id,expires_at_unix_ms,created_at,updated_at)
          VALUES ('receipt','project','library','epoch',?1,1,'operation',100,'today','today')",
                ["b".repeat(64)],
            )
            .expect("historical prepared receipt");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v164_to_v165(
                transaction,
                &MigrationContext {
                    source_revision: 164,
                    target_revision: 165,
                    source_schema_fingerprint: published_format(164)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(165)?.schema_fingerprint,
                    backup_name: "fixture".into(),
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("optional actor migration");
        validate_schema_identity(&connection, 165).expect("published target");
        let retained = connection.query_row("SELECT actor_project_id,authority_fingerprint,read_only FROM nodex_agent_turn_authorities", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?))).expect("retained authority");
        assert_eq!(retained, ("project".into(), "a".repeat(64), false));
        assert!(connection.execute("UPDATE prepared_blob_receipts SET project_id=NULL,state='consumed',consumed_commit_seq=1", []).is_err());
        connection
            .execute(
                "UPDATE prepared_blob_receipts SET state='consumed',consumed_commit_seq=1",
                [],
            )
            .expect("original actor can consume");
        let insert = "INSERT INTO nodex_agent_turn_authorities(thread_id,turn_id,root_thread_id,
          actor_project_id,library_id,profile_id,store_epoch,scope,source,permission_profile_id,
          authority_fingerprint,provenance_version,created_at) VALUES ('projectless',?1,'projectless',NULL,
          'library','profile','epoch',?2,?3,?4,?5,1,'today')";
        assert!(
            connection
                .execute(
                    insert,
                    params![
                        "invalid",
                        "project",
                        "project_turn",
                        Option::<String>::None,
                        "c".repeat(64)
                    ]
                )
                .is_err()
        );
        connection
            .execute(
                insert,
                params![
                    "valid",
                    "library",
                    "builtin_full_access",
                    ":danger-full-access",
                    "c".repeat(64)
                ],
            )
            .expect("real absent actor");
        assert!(connection.execute("UPDATE nodex_agent_turn_authorities SET actor_project_id='project' WHERE thread_id='projectless'", []).is_err());
        connection.execute("INSERT INTO prepared_blob_receipts(receipt_id,project_id,library_id,store_epoch,
          content_hash,byte_length,operation_id,expires_at_unix_ms,created_at,updated_at)
          VALUES ('projectless-receipt',NULL,'library','epoch',?1,1,'null-operation',100,'today','today')", ["b".repeat(64)]).expect("projectless receipt");
        assert!(connection.execute("UPDATE prepared_blob_receipts SET project_id='project',state='consumed',consumed_commit_seq=2 WHERE receipt_id='projectless-receipt'", []).is_err());
        connection.execute("UPDATE prepared_blob_receipts SET state='consumed',consumed_commit_seq=2 WHERE receipt_id='projectless-receipt'", []).expect("absent actor remains absent on consumption");
    }

    #[test]
    fn historical_cron_targets_require_an_unambiguous_active_project() {
        let mut connection = Connection::open_in_memory().expect("migration fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .expect("published fixture schema");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("historical fixture maintenance");
        connection.execute_batch(r#"ALTER TABLE codex_scheduled_automations DROP COLUMN project_id; PRAGMA user_version = 163;
          INSERT INTO projects(id,name,created,updated) VALUES ('a','A','today','today'),('b','B','today','today');
          INSERT INTO project_sources(project_id,root,root_key,"order",created,updated) VALUES ('a','/unique','/unique',0,'today','today'),('a','/shared','/shared',1,'today','today'),('b','/shared','/shared',0,'today','today');
          INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,rrule,cwds_json,execution_environment,created_at,updated_at,next_run_at) VALUES
          ('unique','cron','ACTIVE','Unique','FREQ=DAILY','["/unique","/shared"]','local',1,1,100),
          ('shared','cron','ACTIVE','Shared','FREQ=DAILY','["/shared"]','local',1,1,100),
          ('foreign','cron','ACTIVE','Foreign','FREQ=DAILY','["/foreign"]','local',1,1,100),
          ('projectless','cron','ACTIVE','Projectless','FREQ=DAILY','[]','local',1,1,100);"#).expect("historical targets");
        validate_schema_identity(&connection, 163).expect("published predecessor");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v163_to_v164(
                transaction,
                &MigrationContext {
                    source_revision: 163,
                    target_revision: 164,
                    source_schema_fingerprint: published_format(163)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(164)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 1_788_825_600_000,
                },
            )
        })
        .expect("Project migration");
        validate_schema_identity(&connection, 164).expect("published target");
        let rows = connection.prepare("SELECT automation_id,status,project_id,next_run_at FROM codex_scheduled_automations ORDER BY automation_id").expect("query").query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<i64>>(3)?))).expect("targets").collect::<rusqlite::Result<Vec<_>>>().expect("rows");
        assert_eq!(
            rows,
            vec![
                ("foreign".to_owned(), "PAUSED".to_owned(), None, None),
                (
                    "projectless".to_owned(),
                    "ACTIVE".to_owned(),
                    None,
                    Some(100)
                ),
                ("shared".to_owned(), "PAUSED".to_owned(), None, None),
                (
                    "unique".to_owned(),
                    "ACTIVE".to_owned(),
                    Some("a".to_owned()),
                    Some(100)
                ),
            ]
        );
    }

    #[test]
    fn historical_heartbeats_bind_to_sessions_and_pause_detached_targets() {
        let mut connection = Connection::open_in_memory().expect("migration fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .expect("published fixture schema");
        connection.execute_batch(r#"ALTER TABLE codex_scheduled_automations DROP COLUMN project_id; ALTER TABLE codex_scheduled_automations RENAME COLUMN target_session_id TO target_thread_id; PRAGMA user_version = 162;
          INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at) VALUES ('backend',1,1,'2026-09-08');
          INSERT INTO project_sessions(id,no_thread_fallback_title,"order",created_at,updated_at) VALUES ('session','Target',0,'2026-09-08','2026-09-08');
          INSERT INTO project_session_threads(session_id,thread_id,linked_at) VALUES ('session','backend','2026-09-08');
          INSERT INTO codex_scheduled_automations(automation_id,kind,status,target_thread_id,name,rrule,created_at,updated_at,next_run_at) VALUES ('attached','heartbeat','ACTIVE','backend','Attached','FREQ=DAILY',1,1,100),('detached','heartbeat','ACTIVE','gone','Detached','FREQ=DAILY',1,1,100);"#).expect("historical targets");
        validate_schema_identity(&connection, 162).expect("published predecessor");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v162_to_v163(
                transaction,
                &MigrationContext {
                    source_revision: 162,
                    target_revision: 163,
                    source_schema_fingerprint: published_format(162)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(163)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 1_788_825_600_000,
                },
            )
        })
        .expect("Session target migration");
        validate_schema_identity(&connection, 163).expect("published target");
        let rows = connection.prepare("SELECT automation_id,status,target_session_id,next_run_at FROM codex_scheduled_automations ORDER BY automation_id").expect("query").query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<i64>>(3)?))).expect("targets").collect::<rusqlite::Result<Vec<_>>>().expect("rows");
        assert_eq!(
            rows,
            vec![
                (
                    "attached".to_owned(),
                    "ACTIVE".to_owned(),
                    Some("session".to_owned()),
                    Some(100)
                ),
                ("detached".to_owned(), "PAUSED".to_owned(), None, None)
            ]
        );
    }

    #[test]
    fn historical_automations_gain_nullable_notification_preferences() {
        let mut connection = Connection::open_in_memory().expect("migration fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .expect("published fixture schema");
        connection.execute_batch("ALTER TABLE codex_scheduled_automations DROP COLUMN project_id; ALTER TABLE codex_scheduled_automations RENAME COLUMN target_session_id TO target_thread_id; ALTER TABLE codex_scheduled_automations DROP COLUMN notification_policy; PRAGMA user_version = 161;").expect("predecessor");
        validate_schema_identity(&connection, 161).expect("exact predecessor");
        connection.execute("INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,prompt,rrule,cwds_json,execution_environment,created_at,updated_at) VALUES ('daily','cron','ACTIVE','Daily','Review','FREQ=DAILY','[]','local',1,1)", []).expect("historical automation");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v161_to_v162(
                transaction,
                &MigrationContext {
                    source_revision: 161,
                    target_revision: 162,
                    source_schema_fingerprint: published_format(161)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(162)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 1_788_825_600_000,
                },
            )
        })
        .expect("notification migration");
        validate_schema_identity(&connection, 162).expect("published target");
        let policy: Option<String> = connection.query_row("SELECT notification_policy FROM codex_scheduled_automations WHERE automation_id='daily'", [], |row| row.get(0)).expect("preserved automation");
        assert_eq!(policy, None);
        connection
            .execute(
                "UPDATE codex_scheduled_automations SET notification_policy='failed_runs_only'",
                [],
            )
            .expect("mute successes");
        assert!(
            connection
                .execute(
                    "UPDATE codex_scheduled_automations SET notification_policy='invalid'",
                    []
                )
                .is_err()
        );
        connection
            .execute(
                "UPDATE codex_scheduled_automations SET notification_policy=NULL",
                [],
            )
            .expect("unmute");
    }

    #[test]
    fn historical_turn_authority_gains_an_immutable_read_only_policy() {
        let mut connection = Connection::open_in_memory().expect("migration fixture");
        connection
            .execute_batch(include_str!("../../schema/published/v164.sql"))
            .expect("published fixture schema");
        connection.execute_batch("ALTER TABLE codex_scheduled_automations DROP COLUMN project_id; ALTER TABLE codex_scheduled_automations RENAME COLUMN target_session_id TO target_thread_id; ALTER TABLE codex_scheduled_automations DROP COLUMN notification_policy; ALTER TABLE nodex_agent_turn_authorities DROP COLUMN read_only; PRAGMA user_version = 160;")
            .expect("historical authority shape");
        validate_schema_identity(&connection, 160).expect("exact predecessor");
        connection.execute("INSERT INTO nodex_agent_turn_authorities(thread_id,turn_id,root_thread_id,
            actor_project_id,library_id,profile_id,store_epoch,scope,source,authority_fingerprint,
            provenance_version,created_at) VALUES ('thread','turn','thread','project','library','profile',
            'epoch','project','project_turn',?1,1,'2026-09-08T00:00:00.000Z')", ["a".repeat(64)])
            .expect("historical frozen authority");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v160_to_v161(
                transaction,
                &MigrationContext {
                    source_revision: 160,
                    target_revision: 161,
                    source_schema_fingerprint: published_format(160)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(161)?.schema_fingerprint,
                    backup_name: "fixture".to_owned(),
                    completed_at_unix_ms: 1_788_825_600_000,
                },
            )
        })
        .expect("policy migration");
        validate_schema_identity(&connection, 161).expect("current schema identity");
        assert!(connection.query_row("SELECT read_only FROM nodex_agent_turn_authorities WHERE thread_id='thread' AND turn_id='turn'", [], |row| row.get::<_, bool>(0)).expect("read-only default"));
        assert!(
            connection
                .execute("UPDATE nodex_agent_turn_authorities SET read_only=0", [])
                .is_err()
        );
    }

    #[test]
    fn exact_v136_predecessor_migrates_to_current_once() {
        let directory = tempdir().expect("Profile");
        install_v136_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        validate_schema_identity(&connection, 136).expect("exact published v136 Store");
        let source_secrets = profile_secrets(&connection);
        let mut events = Vec::new();

        let preparation =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect("migrate v136");

        assert_eq!(preparation.migrated_from_version, Some(136));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        assert_migration_events(&events, 136);
        validate_current_store(&connection).expect("current Store");
        assert_eq!(profile_secrets(&connection), source_secrets);
        let (source_revision, target_revision, backup_name) = connection
            .query_row(
                "SELECT source_revision, target_revision, backup_name \
                 FROM core_store_migration_history \
                 ORDER BY source_revision DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .expect("v136 migration history");
        assert_eq!(
            (source_revision, target_revision),
            (CURRENT_STORE_REVISION - 1, CURRENT_STORE_REVISION)
        );
        assert!(backup_name.starts_with(&format!("v136-to-v{CURRENT_STORE_REVISION}-")));
        let backup_path = directory
            .path()
            .join("backups/core-migrations")
            .join(backup_name);
        validate_migration_backup(&backup_path, 136).expect("exact v136 migration backup");
        drop(connection);

        let mut reopened = open_writer(&directory.path().join("nodex.db")).expect("reopen");
        let reopened_preparation =
            prepare_profile_store(&mut reopened, directory.path()).expect("current reopen");
        assert_eq!(reopened_preparation.migrated_from_version, None);
        assert_eq!(
            reopened
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("stable history"),
            expected_migration_step_count(136)
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .expect("backups")
                .count(),
            1
        );
    }

    #[test]
    fn exact_v152_predecessor_adds_ephemeral_history_without_replacing_file_identity() {
        let directory = tempdir().expect("Profile");
        install_intermediate_fixture(directory.path(), 152);
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        validate_schema_identity(&connection, 152).expect("published independent File Store");
        let secrets = profile_secrets(&connection);
        let preparation =
            prepare_profile_store(&mut connection, directory.path()).expect("migrate");
        assert_eq!(preparation.migrated_from_version, Some(152));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        validate_current_store(&connection).expect("current Store");
        assert_eq!(profile_secrets(&connection), secrets);
        let owners: i64 = connection
            .query_row("SELECT count(*) FROM editor_history_owners", [], |row| {
                row.get(0)
            })
            .expect("owners");
        assert_eq!(owners, 0);
        let history: i64 = connection.query_row("SELECT count(*) FROM core_store_migration_history WHERE source_revision = 152 AND target_revision = 159", [], |row| row.get(0)).expect("migration evidence");
        assert_eq!(history, 1);
        let reopened = prepare_profile_store(&mut connection, directory.path()).expect("reopen");
        assert_eq!(reopened.migrated_from_version, None);
    }

    #[test]
    fn epoch_migration_releases_old_lifetimes_after_preserving_dormant_content() {
        use crate::infrastructure::store::SqliteStoreKernel;
        use crate::library::LibraryModule;

        const NOW: &str = "2026-10-01T00:00:00.000Z";
        const DOCUMENT: &str = "document:retained-upgrade";
        const PLACEHOLDER: &str = "018f0000-0000-7000-8000-000000000921";
        let profile = tempdir().unwrap();
        install_intermediate_fixture(profile.path(), 174);
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        let (profile_id, library_id): (String, String) = connection
            .query_row("SELECT profile_id,id FROM libraries", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        connection.execute(
            "INSERT OR IGNORE INTO block_store_metadata(id,store_epoch,created_at,updated_at) VALUES (1,'epoch:before-upgrade',?1,?1)",
            [NOW],
        ).unwrap();
        let epoch: String = connection
            .query_row("SELECT store_epoch FROM block_store_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        let genesis =
            crate::document::prepare_page_yjs_genesis(DOCUMENT, "Retained content", PLACEHOLDER)
                .unwrap();
        let body = json!({"action": {"kind": "restore_turned_selection", "state": {
            "dormantPages": [{"pageId": "page:former-owner", "documentId": DOCUMENT,
                "placeholderBlockId": PLACEHOLDER}]
        }}})
        .to_string();
        let hash = crate::document::sha256(body.as_bytes());
        let transfer_body = json!({"version":2,"project_id":"project:upgrade","library_id":library_id,"store_epoch":epoch,
            "page_id":PLACEHOLDER,"result_location_revision":1,"result_parent":{"kind":"library","library_id":library_id},
            "source":{"kind":"library","previous_sibling_id":null,"next_sibling_id":null}}).to_string();
        let transfer_hash = crate::document::sha256(transfer_body.as_bytes());
        super::super::legacy_visibility_migration::install_test_maintenance_context(&connection)
            .unwrap();
        with_immediate_transaction(&mut connection, |transaction| {
            transaction.execute(
                "INSERT INTO projects(id,library_id,name,created,updated) VALUES ('project:upgrade',?1,'Retained Project',?2,?2)",
                params![library_id,NOW],
            )?;
            transaction.execute(
                "INSERT INTO blocks(id,library_id,type,lifecycle,placement_revision,metadata_revision,created_at,updated_at) VALUES (?1,?2,'paragraph','active',1,1,?3,?3)",
                params![PLACEHOLDER,library_id,NOW],
            )?;
            transaction.execute(
                "INSERT INTO documents(id,library_id,generation,head_seq,schema_key,schema_version,state_vector,state_hash,readiness,authority,created_at,updated_at,sync_engine)
                 VALUES (?1,?2,1,0,'nodex.page',3,?3,'','ready','ydoc_primary',?4,?4,'yjs')",
                params![DOCUMENT,library_id,genesis.state_vector_v1,NOW],
            )?;
            transaction.execute(
                "INSERT INTO document_snapshots(document_id,generation,snapshot_seq,state_vector,snapshot_update,snapshot_hash,schema_version,created_at) VALUES (?1,1,0,?2,?3,?4,3,?5)",
                params![DOCUMENT,genesis.state_vector_v1,genesis.update_v1,crate::document::sha256(&genesis.update_v1),NOW],
            )?;
            let materialization = &genesis.materialization;
            let title = serde_json::to_string(&materialization.rich_title).unwrap();
            transaction.execute(
                "INSERT INTO document_materializations(document_id,generation,projected_seq,schema_version,title,title_rich_json,title_rich_hash,nfm,plain_text,preview,block_tree_json,updated_at)
                 VALUES (?1,1,0,3,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![DOCUMENT,materialization.title,title,crate::document::sha256(title.as_bytes()),materialization.markdown,
                    materialization.plain_text,materialization.preview,serde_json::to_string(&materialization.block_tree).unwrap(),NOW],
            )?;
            for (id, kind) in [("owned", "structural_edit"), ("unowned", "structural_edit"), ("capture", "structural_edit"), ("transfer", "block_transfer")] {
                transaction.execute(
                    "INSERT INTO change_log(project_id,store_epoch,kind,operation_id,payload_json,committed_at,projection_impact_json)
                     VALUES ('project:upgrade',?1,'library.changed',?2,'{}',?3,?4)",
                    params![epoch,id,NOW,super::super::projection_impact::encode(&nodex_core_contracts::ProjectionImpact::None)?],
                )?;
                let change_log_seq = transaction.last_insert_rowid();
                transaction.execute(
                    "INSERT INTO block_mutations(mutation_id,project_id,store_epoch,mutation_kind,request_hash,request_json,outcome,result_json,recorded_at,change_log_seq)
                     VALUES (?1,'project:upgrade',?2,?3,?4,'{}','committed','{}',?5,?6)",
                    params![id,epoch,kind,hash,NOW,change_log_seq],
                )?;
            }
            for id in ["owned", "unowned"] {
                transaction.execute(
                    "INSERT INTO structural_history_recipes(recipe_operation_id,library_id,project_id,store_epoch,recipe_hash,payload_ref_json,state,created_at)
                     VALUES (?1,?2,'project:upgrade',?3,?4,?5,'available',?6)",
                    params![id,library_id,epoch,hash,body,NOW],
                )?;
                transaction.execute(
                    "INSERT INTO structural_retention_members(authority_kind,authority_id,library_id,member_kind,member_id) VALUES ('history_recipe',?1,?2,'document',?3)",
                    params![id,library_id,DOCUMENT],
                )?;
            }
            for (id, state) in [("active-owner", "active"), ("closed-owner", "closed")] {
                transaction.execute(
                    "INSERT INTO editor_history_owners(owner_id,library_id,store_epoch,peer_pid,state) VALUES (?1,?2,?3,42,?4)",
                    params![id,library_id,epoch,state],
                )?;
                transaction.execute(
                    "INSERT INTO editor_history_local_sets(owner_id,surface_id,project_id,document_id,generation,revision,membership_hash,closed,retain_document)
                     VALUES (?1,'surface','project:upgrade',?2,1,1,'retained',0,1)",
                    params![id,DOCUMENT],
                )?;
                transaction.execute("INSERT INTO editor_history_local_roots VALUES (?1,'surface',?2)",params![id,PLACEHOLDER])?;
            }
            transaction.execute("INSERT INTO editor_history_recipes VALUES ('owned','active-owner')",[])?;
            transaction.execute("INSERT INTO editor_history_cleanup VALUES ('closed-owner')",[])?;
            transaction.execute("UPDATE structural_history_payload_backfill SET complete=0,after_recipe_operation_id=''",[])?;
            transaction.execute(
                "INSERT INTO structural_clipboard_bundles VALUES ('bundle','capture',?1,?2,?3,?3,'{}',?4)",
                params![library_id,epoch,hash,NOW],
            )?;
            transaction.execute("INSERT INTO structural_clipboard_leases VALUES ('bundle',1,'active',NULL,?1)",[NOW])?;
            transaction.execute(
                "INSERT INTO structural_cut_claims VALUES ('bundle',?1,?2,'unowned',1,'available',NULL,?3,?3)",
                params![DOCUMENT,serde_json::to_string(&[PLACEHOLDER]).unwrap(),NOW],
            )?;
            transaction.execute(
                "INSERT INTO block_transfer_undo_recipes VALUES ('transfer','project:upgrade',?1,?2,?3,?4,NULL,?5)",
                params![library_id,epoch,transfer_hash,transfer_body,NOW],
            )?;
            Ok(())
        }).unwrap();
        validate_migration_source(&connection, 174).expect("valid historical Profile");
        let mut failing_steps =
            resolve_migration_path(174, CURRENT_STORE_REVISION, MIGRATION_STEPS)
                .expect("supported predecessor path");
        failing_steps.last_mut().unwrap().apply =
            |_, _| Err(corrupt("injected failure after history epoch replacement"));
        let error = migrate_store(
            &mut connection,
            profile.path(),
            &mut |_| {},
            174,
            &failing_steps,
        )
        .expect_err("a later failure must roll back history publication and replacement");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert_eq!(
            error.message,
            "injected failure after history epoch replacement"
        );
        validate_schema_identity(&connection, 174).expect("source schema is unchanged");
        assert_eq!(
            connection
                .query_row("SELECT store_epoch FROM block_store_metadata", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            epoch
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM editor_history_owners", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM editor_history_local_roots",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(connection.query_row("SELECT count(*) FROM structural_history_recipes WHERE state='available' AND payload_ref_json=?1",[&body],|row|row.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_payloads",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_dormant_document_sources",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            !connection
                .query_row(
                    "SELECT complete FROM structural_history_payload_backfill",
                    [],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert_eq!(
            fs::read_dir(profile.path().join("backups/core-migrations"))
                .unwrap()
                .count(),
            1
        );
        drop(connection);

        let store = SqliteStoreKernel::open(profile.path()).expect("migrate historical Profile");
        assert_eq!(store.preparation().migrated_from_version, Some(174));
        store.readers().read_default(|connection| {
            let current: String = connection.query_row("SELECT store_epoch FROM block_store_metadata",[],|row|row.get(0))?;
            assert_ne!(current,epoch);
            for table in ["editor_history_owners", "editor_history_cleanup", "editor_history_recipes", "editor_history_local_sets", "editor_history_local_roots", "structural_retention_members", "structural_clipboard_bundles", "structural_clipboard_leases", "structural_cut_claims"] {
                assert_eq!(connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0))?,0,"{table} must not retain the old epoch");
            }
            assert_eq!(connection.query_row("SELECT count(*) FROM structural_history_recipes WHERE state='consumed'",[],|row|row.get::<_,i64>(0))?,2);
            for id in ["owned", "unowned"] {
                assert_eq!(connection.query_row("SELECT payload_chunk FROM structural_history_payloads WHERE recipe_operation_id=?1 AND part=0",[id],|row|row.get::<_,String>(0))?,body);
            }
            assert_eq!(connection.query_row("SELECT count(*) FROM structural_dormant_document_sources WHERE document_id=?1",[DOCUMENT],|row|row.get::<_,i64>(0))?,1);
            assert!(connection.query_row("SELECT consumed_at IS NOT NULL FROM block_transfer_undo_recipes WHERE transfer_operation_id='transfer'",[],|row|row.get::<_,bool>(0))?);
            Ok(())
        }).unwrap();
        let library = LibraryModule::new(profile_id, library_id, &store);
        let mut pending = true;
        for _ in 0..12 {
            pending = library
                .maintain_editor_history_owners(|_| true)
                .expect("maintenance succeeds after epoch replacement");
            if !pending {
                break;
            }
        }
        assert!(!pending, "maintenance converges after epoch replacement");
        store
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT snapshot_update FROM document_snapshots WHERE document_id=?1",
                        [DOCUMENT],
                        |row| row.get::<_, Vec<u8>>(0)
                    )?,
                    genesis.update_v1
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT title FROM document_materializations WHERE document_id=?1",
                        [DOCUMENT],
                        |row| row.get::<_, String>(0)
                    )?,
                    "Retained content"
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn v151_page_owned_file_migrates_to_library_identity_bytes_and_entry() {
        let directory = tempdir().expect("Profile");
        install_v151_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        validate_schema_identity(&connection, 151).expect("exact published v151 Store");

        let library_id = connection
            .query_row("SELECT id FROM libraries ORDER BY id LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("fixture Library");
        let source_epoch = connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("source epoch");
        let alpha = b"alpha";
        let beta = b"beta";
        let alpha_hash = hex::encode(Sha256::digest(alpha));
        let beta_hash = hex::encode(Sha256::digest(beta));
        let canvas_bytes = b"legacy-canvas-image";
        let canvas_hash = hex::encode(Sha256::digest(canvas_bytes));
        let canvas_name = "legacy-canvas.png";
        let canvas_uri = format!("nodex://assets/{canvas_name}");
        let canvas_file = json!({
            "id": "slot:legacy",
            "mimeType": "image/png",
            "source": canvas_uri.clone(),
            "created": 1
        });
        let canvas_file_json = crate::document::canonical_canvas_json(&canvas_file)
            .expect("canonical legacy Canvas File");
        let canvas_file_hash = hex::encode(Sha256::digest(canvas_file_json.as_bytes()));
        let mut canvas_bucket_hasher = Sha256::new();
        canvas_bucket_hasher.update(b"nodex.canvas.bucket-index.v1\0");
        canvas_bucket_hasher.update(b"file");
        canvas_bucket_hasher.update([0]);
        canvas_bucket_hasher.update(b"slot:legacy");
        let canvas_bucket_digest = canvas_bucket_hasher.finalize();
        let canvas_bucket =
            (u16::from_be_bytes([canvas_bucket_digest[0], canvas_bucket_digest[1]]) >> 6) & 0x03ff;
        let canvas_checkpoint = serde_json::to_vec(&json!({
            "kind": "canvas_scene",
            "schemaVersion": 1,
            "elements": [],
            "appState": {},
            "files": { "slot:legacy": canvas_file },
            "pageReferences": [],
            "plainText": "",
            "preview": ""
        }))
        .expect("legacy Canvas checkpoint");
        let canvas_checkpoint_hash = hex::encode(Sha256::digest(&canvas_checkpoint));

        let queued_asset = b"queued-attachment";
        let queued_asset_hash = hex::encode(Sha256::digest(queued_asset));
        let queued_asset_uri = "nodex://assets/legacy-queued.txt";
        let queued_manifest = serde_json::to_vec(&json!({
            "schema_version": 1,
            "payload": {
                "prompt": "inspect attachment",
                "prompt_input": { "attachment": queued_asset_uri }
            }
        }))
        .expect("legacy queued manifest");
        let queued_manifest_hash = hex::encode(Sha256::digest(&queued_manifest));
        let queued_manifest_name = "queued-follow-up-v1-migration.json";
        let genesis = crate::document::prepare_page_yjs_genesis(
            "document:file-migration",
            "",
            "01890f44-7f00-7000-8000-000000000010",
        )
        .expect("Page genesis");
        fs::create_dir_all(directory.path().join("assets")).expect("asset directory");
        fs::write(directory.path().join("assets/legacy-alpha.txt"), alpha).expect("alpha bytes");
        fs::write(directory.path().join("assets/legacy-beta.txt"), beta).expect("beta bytes");
        fs::write(
            directory.path().join("assets").join(canvas_name),
            canvas_bytes,
        )
        .expect("Canvas bytes");
        fs::write(
            directory.path().join("assets/legacy-queued.txt"),
            queued_asset,
        )
        .expect("queued attachment bytes");
        fs::write(
            directory.path().join("assets").join(queued_manifest_name),
            &queued_manifest,
        )
        .expect("queued manifest bytes");

        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("fixture maintenance writes");

        with_immediate_transaction(&mut connection, |transaction| {
            transaction.execute(
                "INSERT INTO projects( \
                   id, name, description, created, updated, library_id, lifecycle, binding_revision \
                 ) VALUES ('project:file-migration', 'Files', '', \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', ?1, 'active', 1), \
                          ('project:file-outsider', 'Outsider', '', \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', ?1, 'active', 1)",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO blocks( \
                   id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                   created_at, updated_at \
                 ) VALUES ('page:file-migration', ?1, 'page', 'active', 1, 1, \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO documents( \
                   id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
                   state_hash, readiness, authority, created_at, updated_at, sync_engine \
                 ) VALUES ('document:file-migration', ?1, 1, 0, 'nodex.page', 3, X'', '', \
                   'pending_genesis', 'legacy_shadow', '2026-09-05T00:00:00.000Z', \
                   '2026-09-05T00:00:00.000Z', 'yjs')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                 VALUES ('page:file-migration', 'document:file-migration', ?1, \
                   '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO pages( \
                   block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
                 ) VALUES ('page:file-migration', ?1, 'document:file-migration', \
                   'library', ?1, '2026-09-05T00:00:00.000Z', \
                   '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO library_block_placements( \
                   library_id, block_id, rank_key, created_at, updated_at \
                 ) VALUES (?1, 'page:file-migration', 'a0', \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            let authority = crate::document::read_document_authority(
                transaction,
                "document:file-migration",
            )?
            .ok_or_else(|| corrupt("Fixture Page authority is unavailable"))?;
            let full_state = genesis.engine.full_state_v1();
            crate::document::persist_yjs_genesis(
                transaction,
                crate::document::PersistYjsGenesis {

                    authority: &authority,
                    actor_project_id: Some("project:file-migration"),
                    materialization: &genesis.materialization,
                    update_id: "update:file-migration-genesis",
                    client_session_id: "migration-fixture",
                    update: &genesis.update_v1,
                    state_vector: &genesis.state_vector_v1,
                    full_state: &full_state,
                    store_epoch: &source_epoch,
                    operation_id: "operation:file-migration-genesis",
                    placement: crate::document::DocumentPlacementEvidence::STRUCTURAL,
                    emit_event: false,
                },
            )
            .map_err(|error| StoreError {
                message: format!("Fixture genesis failed: {}", error.message),
                ..error
            })?;
            transaction.execute(
                "INSERT INTO page_read_model( \
                   page_block_id, library_id, lifecycle, parent_kind, parent_id, library_rank_key, \
                   placement_revision, metadata_revision, document_id, document_generation, \
                   document_projected_seq, document_schema_version, document_authority, title, \
                   description_preview, description_length, has_description, created_at, updated_at \
                 ) VALUES ('page:file-migration', ?1, 'active', 'library', ?1, 'a0', 1, 1, \
                   'document:file-migration', 1, 1, 3, 'ydoc_primary', ?2, ?3, ?4, ?5, \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
                params![
                    library_id,
                    genesis.materialization.title,
                    genesis.materialization.preview,
                    genesis.materialization.markdown.len() as i64,
                    i64::from(!genesis.materialization.markdown.trim().is_empty())
                ],
            )?;
            transaction.execute(
                "INSERT INTO project_resource_grants( \
                   id, project_id, library_id, root_kind, root_id, access, recursive, revision, \
                   lifecycle, created_at, updated_at \
                 ) VALUES ('grant:file-owner-page', 'project:file-migration', ?1, 'page', \
                   'page:file-migration', 'read_write', 1, 1, 'active', \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO managed_blobs( \
                   content_hash, physical_asset_name, byte_length, created_at \
                 ) VALUES (?1, 'legacy-alpha.txt', ?2, '2026-09-05T00:00:00.000Z'), \
                          (?3, 'legacy-beta.txt', ?4, '2026-09-05T00:00:00.000Z')",
                params![
                    alpha_hash,
                    alpha.len() as i64,
                    beta_hash,
                    beta.len() as i64
                ],
            )?;
            transaction.execute(
                "UPDATE page_file_manifests SET revision = 1, \
                   updated_at = '2026-09-05T00:00:01.000Z' \
                 WHERE page_id = 'page:file-migration'",
                [],
            )?;
            transaction.execute(
                "INSERT INTO page_file_versions( \
                   file_id, version, library_id, owner_page_id, manifest_revision, change_kind, \
                   logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, operation_id, \
                   occurred_at \
                 ) VALUES ('file:migrated', 1, ?1, 'page:file-migration', 1, 'create', \
                   'reports/report.txt', 'reports/report.txt', 'text/plain', ?2, ?3, \
                   'actor:file-migration', 'operation:file-v1', '2026-09-05T00:00:01.000Z')",
                params![library_id, alpha_hash, alpha.len() as i64],
            )?;
            transaction.execute(
                "UPDATE page_file_manifests SET revision = 2, \
                   updated_at = '2026-09-05T00:00:02.000Z' \
                 WHERE page_id = 'page:file-migration'",
                [],
            )?;
            transaction.execute(
                "INSERT INTO page_file_versions( \
                   file_id, version, library_id, owner_page_id, manifest_revision, change_kind, \
                   logical_path, path_key, mime_type, blob_hash, byte_length, actor_id, operation_id, \
                   occurred_at \
                 ) VALUES ('file:migrated', 2, ?1, 'page:file-migration', 2, 'replace', \
                   'reports/report.txt', 'reports/report.txt', 'text/plain', ?2, ?3, \
                   'actor:file-migration', 'operation:file-v2', '2026-09-05T00:00:02.000Z')",
                params![library_id, beta_hash, beta.len() as i64],
            )?;
            transaction.execute(
                "INSERT INTO page_file_namespace(owner_page_id, library_id, path_key, file_id) \
                 VALUES ('page:file-migration', ?1, 'reports/report.txt', 'file:migrated')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO page_files( \
                   file_id, library_id, owner_page_id, logical_path, path_key, mime_type, \
                   byte_length, current_version, state, created_by_actor_id, created_at, updated_at \
                 ) VALUES ('file:migrated', ?1, 'page:file-migration', 'reports/report.txt', \
                   'reports/report.txt', 'text/plain', ?2, 2, 'live', \
                   'actor:file-migration', '2026-09-05T00:00:01.000Z', \
                   '2026-09-05T00:00:02.000Z')",
                params![library_id, beta.len() as i64],
            )?;
            transaction.execute(
                "INSERT INTO blocks( \
                   id, library_id, type, lifecycle, placement_revision, metadata_revision, \
                   created_at, updated_at \
                 ) VALUES ('canvas:file-migration', ?1, 'canvas', 'active', 1, 1, \
                   '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO documents( \
                   id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
                   state_hash, readiness, authority, created_at, updated_at, sync_engine \
                 ) VALUES ('document:canvas-migration', ?1, 1, 0, 'nodex.canvas', 1, X'', ?2, \
                   'ready', 'ydoc_primary', '2026-09-05T00:00:00.000Z', \
                   '2026-09-05T00:00:00.000Z', 'canvas_scene')",
                params![library_id, "0".repeat(64)],
            )?;
            transaction.execute(
                "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                 VALUES ('canvas:file-migration', 'document:canvas-migration', ?1, \
                   '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO canvas_owners(block_id, library_id, created_at, updated_at) \
                 VALUES ('canvas:file-migration', ?1, '2026-09-05T00:00:00.000Z', \
                   '2026-09-05T00:00:00.000Z')",
                [&library_id],
            )?;
            transaction.execute(
                "INSERT INTO canvas_scenes( \
                   document_id, generation, head_seq, schema_version, scene_hash_version, \
                   app_state_json, app_state_hash, scene_hash, element_count, tombstone_count, \
                   file_count, element_json_bytes, file_json_bytes, scene_byte_length, updated_at \
                 ) VALUES ('document:canvas-migration', 1, 0, 1, 2, '{}', ?1, ?1, 0, 0, 1, \
                   0, ?2, ?2, '2026-09-05T00:00:00.000Z')",
                params![hex::encode(Sha256::digest(b"{}")), canvas_file_json.len() as i64],
            )?;
            transaction.execute(
                "INSERT INTO canvas_scene_files( \
                   document_id, file_id, mime_type, asset_uri, created_ms, file_json, file_hash, \
                   hash_bucket, updated_at \
                 ) VALUES ('document:canvas-migration', 'slot:legacy', 'image/png', ?1, 1, ?2, \
                   ?3, ?4, '2026-09-05T00:00:00.000Z')",
                params![canvas_uri, canvas_file_json, canvas_file_hash, i64::from(canvas_bucket)],
            )?;
            transaction.execute(
                "INSERT INTO canvas_scene_file_refs( \
                   document_id, file_id, owner_block_id, library_id, document_generation, \
                   projected_seq, mime_type, asset_uri, managed_file_name, asset_hash, \
                   byte_length, updated_at \
                 ) VALUES ('document:canvas-migration', 'slot:legacy', 'canvas:file-migration', \
                   ?1, 1, 0, 'image/png', ?2, ?3, ?4, ?5, '2026-09-05T00:00:00.000Z')",
                params![
                    library_id,
                    canvas_uri,
                    canvas_name,
                    canvas_hash,
                    canvas_bytes.len() as i64
                ],
            )?;
            transaction.execute(
                "INSERT INTO document_versions( \
                   version_id, document_id, project_id, generation, base_head_seq, schema_key, \
                   schema_version, cause, actor_json, revision_kind, pinned, checkpoint_format, \
                   full_update_blob, state_vector, checkpoint_hash, byte_length, created_at \
                 ) VALUES ('version:canvas-legacy', 'document:canvas-migration', \
                   'project:file-migration', 1, 0, 'nodex.canvas', 1, 'manual', '{}', 'manual', 1, \
                   'canvas_scene_json_v1', ?1, X'', ?2, ?3, '2026-09-05T00:00:00.000Z')",
                params![
                    canvas_checkpoint,
                    canvas_checkpoint_hash,
                    canvas_checkpoint.len() as i64
                ],
            )?;
            transaction.execute(
                "INSERT INTO document_version_retention_index( \
                   version_id, checkpoint_hash, member_count, indexed_at \
                 ) VALUES ('version:canvas-legacy', ?1, 0, '2026-09-05T00:00:00.000Z')",
                [&canvas_checkpoint_hash],
            )?;

            transaction.execute(
                "INSERT INTO codex_threads( \
                   thread_id, project_id, created_at, updated_at, recency_at, linked_at \
                 ) VALUES ('thread:file-migration', 'project:file-migration', 1, 1, 1, \
                   '2026-09-05T00:00:00.000Z')",
                [],
            )?;
            transaction.execute(
                "INSERT INTO codex_queued_follow_up_ledgers(thread_id, revision, ledger_hash, updated_at) \
                 VALUES ('thread:file-migration', 1, ?1, '2026-09-05T00:00:00.000Z')",
                ["0".repeat(64)],
            )?;
            transaction.execute(
                "INSERT INTO codex_queued_follow_up_payload_manifests( \
                   payload_sha256, schema_version, asset_uri, byte_length \
                 ) VALUES (?1, 1, ?2, ?3)",
                params![
                    queued_manifest_hash,
                    format!("nodex://assets/{queued_manifest_name}"),
                    queued_manifest.len() as i64
                ],
            )?;
            transaction.execute(
                "INSERT INTO codex_queued_follow_up_payload_asset_refs( \
                   payload_sha256, ordinal, asset_uri, sha256, byte_length \
                 ) VALUES (?1, 0, ?2, ?3, ?4)",
                params![
                    queued_manifest_hash,
                    queued_asset_uri,
                    queued_asset_hash,
                    queued_asset.len() as i64
                ],
            )?;
            transaction.execute(
                "INSERT INTO codex_queued_follow_up_entries( \
                   thread_id, follow_up_id, position, client_user_message_id, created_at_ms, \
                   payload_sha256 \
                 ) VALUES ('thread:file-migration', 'follow-up:migration', 0, \
                   'message:migration', 1, ?1)",
                [&queued_manifest_hash],
            )?;
            Ok(())
        })
        .expect("seed valid v151 Page File");
        connection.execute_batch(
            "INSERT INTO blocks SELECT 'canvas:empty-migration', library_id, type, lifecycle,
               placement_revision, metadata_revision, created_at, updated_at
             FROM blocks WHERE id = 'canvas:file-migration';
             INSERT INTO documents(id, library_id, generation, head_seq, schema_key, schema_version,
               state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine)
             SELECT 'document:empty-canvas', library_id, generation, head_seq, schema_key, schema_version,
               state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine
             FROM documents WHERE id = 'document:canvas-migration';
             INSERT INTO block_documents SELECT 'canvas:empty-migration', 'document:empty-canvas',
               library_id, created_at FROM block_documents WHERE block_id = 'canvas:file-migration';
             INSERT INTO canvas_owners SELECT 'canvas:empty-migration', library_id, created_at, updated_at
               FROM canvas_owners WHERE block_id = 'canvas:file-migration';
             INSERT INTO canvas_scenes(document_id, generation, head_seq, schema_version, scene_hash_version,
               app_state_json, app_state_hash, scene_hash, element_count, tombstone_count, file_count,
               element_json_bytes, file_json_bytes, scene_byte_length, updated_at) SELECT 'document:empty-canvas', generation, head_seq, schema_version,
               scene_hash_version, app_state_json, app_state_hash, scene_hash, 0, 0, 0, 0, 0, 0, updated_at
               FROM canvas_scenes WHERE document_id = 'document:canvas-migration';"
        ).expect("empty Canvas migration fixture");
        // Retired Page capabilities leave ready Documents for retained history.
        connection.execute(
            "INSERT INTO documents(id, library_id, generation, head_seq, schema_key, schema_version, \
               state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine) \
             SELECT 'document:detached-migration', library_id, generation, head_seq, schema_key, \
               schema_version, state_vector, state_hash, readiness, authority, created_at, updated_at, \
               sync_engine FROM documents WHERE id = 'document:file-migration'",
            [],
        ).expect("retained detached Document");
        connection.execute(
            "INSERT INTO document_snapshots SELECT 'document:detached-migration', generation, \
               snapshot_seq, state_vector, snapshot_update, snapshot_hash, schema_version, created_at \
             FROM document_snapshots WHERE document_id = 'document:file-migration'",
            [],
        ).expect("retained detached snapshot");
        connection.execute(
            "INSERT INTO document_materializations \
             SELECT 'document:detached-migration', generation, projected_seq, schema_version, title, \
               title_rich_json, title_rich_hash, nfm, plain_text, preview, block_tree_json, \
               references_json, asset_refs_json, updated_at, materialization_derivation_version \
             FROM document_materializations WHERE document_id = 'document:file-migration'",
            [],
        ).expect("retained detached materialization");
        connection
            .execute("DELETE FROM local_commit_visibility_context", [])
            .expect("finish fixture maintenance writes");
        super::derivation_tests::rewrite_as_predecessor(&connection, 151);
        validate_migration_source(&connection, 151).expect("valid v151 File source");
        let block_ownership = |connection: &Connection| {
            connection
                .prepare("SELECT block_id,document_id FROM document_block_index ORDER BY block_id")
                .unwrap()
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let predecessor_ownership = block_ownership(&connection);
        assert!(!predecessor_ownership.is_empty());

        let preparation = prepare_profile_store(&mut connection, directory.path())
            .expect("migrate v151 Page File");
        assert_eq!(preparation.migrated_from_version, Some(151));
        validate_current_store(&connection).expect("valid current File Store");
        assert_eq!(
            block_ownership(&connection),
            predecessor_ownership,
            "Retained unowned Documents must not claim the live owner's Block index"
        );

        let empty_canvas_version: i64 = connection
            .query_row(
                "SELECT schema_version FROM documents WHERE id = 'document:empty-canvas'",
                [],
                |row| row.get(0),
            )
            .expect("empty Canvas schema");
        assert_eq!(empty_canvas_version, 2);

        let detached: (i64, i64) = connection.query_row(
            "SELECT (SELECT count(*) FROM documents WHERE id = 'document:detached-migration'), \
               (SELECT count(*) FROM document_versions WHERE document_id = 'document:detached-migration')",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("detached Document retained without a new current checkpoint");
        assert_eq!(detached, (1, 0));
        let snapshots: i64 = connection.query_row(
            "SELECT count(*) FROM document_snapshots WHERE document_id = 'document:detached-migration'",
            [], |row| row.get(0),
        ).expect("retained snapshot");
        assert!(snapshots > 0);

        assert_eq!(
            connection
                .query_row(
                    "SELECT library_id, default_name, head_version, revision, lifecycle \
                     FROM library_files WHERE file_id = 'file:migrated'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .expect("migrated File"),
            (
                library_id.clone(),
                "report.txt".to_owned(),
                2,
                2,
                "live".to_owned()
            )
        );
        assert_eq!(
            connection
                .prepare(
                    "SELECT version, blob_hash FROM file_versions \
                     WHERE file_id = 'file:migrated' ORDER BY version",
                )
                .expect("File version query")
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .expect("File version rows")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("File versions"),
            vec![(1, alpha_hash.clone()), (2, beta_hash.clone())]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT logical_path FROM page_file_entries \
                     WHERE page_id = 'page:file-migration' AND file_id = 'file:migrated'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("migrated Page path"),
            "reports/report.txt"
        );
        for (hash, expected) in [
            (&alpha_hash, alpha.as_slice()),
            (&beta_hash, beta.as_slice()),
        ] {
            let physical_name = connection
                .query_row(
                    "SELECT physical_asset_name FROM managed_blobs WHERE content_hash = ?1",
                    [hash],
                    |row| row.get::<_, String>(0),
                )
                .expect("managed Blob");
            assert_eq!(physical_name, format!("{hash}.blob"));
            assert_eq!(
                fs::read(directory.path().join("assets").join(physical_name))
                    .expect("migrated Blob bytes"),
                expected
            );
        }
        assert_ne!(
            connection
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("migrated epoch"),
            source_epoch
        );
        for table in ["page_files", "page_file_versions", "page_file_namespace"] {
            assert!(
                connection
                    .query_row(
                        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                        [table],
                        |_| Ok(()),
                    )
                    .optional()
                    .expect("legacy table lookup")
                    .is_none(),
                "legacy table {table} remains"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT json_extract(evidence_json, '$.libraryFiles') \
                     FROM core_store_migration_history WHERE source_revision = 151",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("migration evidence"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT json_extract(evidence_json, '$.retainedLegacyBlobSources') \
                     FROM core_store_migration_history WHERE source_revision = 151",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("retained legacy Blob evidence"),
            5
        );
        for (name, expected) in [
            ("legacy-alpha.txt", alpha.as_slice()),
            ("legacy-beta.txt", beta.as_slice()),
            (canvas_name, canvas_bytes.as_slice()),
            ("legacy-queued.txt", queued_asset.as_slice()),
            (queued_manifest_name, queued_manifest.as_slice()),
        ] {
            assert_eq!(
                fs::read(directory.path().join("assets").join(name))
                    .expect("retained rollback Blob source"),
                expected
            );
        }
        let migrated_canvas_file = connection
            .query_row(
                "SELECT scene.schema_version, reference.target_file_id, reference.file_version, \
                        reference.default_name, version.checkpoint_format, version.schema_version \
                 FROM canvas_scenes scene \
                 JOIN canvas_scene_file_refs reference ON reference.document_id = scene.document_id \
                 JOIN document_versions version ON version.version_id = 'version:canvas-legacy' \
                 WHERE scene.document_id = 'document:canvas-migration' \
                   AND reference.file_id = 'slot:legacy'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .expect("migrated current and historical Canvas File");
        assert_eq!(migrated_canvas_file.0, 2);
        assert_eq!(migrated_canvas_file.2, 1);
        assert_eq!(migrated_canvas_file.4, "canvas_scene_json_v2");
        assert_eq!(migrated_canvas_file.5, 2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT file_id, file_version, default_name FROM document_version_file_refs \
                     WHERE version_id = 'version:canvas-legacy' \
                       AND binding_kind = 'canvas' AND binding_id = 'slot:legacy'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .expect("migrated Canvas history binding"),
            (
                migrated_canvas_file.1.clone(),
                1,
                migrated_canvas_file.3.clone()
            )
        );
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join("assets")
                    .join(format!("{canvas_hash}.blob")),
            )
            .expect("migrated Canvas bytes"),
            canvas_bytes
        );

        let stable_counts = connection
            .query_row(
                "SELECT \
                   (SELECT count(*) FROM library_files), \
                   (SELECT count(*) FROM file_versions), \
                   (SELECT count(*) FROM page_file_entries), \
                   (SELECT count(*) FROM core_store_migration_history)",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("post-migration counts");
        drop(connection);

        let mut reopened = open_writer(&directory.path().join("nodex.db")).expect("reopen writer");
        let reopened_preparation =
            prepare_profile_store(&mut reopened, directory.path()).expect("reopen migrated Store");
        assert_eq!(reopened_preparation.migrated_from_version, None);
        validate_current_store(&reopened).expect("valid reopened current Store");
        assert_eq!(
            reopened
                .query_row(
                    "SELECT \
                       (SELECT count(*) FROM library_files), \
                       (SELECT count(*) FROM file_versions), \
                       (SELECT count(*) FROM page_file_entries), \
                           (SELECT count(*) FROM core_store_migration_history)",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .expect("reopened counts"),
            stable_counts
        );
    }

    #[test]
    fn complete_order_migration_preserves_sparse_positions_without_materializing_members() {
        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 152);
        let database_path = profile.path().join("nodex.db");
        let mut connection = open_writer(&database_path).expect("predecessor");
        // Storage-shape fixture: only the coordinates read by this metadata migration matter.
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .unwrap();
        let membership_guard: String = connection.query_row(
            "SELECT sql FROM sqlite_schema WHERE name = 'data_source_memberships_require_page_parent_insert'",
            [], |row| row.get(0),
        ).unwrap();
        connection
            .execute_batch("DROP TRIGGER data_source_memberships_require_page_parent_insert")
            .unwrap();
        connection.execute_batch(
            "INSERT INTO database_views(id, database_block_id, data_source_id, name, layout, rank_key, created_at, updated_at) \
             VALUES ('order-view', 'database', 'source', 'Order', 'list', 'a', 'created', 'updated'); \
             INSERT INTO data_source_page_memberships(id, data_source_id, page_block_id, created_at) \
             VALUES ('membership', 'source', 'page', 'created'); \
             INSERT INTO database_view_page_positions(view_id, page_block_id, rank_key, revision, created_at, updated_at) \
             VALUES ('order-view', 'page', 'legacy-rank', 7, 'created', 'updated');"
        ).expect("sparse predecessor");
        connection
            .execute_batch(&membership_guard)
            .expect("restore predecessor guard");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v152_to_v159(
                transaction,
                &MigrationContext {
                    source_revision: 152,
                    target_revision: 159,
                    backup_name: "complete-order-fixture".into(),
                    source_schema_fingerprint: published_format(152)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(159)?.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("metadata migration");
        validate_schema_identity(&connection, 159).expect("published schema");
        let state: (Option<i64>, i64, String, i64) = connection.query_row(
            "SELECT active_generation, pending_generation, phase, semantic_reset_epoch FROM database_view_order_state WHERE view_id = 'order-view'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(state, (None, 1, "explicit".into(), 1));
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM database_view_order_rows", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert!(
            connection
                .execute(
                    "UPDATE database_view_page_positions SET rank_key = 'changed'",
                    []
                )
                .is_err()
        );
        drop(connection);
        let reopened = open_writer(&database_path).expect("reopen migrated storage");
        validate_schema_identity(&reopened, 159).expect("reopened schema identity");
        let retained: (String, i64, String, String) = reopened.query_row(
            "SELECT rank_key, revision, created_at, updated_at FROM database_view_page_positions WHERE view_id = 'order-view' AND page_block_id = 'page'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(
            retained,
            ("legacy-rank".into(), 7, "created".into(), "updated".into())
        );
        assert_eq!(reopened.query_row("SELECT count(*) FROM core_store_migration_history WHERE source_revision = 152 AND target_revision = 159", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn complete_order_predecessor_reopens_without_repeating_migration() {
        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 152);
        let database_path = profile.path().join("nodex.db");
        let mut connection = open_writer(&database_path).expect("predecessor");
        let migrated =
            prepare_profile_store(&mut connection, profile.path()).expect("migrate predecessor");
        assert_eq!(migrated.migrated_from_version, Some(152));
        validate_current_store(&connection).expect("valid current Store");
        drop(connection);
        let mut reopened = open_writer(&database_path).expect("reopen");
        let preparation =
            prepare_profile_store(&mut reopened, profile.path()).expect("reopen Profile");
        assert_eq!(preparation.migrated_from_version, None);
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        validate_current_store(&reopened).expect("valid reopened Store");
    }

    #[test]
    fn ledger_body_migration_preserves_inline_evidence_for_resumable_collection() {
        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 152);
        let mut connection = open_writer(&profile.path().join("nodex.db")).expect("predecessor");
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection.execute("INSERT OR IGNORE INTO block_store_metadata VALUES (1, 'epoch', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        let epoch: String = connection
            .query_row("SELECT store_epoch FROM block_store_metadata", [], |row| {
                row.get(0)
            })
            .unwrap();
        let body = serde_json::json!({ "body": "正文".repeat(100_000) }).to_string();
        connection.execute(
            "INSERT INTO block_mutations(mutation_id, project_id, store_epoch, mutation_kind, request_hash, request_json, outcome, result_json, recorded_at) \
             VALUES ('legacy-ledger', 'project', ?1, 'block_transfer', ?2, ?3, 'rejected', ?3, '2026-01-01T00:00:00Z')",
            params![epoch, crate::document::sha256(body.as_bytes()), body],
        ).unwrap();
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v152_to_v159(
                transaction,
                &MigrationContext {
                    source_revision: 152,
                    target_revision: 159,
                    backup_name: "fixture".into(),
                    source_schema_fingerprint: published_format(152)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(159)?.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("metadata-only migration");
        validate_schema_identity(&connection, 159).expect("published schema");
        let retained: (String, String) = connection.query_row("SELECT request_json, result_json FROM block_mutations WHERE mutation_id = 'legacy-ledger'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(retained, (body.clone(), body));
        assert!(
            !connection
                .query_row(
                    "SELECT complete FROM block_mutation_body_backfill",
                    [],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM block_mutation_body_gc", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn history_payload_migration_keeps_bodies_inline_until_resumable_maintenance() {
        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 152);
        let mut connection = open_writer(&profile.path().join("nodex.db")).expect("predecessor");
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("historical storage fixture");
        let body =
            serde_json::json!({"action": {"kind": "fixture"}, "content": "正文".repeat(100_000)})
                .to_string();
        let hash = crate::document::sha256(body.as_bytes());
        connection.execute(
            "INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, recipe_json, state, created_at) \
             VALUES ('migration-payload', 'library', 'project', 'epoch', ?1, ?2, 'available', '2026-01-01T00:00:00Z')",
            params![hash, body],
        ).expect("inline source");
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v152_to_v159(
                transaction,
                &MigrationContext {
                    source_revision: 152,
                    target_revision: 159,
                    backup_name: "fixture".into(),
                    source_schema_fingerprint: published_format(152)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(159)?.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("metadata-only migration");
        validate_schema_identity(&connection, 159).expect("published schema");
        let unchanged: (String, String) = connection.query_row(
            "SELECT recipe_hash, payload_ref_json FROM structural_history_recipes WHERE recipe_operation_id = 'migration-payload'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(unchanged, (hash, body));
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_payloads",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            !connection
                .query_row(
                    "SELECT complete FROM structural_history_payload_backfill",
                    [],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap()
        );
    }

    #[test]
    fn unpublished_source_is_rejected_without_backup_or_mutation() {
        let directory = tempdir().expect("Profile");
        install_intermediate_fixture(directory.path(), 152);
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        connection
            .pragma_update(None, "user_version", 153)
            .expect("unpublished revision");
        let inventory =
            crate::infrastructure::schema::read_schema_inventory(&connection).expect("inventory");
        let secrets = profile_secrets(&connection);
        let mut events = Vec::new();
        let error =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect_err("unpublished Store must be rejected");
        assert_eq!(error.code, StoreErrorCode::UnsupportedSchema);
        assert!(events.is_empty());
        assert!(!directory.path().join("backups").exists());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            153
        );
        assert_eq!(
            crate::infrastructure::schema::read_schema_inventory(&connection)
                .expect("unchanged inventory"),
            inventory
        );
        assert_eq!(profile_secrets(&connection), secrets);
    }

    #[test]
    fn unsupported_or_drifted_source_fails_before_backup() {
        let unsupported = tempdir().expect("unsupported Profile");
        install_baseline_fixture(unsupported.path());
        let mut connection = open_writer(&unsupported.path().join("nodex.db")).expect("writer");
        connection
            .pragma_update(None, "user_version", 129)
            .expect("unsupported revision");
        let error = prepare_profile_store(&mut connection, unsupported.path())
            .expect_err("v129 must be rejected");
        assert_eq!(error.code, StoreErrorCode::UnsupportedSchema);
        assert!(!unsupported.path().join("backups").exists());

        let drifted = tempdir().expect("drifted Profile");
        install_baseline_fixture(drifted.path());
        let mut connection = open_writer(&drifted.path().join("nodex.db")).expect("writer");
        connection
            .execute("CREATE TABLE unexpected_drift(id INTEGER PRIMARY KEY)", [])
            .expect("drift schema");
        let error = prepare_profile_store(&mut connection, drifted.path())
            .expect_err("drifted v130 must be rejected");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert!(!drifted.path().join("backups").exists());

        let future = tempdir().expect("future Profile");
        install_baseline_fixture(future.path());
        let mut connection = open_writer(&future.path().join("nodex.db")).expect("writer");
        connection
            .pragma_update(None, "user_version", CURRENT_STORE_REVISION + 1)
            .expect("future revision");
        let error = prepare_profile_store(&mut connection, future.path())
            .expect_err("future Store must be rejected");
        assert_eq!(error.code, StoreErrorCode::UnsupportedSchema);
        assert!(!future.path().join("backups").exists());

        let nonempty_v0 = tempdir().expect("nonempty v0 Profile");
        let mut connection = open_writer(&nonempty_v0.path().join("nodex.db")).expect("writer");
        connection
            .execute("CREATE TABLE unexpected_application_object(id INTEGER)", [])
            .expect("application object");
        let error = prepare_profile_store(&mut connection, nonempty_v0.path())
            .expect_err("nonempty v0 Store must be rejected");
        assert_eq!(error.code, StoreErrorCode::UnsupportedSchema);
        assert!(!nonempty_v0.path().join("backups").exists());

        let current_drift = tempdir().expect("current drift Profile");
        let mut connection = open_writer(&current_drift.path().join("nodex.db")).expect("writer");
        prepare_profile_store(&mut connection, current_drift.path()).expect("current Store");
        connection
            .execute("CREATE TABLE unexpected_current_drift(id INTEGER)", [])
            .expect("current drift");
        let error = prepare_profile_store(&mut connection, current_drift.path())
            .expect_err("drifted current Store must be rejected");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn semantically_invalid_baseline_fails_after_bounded_migration_preparation_signal() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        connection
            .execute("UPDATE profiles SET created_at = 'not-a-timestamp'", [])
            .expect("corrupt timestamp semantics");
        let mut events = Vec::new();
        let error =
            prepare_profile_store_with_observer(&mut connection, directory.path(), &mut |event| {
                events.push(event)
            })
            .expect_err("invalid baseline semantics");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert!(
            events
                .iter()
                .all(|event| matches!(event, StorePreparationEvent::MigrationStarted { .. }))
        );
        assert!(!events.is_empty());
        assert!(!directory.path().join("backups").exists());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("source version"),
            BASELINE_STORE_REVISION
        );
    }

    #[test]
    fn invalid_baseline_document_fails_before_backup() {
        const NOW: &str = "2026-08-20T00:00:00.000Z";

        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
            &connection,
        )
        .expect("maintenance context");
        let library_id = connection
            .query_row("SELECT id FROM libraries LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .expect("baseline Library");
        connection
            .execute(
                "INSERT INTO documents(\
                   id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
                   state_hash, readiness, authority, created_at, updated_at, sync_engine\
                 ) VALUES ('document:incomplete', ?1, 1, 0, 'nodex.page', 2, X'', '', \
                   'ready', 'ydoc_primary', ?2, ?2, 'yjs')",
                params![library_id, NOW],
            )
            .expect("incomplete Document");

        let error = prepare_profile_store(&mut connection, directory.path())
            .expect_err("Document without materialization");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert!(!directory.path().join("backups").exists());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("source version"),
            BASELINE_STORE_REVISION
        );
    }

    #[test]
    fn migrated_store_is_validated_before_transaction_commit() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let error = migrate_baseline_store(
            &mut connection,
            directory.path(),
            &mut |_| {},
            MigrationStep {
                from_revision: BASELINE_STORE_REVISION,
                to_revision: CURRENT_STORE_REVISION,
                apply: |connection, context| {
                    migrate_v130_to_v131(connection, context)?;
                    connection.execute(
                        "UPDATE core_store_metadata SET projection_event_v2_floor = 999",
                        [],
                    )?;
                    Ok(())
                },
            },
        )
        .expect_err("invalid migrated Store");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("rolled-back version"),
            BASELINE_STORE_REVISION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema \
                     WHERE name = 'core_store_migration_history'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled-back history table"),
            0
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .expect("preserved backup")
                .count(),
            1
        );
    }

    #[test]
    fn failed_migration_rolls_back_after_preserving_backup() {
        let directory = tempdir().expect("Profile");
        install_baseline_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        let error = migrate_baseline_store(
            &mut connection,
            directory.path(),
            &mut |_| {},
            MigrationStep {
                from_revision: BASELINE_STORE_REVISION,
                to_revision: CURRENT_STORE_REVISION,
                apply: |connection, _| {
                    connection.pragma_update(None, "legacy_alter_table", true)?;
                    connection.execute("CREATE TABLE should_roll_back(id INTEGER)", [])?;
                    Err(corrupt("injected migration failure"))
                },
            },
        )
        .expect_err("migration failure");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version"),
            130
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name = 'should_roll_back'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled-back object"),
            0
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .expect("backup")
                .count(),
            1
        );
        assert!(
            !connection
                .query_row("PRAGMA legacy_alter_table", [], |row| row.get::<_, bool>(0))
                .expect("restored legacy_alter_table")
        );
    }

    #[cfg(unix)]
    #[test]
    fn migration_backup_path_rejects_symlinks_and_non_files() {
        let symlinked = tempdir().expect("Profile");
        let outside = tempdir().expect("outside directory");
        install_baseline_fixture(symlinked.path());
        symlink(outside.path(), symlinked.path().join("backups")).expect("symlinked backups");
        let mut connection = open_writer(&symlinked.path().join("nodex.db")).expect("writer");
        let error = prepare_profile_store(&mut connection, symlinked.path())
            .expect_err("symlinked backup ancestry must fail");
        assert_eq!(error.code, StoreErrorCode::InvalidProfile);
        assert_eq!(fs::read_dir(outside.path()).expect("outside").count(), 0);

        let non_file = tempdir().expect("Profile");
        install_baseline_fixture(non_file.path());
        let backup_directory = non_file.path().join("backups/core-migrations");
        fs::create_dir_all(&backup_directory).expect("backup directory");
        fs::create_dir(
            backup_directory.join(format!(".v130-to-v{CURRENT_STORE_REVISION}.pending.db")),
        )
        .expect("non-file pending candidate");
        let mut connection = open_writer(&non_file.path().join("nodex.db")).expect("writer");
        let error = prepare_profile_store(&mut connection, non_file.path())
            .expect_err("non-file pending backup must fail");
        assert_eq!(error.code, StoreErrorCode::InvalidProfile);
    }

    #[test]
    fn v149_removes_user_selected_runtime_bindings_without_losing_codex_settings() {
        let directory = tempdir().expect("Profile");
        install_v148_fixture(directory.path());
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        connection
            .execute(
                "INSERT INTO codex_threads(
                   thread_id, thread_preview, model_provider, model_id, harness_id,
                   reasoning_effort, service_tier, status_type, status_active_flags_json,
                   archived, created_at, updated_at, linked_at
                 ) VALUES (
                   'thread:v149', 'kept', 'anthropic', 'gpt-5.6-terra', 'claude-code',
                   'high', 'fast', 'idle', '[]', 0, 1, 2, 'now'
                 )",
                [],
            )
            .expect("v148 Thread");
        connection
            .execute(
                "INSERT INTO codex_scheduled_automations(
                   automation_id, kind, status, name, prompt, rrule, model, model_provider,
                   harness_id, reasoning_effort, service_tier, cwds_json, execution_environment,
                   created_at, updated_at
                 ) VALUES (
                   'automation:v149', 'cron', 'ACTIVE', 'Daily', 'Run',
                   'FREQ=DAILY', 'gpt-5.6-terra', 'anthropic', 'claude-code', 'high', 'fast',
                   '[\"/repo\"]', 'worktree', 1, 2
                 )",
                [],
            )
            .expect("v148 Automation");

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v148_to_v149(
                transaction,
                &MigrationContext {
                    source_revision: 148,
                    target_revision: 149,
                    backup_name: "v148-to-v149-test.db".to_owned(),
                    source_schema_fingerprint: published_format(148)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(149)?.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )?;
            validate_schema_identity(transaction, 149)
        })
        .expect("v149 migration");

        for table in ["codex_threads", "codex_scheduled_automations"] {
            let columns = connection
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .expect("column query")
                .query_map([], |row| row.get::<_, String>(0))
                .expect("column rows")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("columns");
            assert!(!columns.iter().any(|column| column == "model_provider"));
            assert!(!columns.iter().any(|column| column == "harness_id"));
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT thread_preview, model_id, reasoning_effort, service_tier
                     FROM codex_threads WHERE thread_id = 'thread:v149'",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?
                    )),
                )
                .expect("migrated Thread"),
            (
                "kept".to_owned(),
                "gpt-5.6-terra".to_owned(),
                "high".to_owned(),
                "fast".to_owned()
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT model, reasoning_effort, service_tier
                     FROM codex_scheduled_automations WHERE automation_id = 'automation:v149'",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?
                    )),
                )
                .expect("migrated Automation"),
            (
                "gpt-5.6-terra".to_owned(),
                "high".to_owned(),
                "fast".to_owned()
            )
        );

        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v149_to_v150(
                transaction,
                &MigrationContext {
                    source_revision: 149,
                    target_revision: 150,
                    backup_name: "v149-to-v150-test.db".to_owned(),
                    source_schema_fingerprint: published_format(149)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(150)?.schema_fingerprint,
                    completed_at_unix_ms: 2,
                },
            )?;
            validate_schema_identity(transaction, 150)
        })
        .expect("v150 migration");

        for (table, id_column, id) in [
            ("codex_threads", "thread_id", "thread:v149"),
            (
                "codex_scheduled_automations",
                "automation_id",
                "automation:v149",
            ),
        ] {
            let binding = connection
                .query_row(
                    &format!(
                        "SELECT agent_backend_kind, agent_backend_definition_id, \
                                agent_backend_instance_config_id \
                         FROM {table} WHERE {id_column} = ?1"
                    ),
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("explicit migrated backend binding");
            assert_eq!(binding, ("codex".to_owned(), None, None));
        }
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM thread_backend_sessions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("backend session count"),
            0
        );
    }

    #[test]
    fn native_claude_migration_preserves_existing_backend_sessions() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let path = directory.path().join("nodex.db");
        fs::write(&path, include_bytes!("../../tests/fixtures/store-v171.db"))
            .expect("frozen Store");
        let mut connection = open_writer(&path).expect("fixture writer");
        connection.execute_batch("INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at,agent_backend_kind,agent_backend_definition_id,agent_backend_instance_config_id) VALUES ('acp',1,1,'today','acp','claude-agent-acp','work'),('codex',1,1,'today','codex',NULL,NULL); INSERT INTO thread_backend_sessions VALUES ('acp','acp','claude-agent-acp','work','session-1',1);").expect("existing sessions");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v171_to_v172(
                transaction,
                &MigrationContext {
                    source_revision: 171,
                    target_revision: 172,
                    backup_name: "native-claude-test.db".to_owned(),
                    source_schema_fingerprint: published_format(171)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(172)?.schema_fingerprint,
                    completed_at_unix_ms: 2,
                },
            )?;
            validate_schema_identity(transaction, 172)
        })
        .expect("native backend migration");
        assert_eq!(
            connection
                .query_row(
                    "SELECT backend_session_id FROM thread_backend_sessions WHERE thread_id='acp'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "session-1"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT agent_backend_kind FROM codex_threads WHERE thread_id='codex'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "codex"
        );
        assert!(
            connection
                .execute(
                    "UPDATE codex_threads SET agent_backend_kind='claude' WHERE thread_id='codex'",
                    []
                )
                .is_err()
        );
        connection.execute("UPDATE codex_threads SET agent_backend_kind='claude',agent_backend_instance_config_id='native-work' WHERE thread_id='codex'", []).expect("select native backend");
        connection.execute("INSERT INTO thread_backend_sessions VALUES ('codex','claude',NULL,'native-work','native-session',2)", []).expect("bind native session");
        assert!(connection.execute("UPDATE thread_backend_sessions SET instance_config_id=NULL WHERE thread_id='codex'", []).is_err());
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v172_to_v173(
                transaction,
                &MigrationContext {
                    source_revision: 172,
                    target_revision: 173,
                    backup_name: "native-state-test.db".to_owned(),
                    source_schema_fingerprint: published_format(172)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(173)?.schema_fingerprint,
                    completed_at_unix_ms: 3,
                },
            )?;
            validate_schema_identity(transaction, 173)
        })
        .expect("native state migration");
        let native_session: (String, Option<String>) = connection.query_row(
            "SELECT backend_session_id,native_state_json FROM thread_backend_sessions WHERE thread_id='codex'", [],
            |row| Ok((row.get(0)?, row.get(1)?))
        ).expect("preserved native session");
        assert_eq!(native_session, ("native-session".to_owned(), None));
        assert!(connection.execute("UPDATE thread_backend_sessions SET native_state_json='invalid' WHERE thread_id='codex'", []).is_err());
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            migrate_v173_to_v174(
                transaction,
                &MigrationContext {
                    source_revision: 173,
                    target_revision: 174,
                    backup_name: "native-home-test.db".to_owned(),
                    source_schema_fingerprint: published_format(173)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(174)?.schema_fingerprint,
                    completed_at_unix_ms: 4,
                },
            )?;
            validate_schema_identity(transaction, 174)
        })
        .expect("native scope migration");
        let preserved:(String,Option<String>)=connection.query_row("SELECT backend_session_id,native_home FROM thread_backend_sessions WHERE thread_id='codex'",[],|row|Ok((row.get(0)?,row.get(1)?))).expect("unclaimed older scope");
        assert_eq!(preserved, ("native-session".to_owned(), None));
        connection.execute("UPDATE thread_backend_sessions SET native_home='/native/home' WHERE thread_id='codex'",[]).expect("claim native home");
        connection.execute_batch("INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at,agent_backend_kind,agent_backend_instance_config_id) VALUES ('duplicate',1,1,'today','claude','native-work');").expect("second metadata identity");
        assert!(connection.execute("INSERT INTO thread_backend_sessions(thread_id,backend_kind,instance_config_id,backend_session_id,updated_at,native_home) VALUES ('duplicate','claude','native-work','native-session',2,'/native/home')",[]).is_err());
    }

    #[test]
    fn agent_runtime_binding_migration_preserves_session_identity_and_existing_execution_links() {
        let directory = tempdir().expect("Profile");
        let path = directory.path().join("nodex.db");
        fs::write(&path, include_bytes!("../../tests/fixtures/store-v174.db"))
            .expect("published predecessor");
        let mut connection = open_writer(&path).expect("writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            let steps = resolve_migration_path(174, 177, MIGRATION_STEPS)
                .expect("published Inbox predecessor path");
            for step in steps {
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "prepare-runtime-binding.db".into(),
                        source_schema_fingerprint: published_format(step.from_revision)?
                            .schema_fingerprint,
                        target_schema_fingerprint: published_format(step.to_revision)?
                            .schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
                validate_schema_identity(transaction, step.to_revision)?;
            }
            Ok(())
        })
        .expect("published Inbox and Session schema");
        connection.execute_batch(
            "INSERT INTO project_sessions(id,no_thread_fallback_title,\"order\",created_at,updated_at) \
             VALUES ('session:retained','Task',0,'2026-10-13T00:00:00.000Z','2026-10-13T00:00:00.000Z'); \
             INSERT INTO project_session_threads(session_id,thread_id,linked_at) \
             VALUES ('session:retained','fixture-acp','2026-10-13T00:00:00.000Z');"
        ).expect("existing Session identity and execution binding");
        let migrated = prepare_profile_store(&mut connection, directory.path())
            .expect("runtime binding upgrade");
        assert_eq!(migrated.migrated_from_version, Some(177));
        validate_schema_identity(&connection, CURRENT_STORE_REVISION)
            .expect("published runtime authority schema");
        assert_eq!(connection.query_row(
            "SELECT session_id,thread_id FROM project_session_threads WHERE session_id='session:retained'", [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        ).unwrap(), ("session:retained".into(), "fixture-acp".into()));
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM project_session_execution_bindings",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(connection.execute(
            "INSERT INTO project_session_execution_bindings(session_id,runtime_id,runtime_thread_id,launch_request_id,bound_at) VALUES ('session:retained','engine','thread','launch','today')", []
        ).is_err());
        drop(connection);
        let mut reopened = open_writer(&path).expect("reopen");
        assert_eq!(
            prepare_profile_store(&mut reopened, directory.path())
                .expect("current reopen")
                .migrated_from_version,
            None
        );
    }

    #[test]
    fn derived_runtime_authority_migration_keeps_native_turns_and_drops_runtime_mirrors() {
        let directory = tempdir().expect("Profile");
        let path = directory.path().join("nodex.db");
        fs::write(&path, include_bytes!("../../tests/fixtures/store-v174.db"))
            .expect("published predecessor");
        let mut connection = open_writer(&path).expect("writer");
        with_schema_rebuild_transaction(&mut connection, |transaction| {
            for step in resolve_migration_path(174, 181, MIGRATION_STEPS).expect("v181 path") {
                (step.apply)(
                    transaction,
                    &MigrationContext {
                        source_revision: step.from_revision,
                        target_revision: step.to_revision,
                        backup_name: "prepare-derived-authority.db".into(),
                        source_schema_fingerprint: published_format(step.from_revision)?
                            .schema_fingerprint,
                        target_schema_fingerprint: published_format(step.to_revision)?
                            .schema_fingerprint,
                        completed_at_unix_ms: 1,
                    },
                )?;
            }
            validate_schema_identity(transaction, 181)
        })
        .expect("v181 Store");
        let fingerprint = "0".repeat(64);
        for thread_id in ["fixture-native", "runtime:mirrored"] {
            connection
                .execute(
                    "INSERT INTO nodex_agent_turn_authorities(thread_id,turn_id,root_thread_id,library_id,\
                       profile_id,store_epoch,authority_fingerprint,provenance_version,created_at) \
                     VALUES (?1,'turn',?1,'library','profile','epoch',?2,2,'2026-10-15T00:00:00.000Z')",
                    params![thread_id, fingerprint],
                )
                .expect("retained Turn authority");
        }
        let migrated = prepare_profile_store(&mut connection, directory.path())
            .expect("derived authority upgrade");
        assert_eq!(migrated.migrated_from_version, Some(181));
        validate_schema_identity(&connection, CURRENT_STORE_REVISION).expect("current schema");
        let retained = connection
            .prepare("SELECT thread_id FROM nodex_agent_turn_authorities ORDER BY thread_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(retained, vec!["fixture-native".to_owned()]);
        assert!(
            connection
                .execute(
                    "DELETE FROM nodex_agent_turn_authorities WHERE thread_id='fixture-native'",
                    []
                )
                .is_err(),
            "native Turn authorities stay immutable"
        );
    }

    #[test]
    fn opencode_migration_preserves_sessions_and_reopens_once() {
        let directory = tempdir().expect("Profile");
        let path = directory.path().join("nodex.db");
        fs::write(&path, include_bytes!("../../tests/fixtures/store-v174.db"))
            .expect("frozen v174 Store");
        let mut connection = open_writer(&path).expect("writer");
        validate_schema_identity(&connection, 174).expect("exact predecessor");
        let prior: Vec<(String, String, Option<String>, Option<String>)> = connection
            .prepare("SELECT thread_id,backend_session_id,native_home,native_state_json FROM thread_backend_sessions ORDER BY thread_id")
            .unwrap().query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
            .unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(prior.len(), 2);
        let preparation =
            prepare_profile_store(&mut connection, directory.path()).expect("upgrade");
        assert_eq!(preparation.migrated_from_version, Some(174));
        validate_schema_identity(&connection, CURRENT_STORE_REVISION)
            .expect("exact current schema");
        let preserved: Vec<(String, String, Option<String>, Option<String>)> = connection
            .prepare("SELECT thread_id,backend_session_id,native_home,native_state_json FROM thread_backend_sessions ORDER BY thread_id")
            .unwrap().query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
            .unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(preserved, prior);
        assert_eq!(connection.query_row("SELECT count(*) FROM thread_backend_sessions WHERE runtime_options_json IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(connection.execute("UPDATE codex_threads SET agent_backend_kind='opencode',agent_backend_definition_id=NULL,agent_backend_instance_config_id=NULL WHERE thread_id='fixture-acp'", []).is_err());
        connection.execute_batch("INSERT INTO codex_threads(thread_id,created_at,updated_at,linked_at,agent_backend_kind,agent_backend_instance_config_id,recency_at) VALUES ('open',1,1,'2026-10-03T00:00:00.000Z','opencode','open-work',1),('open-duplicate',1,1,'2026-10-03T00:00:00.000Z','opencode','another-work',1); INSERT INTO thread_backend_sessions(thread_id,backend_kind,instance_config_id,backend_session_id,updated_at,native_home,runtime_options_json) VALUES ('open','opencode','open-work','open-session',2,'https://open.example.test','{\"model\":\"moonshot/kimi-k3\",\"mode_id\":\"build\",\"config_options\":[{\"id\":\"thinking\",\"value\":true}]}');").expect("new OpenCode session");
        assert!(connection.execute("INSERT INTO thread_backend_sessions(thread_id,backend_kind,instance_config_id,backend_session_id,updated_at,native_home) VALUES ('open-duplicate','opencode','another-work','open-session',2,'https://open.example.test')", []).is_err());
        assert!(connection.execute("UPDATE thread_backend_sessions SET runtime_options_json='invalid' WHERE thread_id='open'", []).is_err());
        drop(connection);
        let mut reopened = open_writer(&path).expect("reopen");
        let preparation =
            prepare_profile_store(&mut reopened, directory.path()).expect("current reopen");
        assert_eq!(preparation.migrated_from_version, None);
        assert_eq!(
            reopened
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            CURRENT_STORE_REVISION - 174
        );
        assert_eq!(
            fs::read_dir(directory.path().join("backups/core-migrations"))
                .unwrap()
                .count(),
            1
        );
        let options: String = reopened
            .query_row(
                "SELECT runtime_options_json FROM thread_backend_sessions WHERE thread_id='open'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&options).unwrap()["model"],
            "moonshot/kimi-k3"
        );
    }

    // These historical fixtures author the canonical Page closure through today's
    // public writer, then remove its extra Inbox participants before validating the
    // exact predecessor. Runtime writers never support an older physical schema.
    fn prepare_historical_inbox_capture(connection: &mut Connection) -> Result<(), StoreError> {
        let mut fresh = Connection::open_in_memory()?;
        install_current_schema(&mut fresh)?;
        let firing_schema: String = fresh.query_row(
            "SELECT sql FROM sqlite_schema WHERE name='core_automation_firings'",
            [],
            |row| row.get(0),
        )?;
        connection.execute_batch(&firing_schema)?;
        // Current capture writes waiting, converted back to the exact historical contract below.
        connection.pragma_update(None, "ignore_check_constraints", true)?;
        connection.execute_batch("ALTER TABLE inbox_suggestion_requests ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array');")?;
        connection.execute_batch(
            "ALTER TABLE inbox_entries ADD COLUMN source_automation_id TEXT;
            ALTER TABLE inbox_entries ADD COLUMN source_dispatch_id TEXT;",
        )?;
        Ok(())
    }

    fn finish_historical_inbox_capture(connection: &Connection) -> Result<(), StoreError> {
        restore_historical_inbox_bases(connection)?;
        connection
            .execute_batch("ALTER TABLE inbox_suggestion_requests DROP COLUMN inputs_json;")?;
        connection.execute_batch(
            "DROP TABLE core_automation_firings;
            ALTER TABLE inbox_entries DROP COLUMN source_automation_id;
            ALTER TABLE inbox_entries DROP COLUMN source_dispatch_id;",
        )?;
        Ok(())
    }

    fn restore_historical_inbox_bases(connection: &Connection) -> Result<(), StoreError> {
        connection.execute(
            "UPDATE inbox_entries SET suggestion_state='pending' WHERE suggestion_state='waiting'",
            [],
        )?;
        for table in ["inbox_proposals", "inbox_suggestion_requests"] {
            connection.execute(&format!("UPDATE {table} SET basis_json=(SELECT json_group_array(json_object('page_id',json_extract(basis.value,'$.page_id'),'generation',document.generation,'head_seq',document.head_seq,'placement_revision',block.placement_revision)) FROM json_each({table}.basis_json) basis JOIN pages page ON page.block_id=json_extract(basis.value,'$.page_id') JOIN documents document ON document.id=page.document_id JOIN blocks block ON block.id=page.block_id)"),[])?;
        }
        connection.pragma_update(None, "ignore_check_constraints", false)?;
        Ok(())
    }

    #[test]
    fn inbox_importance_migration_leaves_waiting_messages_unmarked() {
        use crate::infrastructure::store::SqliteStoreKernel;
        use crate::workspace::ProjectWorkspaceModule;
        use nodex_core_contracts::workspace::ProjectWorkspaceIntent;
        use nodex_core_contracts::{
            AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest,
            PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, StoreEpoch,
        };

        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 187);
        let predecessor = SqliteStoreKernel::open_test(profile.path()).expect("v187 runtime");
        predecessor
            .writer()
            .call(prepare_historical_inbox_capture)
            .unwrap();
        let (profile_id, library_id, epoch): (String, String, String) = predecessor
            .readers()
            .read_default(|connection| {
                Ok(connection.query_row(
                    "SELECT profile_id,id,(SELECT store_epoch FROM block_store_metadata) FROM libraries",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .unwrap();
        let module = ProjectWorkspaceModule::new(&profile_id, &library_id, &predecessor).unwrap();
        module.seed_rootless_default_project_for_test();
        module
            .apply(
                &BoundModuleContext {
                    editor_history_owner: None,
                    profile_id: ProfileId(profile_id.clone()),
                    library_id: LibraryId(library_id.clone()),
                    project_id: None,
                    connection_id: "connection:inbox-importance-migration".into(),
                    adapter: AdapterKind::ElectronHost,
                },
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: format!("send:waiting:{}", random_uuid_v7().unwrap()),
                    store_epoch: StoreEpoch(epoch.clone()),
                    intent: ProjectWorkspaceIntent::SendInboxMessage {
                        expected_store_epoch: Some(epoch),
                        page_id: "page:waiting".into(),
                        document_id: "document:waiting".into(),
                        body: "Still waiting for the user".into(),
                        title: None,
                        project_id: None,
                    },
                },
            )
            .expect("v187 capture");
        predecessor
            .writer()
            .call(|connection| {
                finish_historical_inbox_capture(connection)?;
                super::derivation_tests::rewrite_as_predecessor(connection, 187);
                Ok(())
            })
            .unwrap();
        drop(module);
        drop(predecessor);

        let store = SqliteStoreKernel::open(profile.path()).expect("upgrade Inbox entries");
        assert_eq!(store.preparation().migrated_from_version, Some(187));
        store
            .readers()
            .read_default(|connection| {
                validate_current_store(connection)?;
                assert_eq!(
                    connection.query_row(
                        "SELECT important FROM inbox_entries WHERE page_id = 'page:waiting'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                Ok(())
            })
            .expect("waiting messages start unmarked");
    }

    #[test]
    fn page_layout_migration_hides_empty_properties_and_keeps_explicit_hides() {
        use crate::infrastructure::store::SqliteStoreKernel;
        use crate::workspace::ProjectWorkspaceModule;

        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 185);
        // Current Project creation produces the Data Source and Page layout closure shared by
        // v185 and v186; only the retired default visibility needs SQL.
        let predecessor = SqliteStoreKernel::open_test(profile.path()).expect("v185 runtime");
        let (profile_id, library_id): (String, String) = predecessor
            .readers()
            .read_default(|connection| {
                Ok(
                    connection.query_row("SELECT profile_id,id FROM libraries", [], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?,
                )
            })
            .unwrap();
        let module = ProjectWorkspaceModule::new(&profile_id, &library_id, &predecessor).unwrap();
        module.seed_rootless_default_project_for_test();
        let (data_source_id, revision, entries): (String, i64, i64) = predecessor
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE data_source_page_layout_entries SET visibility = \
                         CASE WHEN property_id = 'task_parent' THEN 'always_hide' \
                         ELSE 'always_show' END",
                        [],
                    )?;
                    Ok(())
                })?;
                validate_migration_source(connection, 185)?;
                Ok(connection.query_row(
                    "SELECT layout.data_source_id, layout.revision, count(entry.property_id) \
                     FROM data_source_page_layouts layout \
                     JOIN data_source_page_layout_entries entry USING (data_source_id) \
                     GROUP BY layout.data_source_id",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("historical Page layout");
        assert!(entries > 1);
        drop(module);
        drop(predecessor);

        let store = SqliteStoreKernel::open(profile.path()).expect("upgrade Page layout");
        assert_eq!(store.preparation().migrated_from_version, Some(185));
        store
            .readers()
            .read_default(|connection| {
                validate_current_store(connection)?;
                let visibility = |value: &str| -> rusqlite::Result<i64> {
                    connection.query_row(
                        "SELECT count(*) FROM data_source_page_layout_entries \
                         WHERE data_source_id = ?1 AND visibility = ?2",
                        params![data_source_id, value],
                        |row| row.get(0),
                    )
                };
                assert_eq!(visibility("always_show")?, 0);
                assert_eq!(visibility("hide_when_empty")?, entries - 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT visibility FROM data_source_page_layout_entries \
                         WHERE data_source_id = ?1 AND property_id = 'task_parent'",
                        [&data_source_id],
                        |row| row.get::<_, String>(0),
                    )?,
                    "always_hide"
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT revision FROM data_source_page_layouts WHERE data_source_id = ?1",
                        [&data_source_id],
                        |row| row.get::<_, i64>(0),
                    )?,
                    revision + 1
                );
                Ok(())
            })
            .expect("Page layout hides empty Properties");
    }

    #[test]
    fn inbox_migration_requeues_abstentions_without_executing_them() {
        use crate::infrastructure::store::SqliteStoreKernel;
        use crate::workspace::ProjectWorkspaceModule;
        use nodex_core_contracts::inbox::{
            ProjectWorkspaceInboxDispatchAction, ProjectWorkspaceInboxSuggestionMode,
        };
        use nodex_core_contracts::workspace::{
            ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        };
        use nodex_core_contracts::{
            AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ModuleReadRequest,
            PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, StoreEpoch,
        };

        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 184);
        let predecessor = SqliteStoreKernel::open_test(profile.path()).expect("v184 runtime");
        // Current authoring operates on the successor's field names; restore the
        // exact historical physical schema before exercising migration admission.
        predecessor
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "ALTER TABLE document_materializations RENAME COLUMN nfm TO markdown",
                )?;
                Ok::<_, StoreError>(())
            })
            .unwrap();
        predecessor
            .writer()
            .call(prepare_historical_inbox_capture)
            .unwrap();
        let (profile_id, library_id, epoch): (String, String, String) = predecessor
            .readers()
            .read_default(|connection| {
                Ok(connection.query_row(
                    "SELECT profile_id,id,(SELECT store_epoch FROM block_store_metadata) FROM libraries",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .unwrap();
        let context = BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId(profile_id.clone()),
            library_id: LibraryId(library_id.clone()),
            project_id: None,
            connection_id: "connection:inbox-migration".into(),
            adapter: AdapterKind::ElectronHost,
        };
        let module = ProjectWorkspaceModule::new(&profile_id, &library_id, &predecessor).unwrap();
        module.seed_rootless_default_project_for_test();
        let apply = |operation_id: &str, intent| {
            module
                .apply(
                    &context,
                    ModuleApplyRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        operation_id: format!("{operation_id}:{}", random_uuid_v7().unwrap()),
                        store_epoch: StoreEpoch(epoch.clone()),
                        intent,
                    },
                )
                .unwrap();
        };
        for id in ["open", "kept", "concrete"] {
            apply(
                &format!("send:{id}"),
                ProjectWorkspaceIntent::SendInboxMessage {
                    expected_store_epoch: Some(epoch.clone()),
                    page_id: format!("page:{id}"),
                    document_id: format!("document:{id}"),
                    body: format!("Preserve the {id} message"),
                    title: None,
                    project_id: None,
                },
            );
        }
        let ProjectWorkspaceReadValue::InboxPendingSuggestions { entries } = module
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::InboxPendingSuggestions { limit: 8 },
                },
            )
            .unwrap()
            .value
        else {
            panic!("pending Inbox entries");
        };
        for entry in &entries {
            apply(
                &format!("propose:{}", entry.page_id),
                ProjectWorkspaceIntent::ProposeInboxDispatch {
                    proposal_id: format!("proposal:{}", entry.page_id),
                    page_ids: vec![entry.page_id.clone()],
                    basis: vec![entry.basis.clone()],
                    action: ProjectWorkspaceInboxDispatchAction::Keep,
                    entry_kind: None,
                    summary: "Keep this note".into(),
                    rationale: None,
                    produced_by: None,
                },
            );
        }
        let open = entries
            .iter()
            .find(|entry| entry.page_id == "page:open")
            .unwrap();
        apply(
            "refine:old",
            ProjectWorkspaceIntent::RequestInboxSuggestion {
                request_id: "request:old".into(),
                mode: ProjectWorkspaceInboxSuggestionMode::Refine,
                page_ids: vec![open.page_id.clone()],
                basis: vec![open.basis.clone()],
                proposal_id: Some("proposal:page:open".into()),
                expected_revision: Some(1),
                correction: Some("Give this a concrete action".into()),
            },
        );
        predecessor.writer().call(move |connection| {
            with_immediate_transaction(connection, |transaction| {
                // Only the retired storage action and its historical handled state need SQL.
                transaction.execute(
                    "UPDATE inbox_proposals SET action_json='{\"type\":\"none\",\"reason\":\"Decide manually\"}' WHERE proposal_id IN ('proposal:page:open','proposal:page:kept')",
                    [],
                )?;
                transaction.execute(
                    "UPDATE inbox_entries SET state='kept',outcome='kept' WHERE page_id='page:kept'",
                    [],
                )?;
                // Exercise every proposal FK, including retained capability rows. The
                // migration must remove their payloads even with foreign_keys disabled.
                transaction.execute(
                    "INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id) VALUES ('proposal:page:kept',?1,'Old payload','launch:old','message:old')",
                    [&epoch],
                )?;
                transaction.execute(
                    "INSERT INTO inbox_decision_undo(token,operation_id,library_id,store_epoch,proposal_id,recipe_json) VALUES ('undo:old','decision:old',?1,?2,'proposal:page:kept','{}')",
                    params![library_id,epoch],
                )?;
                Ok(())
            })?;
            finish_historical_inbox_capture(connection)?;
            super::derivation_tests::rewrite_as_predecessor(connection, 184);
            connection.execute_batch("ALTER TABLE document_materializations RENAME COLUMN markdown TO nfm")?;
            validate_migration_source(connection, 184)
        }).expect("valid historical Inbox closure");
        drop(module);
        drop(predecessor);

        // The production open runs migrate_store with foreign_keys disabled, creates
        // its backup, validates the entire Store, and only then starts the runtime.
        let store = SqliteStoreKernel::open(profile.path()).expect("upgrade historical Inbox");
        assert_eq!(store.preparation().migrated_from_version, Some(184));
        store.readers().read_default(|connection| {
            validate_current_store(connection)?;
            let open: (String,String,Option<String>,Option<String>,Option<String>) = connection.query_row(
                "SELECT state,suggestion_state,current_proposal_id,suggestion_request_id,outcome FROM inbox_entries WHERE page_id='page:open'",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            )?;
            assert_eq!(open,("open".into(),"waiting".into(),None,None,None));
            let kept: (String,Option<String>,Option<String>) = connection.query_row(
                "SELECT state,current_proposal_id,outcome FROM inbox_entries WHERE page_id='page:kept'",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )?;
            assert_eq!(kept,("kept".into(),None,Some("kept".into())));
            let request: (String,i64,Option<String>,Option<i64>,Option<String>) = connection.query_row(
                "SELECT state,generation,proposal_id,expected_revision,correction FROM inbox_suggestion_requests WHERE request_id='request:old'",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            )?;
            assert_eq!(request,("superseded".into(),2,None,None,None));
            let proposals: Vec<String> = connection.prepare("SELECT proposal_id FROM inbox_proposals")?
                .query_map([],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
            assert_eq!(proposals,vec!["proposal:page:concrete"]);
            let members: Vec<String> = connection.prepare("SELECT page_id FROM inbox_proposal_pages")?
                .query_map([],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
            assert_eq!(members,vec!["page:concrete"]);
            for table in ["inbox_handoffs","inbox_decision_undo"] {
                assert_eq!(connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get::<_,i64>(0))?,0);
            }
            assert_eq!(connection.query_row("SELECT count(*) FROM pages",[],|row|row.get::<_,i64>(0))?,3);
            assert_eq!(connection.query_row("SELECT count(*) FROM inbox_proposals WHERE state IN ('dispatching','completed')",[],|row|row.get::<_,i64>(0))?,0);
            Ok(())
        }).expect("migration preserves content without executing advice");
        drop(store);
        let reopened = SqliteStoreKernel::open(profile.path()).expect("reopen upgraded Inbox");
        assert_eq!(reopened.preparation().migrated_from_version, None);
        assert_eq!(
            fs::read_dir(profile.path().join("backups/core-migrations"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn inbox_migration_preserves_delivery_uncertainty_and_invalidates_unfenced_advice() {
        let profile = tempdir().expect("Profile");
        install_intermediate_fixture(profile.path(), 183);
        let mut connection = open_writer(&profile.path().join("nodex.db")).expect("predecessor");
        // These storage fixtures isolate the historical Inbox rows being transformed.
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        for (index, state) in ["open", "dispatching", "completed"].into_iter().enumerate() {
            let basis =
                json!([{"page_id": format!("migration:{state}"), "generation": 1, "head_seq": 1}])
                    .to_string();
            connection.execute("INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,basis_json,dispatch_session_id,confirmed_at,created_at,updated_at) VALUES (?1,'library','agent',?2,'{\"type\":\"new_chat\",\"project_id\":null,\"prompt\":\"Review\"}','Review',?3,'session','today','today','today')", params![state,state,basis]).unwrap();
            connection.execute("INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,state,suggestion_state,current_proposal_id,updated_at) VALUES (?1,'library',?2,'today','user',?3,'settled',?4,'today')", params![format!("migration:{state}"), index as i64 + 1, if state == "open" {"open"} else {"kept"}, state]).unwrap();
        }
        with_immediate_transaction(&mut connection, |transaction| {
            migrate_v183_to_v184(
                transaction,
                &MigrationContext {
                    source_revision: 183,
                    target_revision: 184,
                    backup_name: "inbox-fixture".into(),
                    source_schema_fingerprint: published_format(183)?.schema_fingerprint,
                    target_schema_fingerprint: published_format(184)?.schema_fingerprint,
                    completed_at_unix_ms: 1,
                },
            )
        })
        .expect("Inbox migration");
        validate_schema_identity(&connection, 184).expect("current schema");
        let delivery: Option<String> = connection
            .query_row(
                "SELECT outcome FROM inbox_entries WHERE current_proposal_id='dispatching'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(delivery.is_none());
        let accepted: String = connection
            .query_row(
                "SELECT outcome FROM inbox_entries WHERE current_proposal_id='completed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(accepted, "chat");
        let advice: (String, Option<String>) = connection.query_row("SELECT suggestion_state,current_proposal_id FROM inbox_entries WHERE page_id='migration:open'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(advice, ("pending".into(), None));
        let open: String = connection
            .query_row(
                "SELECT state FROM inbox_proposals WHERE proposal_id='open'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(open, "superseded");
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM inbox_handoffs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn waiting_firing_schema_enforces_one_waiting_message_and_tracks_page_lifecycle() {
        let mut connection = Connection::open_in_memory().unwrap();
        install_current_schema(&mut connection).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        super::super::legacy_visibility_migration::install_test_maintenance_context(&connection)
            .unwrap();
        connection.execute("INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,created_at,updated_at) VALUES ('task','cron','ACTIVE','Report',1,1)",[]).unwrap();
        for (index, status) in [(1, "failed"), (2, "held")] {
            let page = format!("page:{index}");
            let dispatch = format!("dispatch:{index}");
            connection.execute("INSERT INTO blocks(id,library_id,type,lifecycle,created_at,updated_at) VALUES (?1,'library','page','active','2026-10-27T00:00:00Z','2026-10-27T00:00:00Z')",[&page]).unwrap();
            connection.execute("INSERT INTO core_automation_firings(dispatch_id,automation_id,status,page_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,hold_basis_json,created_at_ms,updated_at_ms) VALUES (?1,'task',?2,?3,?4,?4,2,'{}',?4,?4)",params![dispatch,status,page,index]).unwrap();
        }
        connection
            .execute(
                "UPDATE core_automation_firings SET waiting_in_inbox=1 WHERE dispatch_id='dispatch:1'",
                [],
            )
            .unwrap();
        let conflict = connection
            .execute(
                "UPDATE core_automation_firings SET waiting_in_inbox=1 WHERE dispatch_id='dispatch:2'",
                [],
            )
            .unwrap_err();
        assert_eq!(
            conflict.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );

        // Leaving the Inbox releases the slot for the task's next waiting firing.
        connection
            .execute_batch(
                "UPDATE core_automation_firings SET waiting_in_inbox=0 WHERE dispatch_id='dispatch:1';
                 UPDATE core_automation_firings SET waiting_in_inbox=1,due_at_ms=3 WHERE dispatch_id='dispatch:2';
                 UPDATE blocks SET lifecycle='archived' WHERE id='page:2';",
            )
            .unwrap();
        let firing_state = |dispatch: &str| {
            connection
                .query_row(
                    "SELECT status,waiting_in_inbox,due_at_ms FROM core_automation_firings WHERE dispatch_id=?1",
                    [dispatch],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?)),
                )
                .unwrap()
        };
        assert_eq!(firing_state("dispatch:2"), ("withdrawn".into(), 0, None));
        connection
            .execute_batch(
                "UPDATE core_automation_firings SET waiting_in_inbox=1,due_at_ms=3 WHERE dispatch_id='dispatch:1';
                 DELETE FROM blocks WHERE id='page:1';",
            )
            .unwrap();
        assert_eq!(firing_state("dispatch:1"), ("withdrawn".into(), 0, None));
    }

    fn run_inbox_content_fingerprint_migration(erased_firing: bool) {
        use crate::infrastructure::store::SqliteStoreKernel;
        use crate::workspace::ProjectWorkspaceModule;
        use nodex_core_contracts::inbox::{
            ProjectWorkspaceInboxDispatchAction, ProjectWorkspaceInboxSuggestionMode,
        };
        use nodex_core_contracts::workspace::{
            ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        };
        use nodex_core_contracts::{
            AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ModuleReadRequest,
            PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, StoreEpoch,
        };
        let profile = tempdir().unwrap();
        install_intermediate_fixture(profile.path(), 193);
        let kernel = SqliteStoreKernel::open_test(profile.path()).unwrap();
        kernel
            .writer()
            .call(|connection| {
                connection.pragma_update(None, "ignore_check_constraints", true)?;
                connection.execute_batch("ALTER TABLE inbox_suggestion_requests ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inputs_json) AND json_type(inputs_json) = 'array');")?;
                Ok(())
            })
            .unwrap();
        let (profile_id,library_id,epoch):(String,String,String)=kernel.readers().read_default(|connection| Ok(connection.query_row("SELECT profile_id,id,(SELECT store_epoch FROM block_store_metadata) FROM libraries",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)).unwrap();
        let module = ProjectWorkspaceModule::new(&profile_id, &library_id, &kernel).unwrap();
        module.seed_rootless_default_project_for_test();
        let host = BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId(profile_id),
            library_id: LibraryId(library_id),
            project_id: None,
            connection_id: "migration-inbox-content".into(),
            adapter: AdapterKind::ElectronHost,
        };
        let apply = |_operation: &str, intent| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            module
                .apply(
                    &host,
                    ModuleApplyRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        operation_id: format!(
                            "nodexop:v1:{now}:{}:inbox-migration:{}",
                            now + 7 * 24 * 60 * 60 * 1000,
                            random_uuid_v7().unwrap()
                        ),
                        store_epoch: StoreEpoch(epoch.clone()),
                        intent,
                    },
                )
                .unwrap()
        };
        for id in ["advice", "request", "waiting"] {
            apply(
                &format!("send:{id}"),
                ProjectWorkspaceIntent::SendInboxMessage {
                    expected_store_epoch: None,
                    page_id: format!("page:{id}"),
                    document_id: format!("document:{id}"),
                    body: format!("- Review the **{id}** message.\n- Keep the list."),
                    title: None,
                    project_id: None,
                },
            );
        }
        let ProjectWorkspaceReadValue::InboxPendingSuggestions { entries } = module
            .read(
                &host,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::InboxPendingSuggestions { limit: 8 },
                },
            )
            .unwrap()
            .value
        else {
            panic!("entries")
        };
        let basis = |id: &str| {
            entries
                .iter()
                .find(|entry| entry.page_id == format!("page:{id}"))
                .unwrap()
                .basis
                .clone()
        };
        for id in ["advice", "request"] {
            apply(
                &format!("propose:{id}"),
                ProjectWorkspaceIntent::ProposeInboxDispatch {
                    proposal_id: format!("proposal:{id}"),
                    page_ids: vec![format!("page:{id}")],
                    basis: vec![basis(id)],
                    action: ProjectWorkspaceInboxDispatchAction::Keep,
                    entry_kind: None,
                    summary: "Keep this note".into(),
                    rationale: None,
                    produced_by: None,
                },
            );
        }
        apply(
            "request:active",
            ProjectWorkspaceIntent::RequestInboxSuggestion {
                request_id: "request:active".into(),
                mode: ProjectWorkspaceInboxSuggestionMode::Grouped,
                page_ids: vec!["page:request".into()],
                basis: vec![basis("request")],
                proposal_id: None,
                expected_revision: None,
                correction: None,
            },
        );
        if erased_firing {
            apply(
                "send:erased",
                ProjectWorkspaceIntent::SendInboxMessage {
                    expected_store_epoch: None,
                    page_id: "page:erased".into(),
                    document_id: "document:erased".into(),
                    body: "Prepare the daily report.".into(),
                    title: None,
                    project_id: None,
                },
            );
            // Historical scheduled metadata is the subject; erasure itself uses the host operation.
            kernel.writer().call(|connection| {
                connection.execute("INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,prompt,rrule,launch,created_at,updated_at) VALUES ('task:erased','cron','PAUSED','Daily report','Prepare the daily report.','FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0','ask',1,1)",[])?;
                connection.execute("UPDATE inbox_entries SET source_kind='scheduled_task',source_label='Daily report',source_automation_id='task:erased',source_dispatch_id='firing:erased' WHERE page_id='page:erased'",[])?;
                connection.execute("INSERT INTO core_automation_firings(dispatch_id,automation_id,status,waiting_in_inbox,page_id,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms) SELECT 'firing:erased','task:erased','held',1,'page:erased',1,1,json_object('page_id','page:erased','generation',document.generation,'head_seq',document.head_seq,'placement_revision',block.placement_revision),1,1 FROM pages page JOIN documents document ON document.id=page.document_id JOIN blocks block ON block.id=page.block_id WHERE page.block_id='page:erased'",[])?;
                Ok(())
            }).unwrap();
            apply(
                "delete:erased",
                ProjectWorkspaceIntent::DeleteInboxMessages {
                    page_ids: vec!["page:erased".into()],
                },
            );
            kernel
                .readers()
                .read_default(|connection| {
                    assert_eq!(
                        connection.query_row(
                            "SELECT count(*) FROM pages WHERE block_id='page:erased'",
                            [],
                            |row| row.get::<_, i64>(0)
                        )?,
                        1
                    );
                    assert_eq!(
                        connection.query_row(
                            "SELECT count(*) FROM inbox_entries WHERE page_id='page:erased'",
                            [],
                            |row| row.get::<_, i64>(0)
                        )?,
                        0
                    );
                    Ok(())
                })
                .unwrap();
        }
        let written_coordinates=kernel.readers().read_default(|connection| Ok(connection.query_row("SELECT json_array(json_object('page_id','page:advice','generation',document.generation,'head_seq',document.head_seq,'placement_revision',block.placement_revision)) FROM pages page JOIN documents document ON document.id=page.document_id JOIN blocks block ON block.id=page.block_id WHERE page.block_id='page:advice'",[],|row|row.get::<_,String>(0))?)).unwrap();
        apply(
            "edit:advice",
            ProjectWorkspaceIntent::EditInboxMessage {
                page_id: "page:advice".into(),
                basis: basis("advice"),
                original_body: "- Review the **advice** message.\n- Keep the list.".into(),
                body: "Review the revised advice message.".into(),
            },
        );
        kernel.writer().call(move |connection| {
            restore_historical_inbox_bases(connection)?;
            connection.execute_batch("ALTER TABLE inbox_suggestion_requests DROP COLUMN inputs_json;")?;
            connection.execute("UPDATE inbox_entries SET suggestion_state='settled' WHERE page_id='page:advice'",[])?;
            connection.execute("UPDATE inbox_proposals SET basis_json=?1 WHERE proposal_id='proposal:advice'",[written_coordinates])?;
            Ok(())
        }).unwrap();
        drop(module);
        drop(kernel);
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        validate_schema_identity(&connection, 193).unwrap();
        let prepared = prepare_profile_store(&mut connection, profile.path()).unwrap();
        assert_eq!(prepared.migrated_from_version, Some(193));
        validate_schema_identity(&connection, 194).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            194
        );
        let steps = connection
            .prepare("SELECT source_revision,target_revision FROM core_store_migration_history WHERE source_revision>=193 ORDER BY source_revision")
            .unwrap()
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(steps, vec![(193, 194)]);
        let states = connection
            .prepare("SELECT page_id,suggestion_state FROM inbox_entries ORDER BY page_id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            states,
            vec![
                ("page:advice".into(), "settled".into()),
                ("page:request".into(), "pending".into()),
                ("page:waiting".into(), "waiting".into())
            ]
        );
        let (error, proposal_id, proposal_state): (Option<String>, String, String) = connection
            .query_row(
                "SELECT entry.suggestion_error,entry.current_proposal_id,proposal.state FROM inbox_entries entry JOIN inbox_proposals proposal ON proposal.proposal_id=entry.current_proposal_id WHERE entry.page_id='page:request'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(error, None);
        assert_eq!(proposal_id, "proposal:request");
        assert_eq!(proposal_state, "open");
        let (request_state, inputs): (String, String) = connection
            .query_row(
                "SELECT state,inputs_json FROM inbox_suggestion_requests WHERE request_id='request:active'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(request_state, "pending");
        let frozen: Vec<crate::workspace::FrozenSuggestionInput> =
            serde_json::from_str(&inputs).unwrap();
        assert_eq!(frozen.len(), 1);
        assert_eq!(
            frozen[0].content.markdown,
            "- Review the **request** message.\n- Keep the list."
        );
        assert_eq!(frozen[0].input.body, frozen[0].content.markdown);
        assert_eq!(
            frozen[0].input.basis.content_hash,
            frozen[0].content.fingerprint()
        );
        assert_ne!(
            crate::workspace::inbox_message_basis_for_migration(&connection, "page:advice")
                .unwrap()
                .content_hash,
            crate::document::sha256(b"Review the advice message.")
        );
        for (table, id, column) in [
            ("inbox_proposals", "proposal:advice", "proposal_id"),
            ("inbox_suggestion_requests", "request:active", "request_id"),
        ] {
            let json: String = connection
                .query_row(
                    &format!("SELECT basis_json FROM {table} WHERE {column}=?1"),
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            let basis: Vec<nodex_core_contracts::inbox::ProjectWorkspaceInboxPageBasis> =
                serde_json::from_str(&json).unwrap();
            assert_eq!(
                basis[0].content_hash,
                crate::workspace::inbox_content::content_from_markdown(
                    &connection,
                    format!(
                        "- Review the **{}** message.\n- Keep the list.",
                        if table == "inbox_proposals" {
                            "advice"
                        } else {
                            "request"
                        }
                    )
                )
                .unwrap()
                .fingerprint()
            );
        }
        if erased_firing {
            let (state,json):(String,String)=connection.query_row("SELECT status,hold_basis_json FROM core_automation_firings WHERE dispatch_id='firing:erased'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            assert_eq!(state, "withdrawn");
            let basis: nodex_core_contracts::inbox::ProjectWorkspaceInboxPageBasis =
                serde_json::from_str(&json).unwrap();
            assert_eq!(basis.page_id, "page:erased");
            assert_eq!(basis.content_hash.len(), 64);
        }
    }

    #[test]
    fn inbox_handoff_migration_never_substitutes_an_unproven_file_head() {
        use nodex_core_contracts::inbox::ProjectWorkspaceInboxMessageImage;
        let mut connection = Connection::open_in_memory().unwrap();
        install_current_schema(&mut connection).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        // Historical attachment storage is the subject; no current Page workflow owns
        // the legacy source-only handoff this fixture reconstructs.
        let first = "a".repeat(64);
        let old = "b".repeat(64);
        let replacement = "c".repeat(64);
        for hash in [&first, &old, &replacement] {
            connection.execute("INSERT INTO managed_blobs(content_hash,physical_asset_name,byte_length,created_at) VALUES (?1,?2,1,'2026-01-01T00:00:00Z')", params![hash,format!("{hash}.blob")]).unwrap();
        }
        for (file, version, hash) in [
            ("single", 1, &first),
            ("replaced", 1, &old),
            ("replaced", 2, &replacement),
        ] {
            connection.execute("INSERT INTO file_versions(file_id,version,library_id,blob_hash,mime_type,byte_length,operation_id,occurred_at) VALUES (?1,?2,'library',?3,'image/png',1,'legacy-import','2026-01-01T00:00:00Z')", params![file,version,hash]).unwrap();
        }
        for (file, head) in [("single", 1), ("replaced", 2)] {
            connection.execute("INSERT INTO library_files(file_id,library_id,default_name,head_version,revision,lifecycle,created_at,updated_at) VALUES (?1,'library','image.png',?2,?2,'live','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", params![file,head]).unwrap();
        }
        let sources = vec![
            "nodex://files/single",
            "nodex://files/replaced",
            "nodex://files/gone",
        ];
        connection.execute("INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id,images_json) VALUES ('legacy','epoch','Confirmed prompt','launch','message',?1)", [serde_json::to_string(&sources).unwrap()]).unwrap();
        migrate_inbox_handoff_images(&connection).unwrap();
        let json: String = connection
            .query_row(
                "SELECT images_json FROM inbox_handoffs WHERE proposal_id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let images: Vec<ProjectWorkspaceInboxMessageImage> = serde_json::from_str(&json).unwrap();
        assert_eq!(
            images
                .iter()
                .map(|image| image.source.as_str())
                .collect::<Vec<_>>(),
            sources
        );
        assert_eq!(images[0].content_hash, first);
        assert_ne!(images[1].content_hash, replacement);
        assert_ne!(images[1].content_hash, old);
        assert_eq!(images[2].file_id, "gone");
    }

    #[test]
    fn inbox_content_fingerprint_migration_preserves_advice_requests_and_waiting_sends() {
        run_inbox_content_fingerprint_migration(false);
    }

    #[test]
    fn inbox_content_fingerprint_migration_accepts_erased_scheduled_members_before_collection() {
        run_inbox_content_fingerprint_migration(true);
    }

    #[test]
    fn scheduled_firing_migration_converges_from_v192_and_preserves_saved_tasks() {
        let profile = tempdir().unwrap();
        install_intermediate_fixture(profile.path(), 192);
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        connection.execute("INSERT INTO codex_scheduled_automations(automation_id,kind,status,name,created_at,updated_at) VALUES ('saved-task','cron','PAUSED','Saved task',1,1)",[]).unwrap();
        validate_schema_identity(&connection, 192).unwrap();
        let preparation = prepare_profile_store(&mut connection, profile.path()).unwrap();
        assert_eq!(preparation.migrated_from_version, Some(192));
        assert_eq!(preparation.schema_version, CURRENT_STORE_REVISION);
        validate_schema_identity(&connection, CURRENT_STORE_REVISION).unwrap();
        let history = connection
            .prepare(
                "SELECT source_revision,target_revision FROM core_store_migration_history \
                 WHERE target_revision = 193",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(history, vec![(192, 193)]);
        let mut fresh = Connection::open_in_memory().unwrap();
        install_current_schema(&mut fresh).unwrap();
        assert_eq!(
            super::super::schema::read_schema_inventory(&connection).unwrap(),
            super::super::schema::read_schema_inventory(&fresh).unwrap()
        );
        let launch: String = connection
            .query_row(
                "SELECT launch FROM codex_scheduled_automations WHERE automation_id='saved-task'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(launch, "automatic");
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM core_automation_firings", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            prepare_profile_store(&mut connection, profile.path())
                .unwrap()
                .migrated_from_version,
            None
        );
    }

    #[test]
    fn migration_registry_covers_every_published_source_and_is_forward_only() {
        for format in nodex_store_format::PUBLISHED_STORE_FORMATS {
            if i64::from(format.revision) == CURRENT_STORE_REVISION {
                continue;
            }
            assert!(
                resolve_migration_path(
                    i64::from(format.revision),
                    CURRENT_STORE_REVISION,
                    MIGRATION_STEPS
                )
                .is_some(),
                "Published Store v{} has no upgrade path",
                format.revision
            );
        }
        for (index, step) in MIGRATION_STEPS.iter().enumerate() {
            assert!(step.from_revision < step.to_revision);
            if let Some(next) = MIGRATION_STEPS.get(index + 1) {
                assert_eq!(step.to_revision, next.from_revision);
            }
        }
        assert_eq!(MIGRATION_STEPS[0].from_revision, BASELINE_STORE_REVISION);
        assert_eq!(
            MIGRATION_STEPS.last().expect("migration tail").to_revision,
            CURRENT_STORE_REVISION
        );
    }
    #[test]
    fn frozen_v191_migrates_markdown_heads_history_and_projections_once() {
        use crate::infrastructure::document_repository::DocumentReadRepository;
        let profile = tempdir().unwrap();
        fs::write(
            profile.path().join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v191.db"),
        )
        .unwrap();
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        let old_epoch: String = connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let prepared = prepare_profile_store(&mut connection, profile.path()).unwrap();
        assert_eq!(prepared.migrated_from_version, Some(191));
        let backup_name: String = connection.query_row(
            "SELECT backup_name FROM core_store_migration_history WHERE source_revision=191 AND target_revision=192",
            [],
            |row| row.get(0),
        ).unwrap();
        let backups = profile.path().join("backups/core-migrations");
        validate_migration_backup(&backups.join(backup_name), 191)
            .expect("exact predecessor backup");

        let new_epoch: String = connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(old_epoch, new_epoch);
        let materialization = DocumentReadRepository::new(&connection)
            .materialization("88d43209-dfa6-7de3-83c3-7c33a5661d57")
            .unwrap()
            .unwrap();
        assert!(
            materialization
                .markdown
                .contains("<nodex://sessions/session%3Anative>")
        );
        let complete = connection.query_row("SELECT block_tree_json,markdown FROM document_materializations WHERE document_id=(SELECT id FROM documents WHERE id IN (SELECT document_id FROM document_versions) LIMIT 1)",[],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).unwrap();
        let blocks: Vec<crate::domain::block_materialization::MaterializedBlockNode> =
            serde_json::from_str(&complete.0).unwrap();
        let image = blocks
            .iter()
            .find(|block| block.block_type == "image")
            .expect("migrated image");
        assert!(!image.props.contains_key("backgroundColor"));
        assert_eq!(image.props["caption"], "A *literal* bold  caption\nnext");
        assert!(complete.1.contains("<nodex://sessions/session%3Aruntime>"));
        assert!(
            complete
                .1
                .contains("[Unbound chat](codex://threads/legacy%3Aunbound%20%2Fchat)")
        );
        assert!(
            blocks
                .iter()
                .all(|block| block.block_type != "threadSection")
        );
        assert!(
            blocks
                .iter()
                .any(|block| block.content.as_ref().is_some_and(|content| content
                    .as_array()
                    .is_some_and(|items| items
                        .iter()
                        .any(|item| item.get("text").and_then(serde_json::Value::as_str)
                            == Some("Kept child")))))
        );
        let (bytes, format): (Vec<u8>, String) = connection
            .query_row(
                "SELECT full_update_blob,checkpoint_format FROM document_versions LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let checkpoint: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(format, "block_tree_snapshot_v3");
        let retained: Vec<crate::domain::block_materialization::MaterializedBlockNode> =
            serde_json::from_value(checkpoint["blockTree"].clone()).unwrap();
        assert!(
            retained
                .iter()
                .all(|block| block.block_type != "threadSection")
        );
        assert_eq!(
            retained
                .iter()
                .find(|block| block.block_type == "image")
                .unwrap()
                .props["caption"],
            image.props["caption"]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT MIN(materialization_derivation_version) FROM document_materializations",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            4
        );
        validate_schema_identity(&connection, CURRENT_STORE_REVISION).unwrap();
        let fresh = tempdir().unwrap();
        let mut fresh_connection = open_writer(&fresh.path().join("nodex.db")).unwrap();
        prepare_profile_store(&mut fresh_connection, fresh.path()).unwrap();
        assert_eq!(
            crate::infrastructure::schema::read_schema_inventory(&connection).unwrap(),
            crate::infrastructure::schema::read_schema_inventory(&fresh_connection).unwrap()
        );
        assert_eq!(connection.query_row("SELECT count(*) FROM core_store_migration_history WHERE source_revision=191 AND target_revision=192",[],|row| row.get::<_,i64>(0)).unwrap(),1);
        let reopened = prepare_profile_store(&mut connection, profile.path()).unwrap();
        assert_eq!(reopened.migrated_from_version, None);
        assert_eq!(fs::read_dir(backups).unwrap().count(), 1);

        assert_eq!(
            connection
                .query_row(
                    "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            new_epoch
        );
    }
}
