use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::document::DocumentRuntimeCache;

use super::event_log::validate_local_commit_index;
use super::migration::{
    CurrentStoreValidation, StorePreparation, StorePreparationEvent, StoreValidationDisposition,
    prepare_profile_store_with_validation,
};
#[cfg(test)]
use super::schema::CURRENT_STORE_REVISION;
use super::sqlite::{StoreError, StoreErrorCode, open_writer, optimize_query_planner_on_open};
use super::store_lock::ProfileStoreLock;
use super::store_replacement::recover_interrupted_store_replacement;
use super::store_validation_receipt::{self, ConsumedStoreValidationReceipt};
use super::writer::{
    DEFAULT_READ_CONNECTIONS, DEFAULT_WRITER_QUEUE_CAPACITY, StoreMaintenance, StoreReaders,
    StoreRuntime, StoreRuntimeActivity, StoreRuntimeMetrics, StoreWriter,
};

pub const STORE_FILE_NAME: &str = "nodex.db";

pub use super::store_validation_receipt::StoreValidationReceipt;

pub struct SqliteStoreKernel {
    preparation: StorePreparation,
    runtime: StoreRuntime,
    _lock: ProfileStoreLock,
    database_path: PathBuf,
    document_runtime_cache: Arc<Mutex<DocumentRuntimeCache>>,
}

impl SqliteStoreKernel {
    pub fn open(profile_home: &Path) -> Result<Self, StoreError> {
        Self::open_with_observer(profile_home, |_| {})
    }

    #[cfg(test)]
    pub fn open_test(profile_home: &Path) -> Result<Self, StoreError> {
        let lock = ProfileStoreLock::acquire(profile_home)?;
        let database_path = profile_home.join(STORE_FILE_NAME);
        let mut connection = open_writer(&database_path)?;
        super::migration::prepare_test_current_store(&mut connection, profile_home)?;
        if let Err(error) = optimize_query_planner_on_open(&connection) {
            tracing::warn!(
                error = %error,
                "SQLite query planner maintenance failed while opening the Store"
            );
        }
        drop(connection);
        Self::start_runtime(
            database_path,
            StorePreparation {
                schema_version: CURRENT_STORE_REVISION,
                created_fresh: false,
                migrated_from_version: None,
                validation: StoreValidationDisposition::Deep,
            },
            lock,
        )
    }

    pub fn open_with_observer(
        profile_home: &Path,
        mut observer: impl FnMut(StorePreparationEvent),
    ) -> Result<Self, StoreError> {
        let open_started_at = Instant::now();
        let lock = ProfileStoreLock::acquire(profile_home)?;
        let receipt = match store_validation_receipt::consume(profile_home)? {
            ConsumedStoreValidationReceipt::Absent => None,
            ConsumedStoreValidationReceipt::Rejected { reason } => {
                tracing::warn!(
                    reason,
                    "Store validation receipt was rejected; running full validation"
                );
                None
            }
            ConsumedStoreValidationReceipt::Trusted(receipt) => Some(receipt),
        };
        recover_interrupted_store_replacement(profile_home)?;
        let database_path = profile_home.join(STORE_FILE_NAME);
        if fs::symlink_metadata(&database_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Profile database must not be a symlink",
                false,
            ));
        }
        let mut migration_connection = open_writer(&database_path)?;
        let preparation_started_at = Instant::now();
        let preparation = prepare_profile_store_with_validation(
            &mut migration_connection,
            profile_home,
            &mut observer,
            receipt.as_ref().map_or(
                CurrentStoreValidation::Deep,
                CurrentStoreValidation::TrustedReceipt,
            ),
        )?;
        tracing::info!(
            durationMs = duration_millis(preparation_started_at.elapsed()),
            validation = ?preparation.validation,
            "Store preparation completed"
        );
        if preparation.validation == StoreValidationDisposition::Deep {
            let local_commit_validation_started_at = Instant::now();
            validate_local_commit_index(&migration_connection)?;
            tracing::info!(
                durationMs = duration_millis(local_commit_validation_started_at.elapsed()),
                "LocalCommit index validation completed"
            );
            let planner_maintenance_started_at = Instant::now();
            if let Err(error) = optimize_query_planner_on_open(&migration_connection) {
                tracing::warn!(
                    error = %error,
                    "SQLite query planner maintenance failed after full Store validation"
                );
            }
            tracing::info!(
                durationMs = duration_millis(planner_maintenance_started_at.elapsed()),
                "SQLite query planner maintenance completed"
            );
        }
        drop(migration_connection);
        let runtime_started_at = Instant::now();
        let store = Self::start_runtime(database_path, preparation, lock)?;
        tracing::info!(
            durationMs = duration_millis(runtime_started_at.elapsed()),
            totalMs = duration_millis(open_started_at.elapsed()),
            validation = ?store.preparation.validation,
            "Store runtime started"
        );
        Ok(store)
    }

    fn start_runtime(
        database_path: PathBuf,
        preparation: StorePreparation,
        lock: ProfileStoreLock,
    ) -> Result<Self, StoreError> {
        let runtime = StoreRuntime::start(
            &database_path,
            DEFAULT_WRITER_QUEUE_CAPACITY,
            DEFAULT_READ_CONNECTIONS,
        )?;
        Ok(Self {
            preparation,
            runtime,
            _lock: lock,
            database_path,
            document_runtime_cache: Arc::new(Mutex::new(DocumentRuntimeCache::new())),
        })
    }

    pub fn preparation(&self) -> &StorePreparation {
        &self.preparation
    }

    pub fn writer(&self) -> StoreWriter {
        self.runtime.writer()
    }

    pub fn readers(&self) -> StoreReaders {
        self.runtime.readers()
    }

    pub fn maintenance(&self) -> StoreMaintenance {
        self.runtime.maintenance()
    }

    pub fn activity(&self) -> StoreRuntimeActivity {
        self.runtime.activity()
    }

    pub fn metrics(&self) -> StoreRuntimeMetrics {
        self.runtime.metrics()
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn clean_shutdown_validation_receipt(&self) -> Result<StoreValidationReceipt, StoreError> {
        self.readers()
            .read_default(|connection| store_validation_receipt::current(connection))
    }

    pub(crate) fn document_runtime_cache(&self) -> Arc<Mutex<DocumentRuntimeCache>> {
        Arc::clone(&self.document_runtime_cache)
    }
}

