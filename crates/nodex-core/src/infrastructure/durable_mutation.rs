//! The single lifecycle authority for semantic durable mutations.
//!
//! Domain modules own validation and canonical writes. This module owns the
//! cross-domain invariants that make those writes one replayable commit:
//! operation identity, receipt persistence, manifest sealing, and no-op
//! abandonment. Callers cannot successfully return a partially finalized
//! semantic commit.

use std::marker::PhantomData;

use nodex_core_contracts::events::{
    CommitManifest, DeliveryAuthorizationScope, RevokedResourceKind,
};
use nodex_core_contracts::{ApplyResponse, BoundModuleContext, ModuleName, StoreObservation};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::local_commit::{self, CommitContext};
use super::module_receipts::{
    NewModuleReceipt, StoredModuleReceipt, insert_module_receipt, read_module_receipt,
};
use super::sqlite::{StoreError, StoreErrorCode};
use super::visibility_delta_journal::VisibilityDeltaJournal;

#[derive(Clone, Copy)]
pub(crate) struct OperationIdentity<'a> {
    pub module: ModuleName,
    pub module_name: &'a str,
    pub operation_id: &'a str,
    pub intent_hash: &'a str,
    pub store_epoch: &'a str,
    pub committed_at: &'a str,
    pub context: &'a BoundModuleContext,
}

#[derive(Clone, Copy)]
pub(crate) struct ReplayIdentity<'a> {
    pub module: ModuleName,
    pub module_name: &'a str,
    pub operation_id: &'a str,
    pub intent_hash: &'a str,
    pub store_epoch: &'a str,
}

impl OperationIdentity<'_> {
    fn replay_identity(&self) -> ReplayIdentity<'_> {
        ReplayIdentity {
            module: self.module,
            module_name: self.module_name,
            operation_id: self.operation_id,
            intent_hash: self.intent_hash,
            store_epoch: self.store_epoch,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ReceiptMetadata<'a> {
    pub operation_kind: &'a str,
    pub event_sequence: Option<i64>,
    pub committed_at: &'a str,
}

/// A transaction-scoped capability. It deliberately exposes neither commit
/// allocation nor finalization. Domain repositories may borrow the physical
/// evidence token while they perform their own canonical writes.
pub(crate) struct DurableMutationScope<'connection> {
    connection: &'connection Connection,
    context: CommitContext,
    module: ModuleName,
    visibility_journal: VisibilityDeltaJournal,
}

/// A resource that was visible through one exact authorization scope before a
/// mutation began. The transaction-owned visibility journal derives these
/// observations mechanically from raw authority-table facts; domain writers
/// consume them only when compiling projection audience evidence.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct AuthorizedResourceObservation {
    pub authorization_scope: DeliveryAuthorizationScope,
    pub resource_kind: RevokedResourceKind,
    pub resource_id: String,
}

impl<'connection> DurableMutationScope<'connection> {
    pub(crate) fn connection(&self) -> &'connection Connection {
        self.connection
    }

    pub(crate) fn evidence(&self) -> &CommitContext {
        &self.context
    }

    pub(crate) fn commit_seq(&self) -> i64 {
        self.context.commit_seq()
    }

    pub(crate) fn store_epoch(&self) -> &str {
        self.context.store_epoch()
    }

    pub(crate) fn committed_at(&self) -> &str {
        self.context.committed_at()
    }

    pub(crate) fn authorization_before(
        &self,
    ) -> Result<Vec<AuthorizedResourceObservation>, StoreError> {
        self.visibility_journal
            .authorization_before(self.connection, &self.context)
    }

    pub(crate) fn seal<T>(&self, outcome: T, receipt: ReceiptMetadata<'_>) -> SealedOutcome<T> {
        SealedOutcome {
            outcome,
            receipt: OwnedReceiptMetadata {
                operation_kind: receipt.operation_kind.to_owned(),
                event_sequence: receipt.event_sequence,
                committed_at: receipt.committed_at.to_owned(),
            },
            disposition: Disposition::Commit,
            module: self.module,
            _sealed: PhantomData,
        }
    }

    pub(crate) fn no_op<T>(&self, outcome: T, receipt: ReceiptMetadata<'_>) -> SealedOutcome<T> {
        SealedOutcome {
            outcome,
            receipt: OwnedReceiptMetadata {
                operation_kind: receipt.operation_kind.to_owned(),
                event_sequence: receipt.event_sequence,
                committed_at: receipt.committed_at.to_owned(),
            },
            disposition: Disposition::NoOp,
            module: self.module,
            _sealed: PhantomData,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Disposition {
    Commit,
    NoOp,
}

struct OwnedReceiptMetadata {
    operation_kind: String,
    event_sequence: Option<i64>,
    committed_at: String,
}

/// Only `DurableMutationScope` can construct this value. Returning ordinary
/// `T` from a mutation closure is therefore insufficient to commit.
#[must_use = "a durable mutation must return its sealed outcome"]
pub(crate) struct SealedOutcome<T> {
    outcome: T,
    receipt: OwnedReceiptMetadata,
    disposition: Disposition,
    module: ModuleName,
    _sealed: PhantomData<fn() -> T>,
}

impl<T> SealedOutcome<T> {
    pub(crate) fn into_outcome(self) -> T {
        self.outcome
    }
}

#[derive(Debug)]
#[must_use = "a durable mutation result must be admitted or returned"]
pub(crate) enum CommitResult<T> {
    Committed {
        outcome: T,
        manifest: CommitManifest,
    },
    IdempotentReplay {
        outcome: T,
        manifest: Option<CommitManifest>,
    },
    NoOp {
        outcome: T,
    },
}

impl<T> CommitResult<T> {
    pub(crate) fn verify_manifest_identity(
        &self,
        identity: impl FnOnce(&T) -> (i64, String),
    ) -> Result<(), StoreError> {
        let (outcome, manifest) = match self {
            Self::Committed { outcome, manifest } => (outcome, Some(manifest)),
            Self::IdempotentReplay { outcome, manifest } => (outcome, manifest.as_ref()),
            Self::NoOp { .. } => return Ok(()),
        };
        let Some(manifest) = manifest else {
            return Ok(());
        };
        let (commit_seq, store_epoch) = identity(outcome);
        if manifest.identity.commit_seq == commit_seq
            && manifest.identity.store_epoch.0 == store_epoch
        {
            return Ok(());
        }
        Err(corrupt(
            "Durable mutation outcome and manifest identity diverge",
        ))
    }
}

pub(crate) fn run<T>(
    connection: &Connection,
    identity: OperationIdentity<'_>,
    apply: impl FnOnce(&DurableMutationScope<'_>) -> Result<SealedOutcome<T>, StoreError>,
) -> Result<CommitResult<T>, StoreError>
where
    T: DeserializeOwned + Serialize,
{
    if connection.is_autocommit() {
        return Err(internal(
            "Durable mutation requires an active SQLite write transaction",
        ));
    }
    validate_module_identity(identity.module, identity.module_name)?;
    if let Some(replayed) = replay_existing(connection, identity.replay_identity())? {
        return Ok(replayed);
    }

    let context = local_commit::allocate(
        connection,
        identity.store_epoch,
        identity.operation_id,
        identity.intent_hash,
        identity.committed_at,
    )?;
    let visibility_journal = VisibilityDeltaJournal::begin(connection, &context)?;
    let scope = DurableMutationScope {
        connection,
        context,
        module: identity.module,
        visibility_journal,
    };
    let sealed = apply(&scope)?;
    if sealed.module != identity.module {
        return Err(corrupt(
            "Durable mutation outcome changed its owning Module",
        ));
    }
    if sealed.receipt.committed_at != identity.committed_at {
        return Err(corrupt(
            "Durable mutation receipt timestamp diverges from its identity",
        ));
    }
    if sealed.disposition == Disposition::NoOp && sealed.receipt.event_sequence.is_some() {
        return Err(corrupt(
            "Durable mutation no-op references a physical event",
        ));
    }

    let encoded = serde_json::to_value(&sealed.outcome)
        .map_err(|_| internal("Durable mutation outcome could not be encoded"))?;
    match sealed.disposition {
        Disposition::Commit => {
            insert_module_receipt(
                connection,
                NewModuleReceipt {
                    module_name: identity.module_name,
                    operation_id: identity.operation_id,
                    context: identity.context,
                    operation_kind: &sealed.receipt.operation_kind,
                    store_epoch: identity.store_epoch,
                    request_hash: identity.intent_hash,
                    result: &encoded,
                    event_sequence: sealed.receipt.event_sequence,
                    local_commit: Some(&scope.context),
                    committed_at: &sealed.receipt.committed_at,
                },
            )?;
            scope
                .visibility_journal
                .finalize(connection, &scope.context)?;
            let commit_seq = local_commit::seal(connection, &scope.context)?;
            let manifest = local_commit::read_manifest(connection, commit_seq)?;
            Ok(CommitResult::Committed {
                outcome: sealed.outcome,
                manifest,
            })
        }
        Disposition::NoOp => {
            scope
                .visibility_journal
                .finish_no_op(connection, &scope.context)?;
            local_commit::abandon(connection, &scope.context)?;
            insert_module_receipt(
                connection,
                NewModuleReceipt {
                    module_name: identity.module_name,
                    operation_id: identity.operation_id,
                    context: identity.context,
                    operation_kind: &sealed.receipt.operation_kind,
                    store_epoch: identity.store_epoch,
                    request_hash: identity.intent_hash,
                    result: &encoded,
                    event_sequence: None,
                    local_commit: None,
                    committed_at: &sealed.receipt.committed_at,
                },
            )?;
            Ok(CommitResult::NoOp {
                outcome: sealed.outcome,
            })
        }
    }
}

pub(crate) fn record_no_op<T: Serialize>(
    connection: &Connection,
    identity: OperationIdentity<'_>,
    outcome: &T,
    receipt: ReceiptMetadata<'_>,
) -> Result<(), StoreError> {
    if receipt.event_sequence.is_some() || receipt.committed_at != identity.committed_at {
        return Err(corrupt("Durable mutation no-op receipt is inconsistent"));
    }
    validate_module_identity(identity.module, identity.module_name)?;
    let context = local_commit::allocate(
        connection,
        identity.store_epoch,
        identity.operation_id,
        identity.intent_hash,
        identity.committed_at,
    )?;
    let visibility_journal = VisibilityDeltaJournal::begin(connection, &context)?;
    visibility_journal.finish_no_op(connection, &context)?;
    local_commit::abandon(connection, &context)?;
    let encoded = serde_json::to_value(outcome)
        .map_err(|_| internal("Durable mutation no-op outcome could not be encoded"))?;
    insert_module_receipt(
        connection,
        NewModuleReceipt {
            module_name: identity.module_name,
            operation_id: identity.operation_id,
            context: identity.context,
            operation_kind: receipt.operation_kind,
            store_epoch: identity.store_epoch,
            request_hash: identity.intent_hash,
            result: &encoded,
            event_sequence: None,
            local_commit: None,
            committed_at: receipt.committed_at,
        },
    )
}

pub(crate) fn replay_existing<T>(
    connection: &Connection,
    identity: ReplayIdentity<'_>,
) -> Result<Option<CommitResult<T>>, StoreError>
where
    T: DeserializeOwned,
{
    validate_module_identity(identity.module, identity.module_name)?;
    let Some(stored) =
        read_module_receipt(connection, identity.module_name, identity.operation_id)?
    else {
        return Ok(None);
    };
    replay_stored(connection, identity, stored).map(Some)
}

fn replay_stored<T>(
    connection: &Connection,
    identity: ReplayIdentity<'_>,
    stored: StoredModuleReceipt,
) -> Result<CommitResult<T>, StoreError>
where
    T: DeserializeOwned,
{
    if stored.store_epoch != identity.store_epoch || stored.request_hash != identity.intent_hash {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            "operation_id is already bound to another durable mutation intent",
            false,
        ));
    }
    let outcome = serde_json::from_value(stored.result)
        .map_err(|_| corrupt("Stored durable mutation outcome is invalid"))?;
    let manifest = match stored.local_commit_seq {
        Some(commit_seq)
            if connection
                .query_row(
                    "SELECT 1 FROM local_commits WHERE store_epoch = ?1 AND commit_seq = ?2",
                    rusqlite::params![identity.store_epoch, commit_seq],
                    |_| Ok(()),
                )
                .optional()?
                .is_some() =>
        {
            Some(local_commit::read_manifest(connection, commit_seq)?)
        }
        _ => None,
    };
    Ok(CommitResult::IdempotentReplay { outcome, manifest })
}

/// Converts the private writer result stored in a module receipt into the
/// closed public command result used by preparation replay endpoints. Delivery
/// remains absent here because preparation is a read; the apply fast path and
/// durable stream resolve post-state authorization independently.
pub(crate) fn replay_apply_response<T, R>(
    connection: &Connection,
    local_commit_seq: Option<i64>,
    committed: crate::ModuleWriterResult<T, R>,
) -> Result<ApplyResponse<T, R>, StoreError> {
    let crate::ModuleWriterResult {
        value: outcome,
        receipt,
        commit_seq: observed_commit_head,
        store_epoch,
        ..
    } = committed;
    let Some(commit_seq) = local_commit_seq else {
        return Ok(ApplyResponse::NoOp {
            outcome,
            receipt,
            observed: StoreObservation {
                store_epoch,
                commit_head: observed_commit_head,
            },
        });
    };
    let commit = local_commit::read_manifest(connection, commit_seq)?.identity;
    if commit.commit_seq != observed_commit_head || commit.store_epoch != store_epoch {
        return Err(corrupt(
            "Stored command replay diverges from its manifest identity",
        ));
    }
    Ok(ApplyResponse::Committed {
        outcome,
        receipt,
        commit,
        delivery: None,
    })
}

fn validate_module_identity(module: ModuleName, stored_name: &str) -> Result<(), StoreError> {
    if module_name(module) != stored_name {
        return Err(corrupt(
            "Durable mutation Module enum and storage identity diverge",
        ));
    }
    Ok(())
}

fn module_name(module: ModuleName) -> &'static str {
    match module {
        ModuleName::Library => "library",
        ModuleName::Database => "database",
        ModuleName::OwnedDocument => "owned_document",
        ModuleName::ProjectWorkspace => "project_workspace",
        ModuleName::Automation => "automation",
        ModuleName::StoreAdministration => "store_administration",
    }
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use nodex_core_contracts::{AdapterKind, LibraryId, ProfileId, ProjectId, ProjectionImpact};
    use rusqlite::OptionalExtension;
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    struct TestOutcome {
        operation_id: String,
        commit_seq: i64,
    }

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile:durable-mutation".to_owned()),
            library_id: LibraryId("library:durable-mutation".to_owned()),
            project_id: Some(ProjectId("project:durable-mutation".to_owned())),
            connection_id: "connection:durable-mutation".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn seed(connection: &Connection) -> Result<String, StoreError> {
        let store_epoch = connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| "epoch:durable-mutation".to_owned());
        connection.execute(
            "INSERT OR IGNORE INTO block_store_metadata(
               id, store_epoch, created_at, updated_at
             ) VALUES (1, ?1, '2026-08-07', '2026-08-07')",
            [&store_epoch],
        )?;
        connection.execute_batch(
            "INSERT INTO profiles(id, created_at, updated_at)
             VALUES ('profile:durable-mutation', '2026-08-07', '2026-08-07');
             INSERT INTO libraries(id, profile_id, created_at, updated_at)
             VALUES (
               'library:durable-mutation', 'profile:durable-mutation',
               '2026-08-07', '2026-08-07'
             );
             INSERT INTO projects(id, library_id, name, created, updated)
             VALUES (
               'project:durable-mutation', 'library:durable-mutation',
               'Durable mutation', '2026-08-07', '2026-08-07'
             );",
        )?;
        Ok(store_epoch)
    }

    fn apply_test_mutation(
        connection: &Connection,
        context: &BoundModuleContext,
        store_epoch: &str,
        operation_id: &str,
        intent_hash: &str,
        executions: &AtomicUsize,
    ) -> Result<CommitResult<TestOutcome>, StoreError> {
        run(
            connection,
            OperationIdentity {
                module: ModuleName::Database,
                module_name: "database",
                operation_id,
                intent_hash,
                store_epoch,
                committed_at: "2026-08-07T00:00:00Z",
                context,
            },
            |scope| {
                executions.fetch_add(1, Ordering::SeqCst);
                let payload = json!({
                    "module": "database",
                    "kind": "database_changed",
                    "projectId": "project:durable-mutation",
                    "databaseIds": [],
                    "dataSourceIds": [],
                    "pageIds": [],
                    "viewIds": [],
                });
                let payload_json = serde_json::to_string(&payload)
                    .map_err(|_| internal("test payload encoding"))?;
                let event_sequence = append_change_log(
                    scope.connection(),
                    NewChangeLogEntry {
                        project_id: "project:durable-mutation",
                        store_epoch,
                        kind: "database.changed",
                        operation_id: Some(operation_id),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: &payload_json,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                    scope.evidence(),
                )?;
                Ok(scope.seal(
                    TestOutcome {
                        operation_id: operation_id.to_owned(),
                        commit_seq: scope.commit_seq(),
                    },
                    ReceiptMetadata {
                        operation_kind: "test",
                        event_sequence: Some(event_sequence),
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                ))
            },
        )
    }

    fn apply_test_no_op(
        connection: &Connection,
        context: &BoundModuleContext,
        store_epoch: &str,
        operation_id: &str,
        intent_hash: &str,
        executions: &AtomicUsize,
    ) -> Result<CommitResult<TestOutcome>, StoreError> {
        run(
            connection,
            OperationIdentity {
                module: ModuleName::Database,
                module_name: "database",
                operation_id,
                intent_hash,
                store_epoch,
                committed_at: "2026-08-07T00:00:00Z",
                context,
            },
            |scope| {
                executions.fetch_add(1, Ordering::SeqCst);
                Ok(scope.no_op(
                    TestOutcome {
                        operation_id: operation_id.to_owned(),
                        commit_seq: local_commit::head(connection)?,
                    },
                    ReceiptMetadata {
                        operation_kind: "test_no_op",
                        event_sequence: None,
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                ))
            },
        )
    }

    #[test]
    fn same_operation_and_intent_replays_the_original_manifest_without_reapplying() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let executions = AtomicUsize::new(0);
        kernel
            .writer()
            .call(move |connection| {
                let store_epoch = seed(connection)?;
                let context = context();
                let intent_hash = crate::document::sha256(b"same intent");
                let first = with_immediate_transaction(connection, |transaction| {
                    apply_test_mutation(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-replay",
                        &intent_hash,
                        &executions,
                    )
                })?;
                let replay = with_immediate_transaction(connection, |transaction| {
                    apply_test_mutation(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-replay",
                        &intent_hash,
                        &executions,
                    )
                })?;
                let CommitResult::Committed {
                    outcome: first_outcome,
                    manifest: first_manifest,
                } = first
                else {
                    panic!("first mutation must commit");
                };
                let CommitResult::IdempotentReplay {
                    outcome: replay_outcome,
                    manifest: Some(replay_manifest),
                } = replay
                else {
                    panic!("second mutation must replay");
                };
                assert_eq!(first_outcome, replay_outcome);
                assert_eq!(first_manifest, replay_manifest);
                assert_eq!(executions.load(Ordering::SeqCst), 1);
                Ok(())
            })
            .expect("durable replay");
    }

    #[test]
    fn exact_no_op_replay_keeps_its_original_observation_after_a_later_commit() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                let store_epoch = seed(connection)?;
                let context = context();
                let no_op_hash = crate::document::sha256(b"no-op intent");
                let no_op_executions = AtomicUsize::new(0);
                let first = with_immediate_transaction(connection, |transaction| {
                    apply_test_no_op(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-no-op",
                        &no_op_hash,
                        &no_op_executions,
                    )
                })?;
                let CommitResult::NoOp {
                    outcome: first_outcome,
                } = first
                else {
                    panic!("first mutation must be a no-op");
                };

                let committed_executions = AtomicUsize::new(0);
                with_immediate_transaction(connection, |transaction| {
                    apply_test_mutation(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-after-no-op",
                        &crate::document::sha256(b"later intent"),
                        &committed_executions,
                    )
                    .map(|_| ())
                })?;

                let replay = with_immediate_transaction(connection, |transaction| {
                    apply_test_no_op(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-no-op",
                        &no_op_hash,
                        &no_op_executions,
                    )
                })?;
                replay.verify_manifest_identity(|outcome| {
                    (outcome.commit_seq, store_epoch.clone())
                })?;
                let CommitResult::IdempotentReplay {
                    outcome: replay_outcome,
                    manifest: None,
                } = replay
                else {
                    panic!("no-op retry must replay without a Manifest");
                };
                assert_eq!(replay_outcome, first_outcome);
                assert_eq!(no_op_executions.load(Ordering::SeqCst), 1);
                assert_eq!(committed_executions.load(Ordering::SeqCst), 1);
                Ok(())
            })
            .expect("durable no-op replay");
    }

    #[test]
    fn intent_collision_fails_closed_and_failed_closure_rolls_back_all_evidence() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                let store_epoch = seed(connection)?;
                let context = context();
                let first_hash = crate::document::sha256(b"first intent");
                let second_hash = crate::document::sha256(b"second intent");
                let executions = AtomicUsize::new(0);
                with_immediate_transaction(connection, |transaction| {
                    apply_test_mutation(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-collision",
                        &first_hash,
                        &executions,
                    )
                    .map(|_| ())
                })?;
                let collision = with_immediate_transaction(connection, |transaction| {
                    apply_test_mutation(
                        transaction,
                        &context,
                        &store_epoch,
                        "operation:durable-collision",
                        &second_hash,
                        &executions,
                    )
                    .map(|_| ())
                })
                .expect_err("intent collision must fail");
                assert_eq!(collision.code, StoreErrorCode::IdempotencyKeyReused);

                connection.execute_batch(
                    "CREATE TABLE durable_mutation_fault_marker(id TEXT PRIMARY KEY);",
                )?;
                let failed = with_immediate_transaction(connection, |transaction| {
                    run::<TestOutcome>(
                        transaction,
                        OperationIdentity {
                            module: ModuleName::Database,
                            module_name: "database",
                            operation_id: "operation:durable-fault",
                            intent_hash: &crate::document::sha256(b"fault"),
                            store_epoch: &store_epoch,
                            committed_at: "2026-08-07T00:00:00Z",
                            context: &context,
                        },
                        |scope| {
                            scope.connection().execute(
                                "INSERT INTO durable_mutation_fault_marker(id) VALUES ('fault')",
                                [],
                            )?;
                            Err(StoreError::new(
                                StoreErrorCode::Internal,
                                "injected durable mutation fault",
                                true,
                            ))
                        },
                    )
                    .map(|_| ())
                })
                .expect_err("fault must rollback");
                assert_eq!(failed.code, StoreErrorCode::Internal);
                let marker_count: i64 = connection.query_row(
                    "SELECT count(*) FROM durable_mutation_fault_marker",
                    [],
                    |row| row.get(0),
                )?;
                let orphan_count: i64 = connection.query_row(
                    "SELECT count(*) FROM local_commits
                     WHERE operation_id = 'operation:durable-fault'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!((marker_count, orphan_count), (0, 0));
                Ok(())
            })
            .expect("durable fault closure");
    }

    #[test]
    fn durable_mutation_rejects_autocommit_before_allocating_evidence() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                let store_epoch = seed(connection)?;
                let error = run::<TestOutcome>(
                    connection,
                    OperationIdentity {
                        module: ModuleName::Database,
                        module_name: "database",
                        operation_id: "operation:autocommit",
                        intent_hash: &crate::document::sha256(b"autocommit"),
                        store_epoch: &store_epoch,
                        committed_at: "2026-08-07T00:00:00Z",
                        context: &context(),
                    },
                    |_| unreachable!("autocommit must be rejected before apply"),
                )
                .expect_err("semantic mutation requires an owned write transaction");
                assert_eq!(error.code, StoreErrorCode::Internal);
                let parent_count: i64 = connection.query_row(
                    "SELECT count(*) FROM local_commits
                     WHERE operation_id = 'operation:autocommit'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(parent_count, 0);
                Ok(())
            })
            .expect("autocommit boundary proof");
    }
}