pub fn persist_clean_shutdown_validation_receipt(
    profile_home: &Path,
    receipt: &StoreValidationReceipt,
) -> Result<(), StoreError> {
    store_validation_receipt::persist(profile_home, receipt)
}

fn duration_millis(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn test_store_template_remints_profile_secrets() {
        let first_home = tempdir().expect("first Profile");
        let second_home = tempdir().expect("second Profile");
        let first = SqliteStoreKernel::open_test(first_home.path()).expect("first test Store");
        let second = SqliteStoreKernel::open_test(second_home.path()).expect("second test Store");

        let first_secrets = read_profile_secrets(&first);
        let second_secrets = read_profile_secrets(&second);

        assert_ne!(first_secrets.0, second_secrets.0);
        assert_ne!(first_secrets.1, second_secrets.1);
    }

    #[test]
    fn clean_shutdown_receipt_allows_one_trusted_reopen_then_expires() {
        let directory = tempdir().expect("Profile");
        let first = SqliteStoreKernel::open(directory.path()).expect("first Store open");
        assert_eq!(
            first.preparation().validation,
            StoreValidationDisposition::Deep
        );
        initialize_store_epoch(&first);
        let receipt = first
            .clean_shutdown_validation_receipt()
            .expect("clean shutdown validation receipt");
        persist_clean_shutdown_validation_receipt(directory.path(), &receipt)
            .expect("persist clean shutdown receipt");
        drop(first);

        let trusted = SqliteStoreKernel::open(directory.path()).expect("trusted Store reopen");
        assert_eq!(
            trusted.preparation().validation,
            StoreValidationDisposition::TrustedReceipt
        );
        drop(trusted);

        let recovered =
            SqliteStoreKernel::open(directory.path()).expect("crash recovery Store open");
        assert_eq!(
            recovered.preparation().validation,
            StoreValidationDisposition::Deep
        );
    }

    #[test]
    fn stale_clean_shutdown_receipt_requires_deep_validation() {
        let directory = tempdir().expect("Profile");
        let first = SqliteStoreKernel::open(directory.path()).expect("first Store open");
        initialize_store_epoch(&first);
        let receipt = first
            .clean_shutdown_validation_receipt()
            .expect("clean shutdown validation receipt");
        persist_clean_shutdown_validation_receipt(directory.path(), &receipt)
            .expect("persist clean shutdown receipt");
        drop(first);

        let connection = open_writer(&directory.path().join(STORE_FILE_NAME))
            .expect("open Store to simulate replacement");
        connection
            .execute(
                "UPDATE block_store_metadata SET store_epoch = 'replaced-epoch' WHERE id = 1",
                [],
            )
            .expect("simulate Store replacement");
        drop(connection);

        let reopened = SqliteStoreKernel::open(directory.path()).expect("reopen replaced Store");
        assert_eq!(
            reopened.preparation().validation,
            StoreValidationDisposition::Deep
        );
    }

    fn initialize_store_epoch(kernel: &SqliteStoreKernel) {
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                     VALUES (1, 'test-epoch', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("initialize Store epoch");
    }

    fn read_profile_secrets(kernel: &SqliteStoreKernel) -> (Vec<u8>, String) {
        kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT token.key_material, runtime.jitter_salt \
                         FROM nodex_agent_token_keys token \
                         CROSS JOIN core_automation_runtime_metadata runtime \
                         WHERE token.id = 1 AND runtime.id = 1",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("profile secrets")
    }
}
