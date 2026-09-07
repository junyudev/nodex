//! One authorized observation across public content relations. Domain readers
//! own data semantics; this Module owns SQL execution, snapshots and budgets.
mod engine;
mod provider;
mod schema;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, core_error};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::writer::{StoreReadSnapshot, StoreReaders};
use crate::library::query::PageSearchIndexRegistry;
use nodex_core_contracts::query::{QueryRead, QueryReadValue};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CoreError, ModuleReadRequest, ModuleReadSnapshot,
    QUERY_CONTRACT_VERSION, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::{Arc, Mutex};

const MAX_INPUT_ROWS: usize = 100_000;
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;

pub struct QueryModule {
    profile_id: String,
    library_id: String,
    readers: StoreReaders,
    page_search: Arc<PageSearchIndexRegistry>,
}
impl QueryModule {
    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            readers: kernel.readers(),
            page_search: Arc::new(PageSearchIndexRegistry::default()),
        }
    }

    /// Share the Library-owned search cache without sharing query state.
    pub fn with_library(mut self, library: &crate::library::LibraryModule) -> Self {
        self.page_search = Arc::new(library.query_search_registry());
        self
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<QueryRead>,
    ) -> Result<ModuleReadSnapshot<QueryReadValue>, CoreError> {
        self.read_inner(context, request).map_err(core_error)
    }

    fn read_inner(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<QueryRead>,
    ) -> Result<ModuleReadSnapshot<QueryReadValue>, StoreError> {
        if request.contract_version != QUERY_CONTRACT_VERSION {
            return Err(invalid("Unsupported public Query contract version"));
        }
        if context.profile_id.0 != self.profile_id
            || context.library_id.0 != self.library_id
            || context.project_id.is_none()
            || !matches!(
                context.adapter,
                AdapterKind::NativeCli | AdapterKind::ElectronHost | AdapterKind::Test
            )
        {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Public queries require a bound Project in this Profile",
                false,
            ));
        }
        if let QueryRead::Query { query } = &request.read {
            engine::validate(query)?;
        }
        let store = self.readers.snapshot()?;
        let (store_epoch, commit_head) = store.read(|connection| {
            let present = connection
                .query_row(
                    "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
                    params![self.library_id, self.profile_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !present {
                return Err(StoreError::new(
                    StoreErrorCode::Unauthorized,
                    "Bound Library is unavailable",
                    false,
                ));
            }
            crate::database::authorization::project_primary_database(
                connection,
                &self.library_id,
                &context.project_id.as_ref().expect("validated Project").0,
            )?;
            Ok((
                crate::document::read_store_epoch(connection)?,
                crate::infrastructure::local_commit::head(connection)?,
            ))
        })?;
        let snapshot = Arc::new(Snapshot {
            store,
            context: context.clone(),
            store_epoch: store_epoch.clone(),
            commit_head,
            page_search: self.page_search.clone(),
            budget: Mutex::new(Budget::default()),
            #[cfg(test)]
            stats: Mutex::new(QueryStats::default()),
            error: Mutex::new(None),
        });
        let value = match request.read {
            QueryRead::Schema { scope, relation } => QueryReadValue::Schema {
                value: provider::describe(&snapshot, scope, relation.as_deref())?,
            },
            QueryRead::Query { query } => QueryReadValue::Query {
                value: engine::execute(snapshot, query)?,
            },
        };
        Ok(ModuleReadSnapshot {
            contract_version: QUERY_CONTRACT_VERSION,
            store_epoch: StoreEpoch(store_epoch),
            commit_head,
            authorization: None,
            value,
        })
    }
}

#[derive(Default)]
struct Budget {
    rows: usize,
    bytes: usize,
}
#[cfg(test)]
#[derive(Clone, Debug, Default)]
pub(crate) struct QueryStats {
    pub document_loads: usize,
    pub metadata_loads: usize,
    pub source_rows: usize,
    pub search_calls: usize,
}
struct Snapshot {
    store: Arc<StoreReadSnapshot>,
    context: BoundModuleContext,
    store_epoch: String,
    commit_head: i64,
    page_search: Arc<PageSearchIndexRegistry>,
    budget: Mutex<Budget>,
    #[cfg(test)]
    stats: Mutex<QueryStats>,
    error: Mutex<Option<StoreError>>,
}
impl Snapshot {
    fn read<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.store.read(operation)
    }
    fn library<'a>(
        &'a self,
        connection: &'a Connection,
    ) -> crate::library::query::QueryContext<'a> {
        crate::library::query::QueryContext {
            connection,
            library_id: &self.context.library_id.0,
            store_epoch: &self.store_epoch,
            commit_head: self.commit_head,
            context: &self.context,
            page_search: &self.page_search,
        }
    }
    fn database<'a>(
        &'a self,
        connection: &'a Connection,
    ) -> crate::database::query::QueryContext<'a> {
        crate::database::query::QueryContext {
            connection,
            library_id: &self.context.library_id.0,
            commit_head: self.commit_head,
            context: &self.context,
        }
    }
    fn check_interruption(&self) -> Result<(), StoreError> {
        if self.store.cancellation.is_cancelled() {
            return Err(StoreError::new(
                StoreErrorCode::QueryCancelled,
                "Public query cancelled",
                true,
            ));
        }
        if std::time::Instant::now() >= self.store.deadline {
            return Err(StoreError::new(
                StoreErrorCode::DeadlineExceeded,
                "Public query deadline exceeded; narrow the query scope",
                true,
            ));
        }
        crate::infrastructure::request_execution::check_request_interruption()
    }
    fn charge(&self, rows: usize, bytes: usize) -> Result<(), StoreError> {
        self.check_interruption()?;
        let mut budget = self
            .budget
            .lock()
            .map_err(|_| invalid("Query budget lock unavailable"))?;
        budget.rows = budget.rows.saturating_add(rows);
        budget.bytes = budget.bytes.saturating_add(bytes);
        if budget.rows > MAX_INPUT_ROWS || budget.bytes > MAX_INPUT_BYTES {
            return Err(exhausted(
                "Public SQL input budget exceeded; reduce the query scope; no partial result returned",
            ));
        }
        Ok(())
    }
    fn callback_error(&self, error: StoreError) -> rusqlite::Error {
        if let Ok(mut first) = self.error.lock()
            && first.is_none()
        {
            *first = Some(error.clone());
        }
        rusqlite::Error::ModuleError(error.message)
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn exhausted(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

#[cfg(test)]
pub(crate) fn execute_test_snapshot(
    store: Arc<StoreReadSnapshot>,
    context: BoundModuleContext,
    query: nodex_core_contracts::sql::SqlQuery,
) -> Result<nodex_core_contracts::sql::SqlResult, StoreError> {
    execute_test_snapshot_with_stats(store, context, query).map(|(result, _)| result)
}
#[cfg(test)]
pub(crate) fn execute_test_snapshot_with_stats(
    store: Arc<StoreReadSnapshot>,
    context: BoundModuleContext,
    query: nodex_core_contracts::sql::SqlQuery,
) -> Result<(nodex_core_contracts::sql::SqlResult, QueryStats), StoreError> {
    let (store_epoch, commit_head) = store.read(|connection| {
        Ok((
            crate::document::read_store_epoch(connection)?,
            crate::infrastructure::local_commit::head(connection)?,
        ))
    })?;
    let snapshot = Arc::new(Snapshot {
        store,
        context,
        store_epoch,
        commit_head,
        page_search: Arc::new(PageSearchIndexRegistry::default()),
        budget: Mutex::new(Budget::default()),
        stats: Mutex::new(QueryStats::default()),
        error: Mutex::new(None),
    });
    let result = engine::execute(snapshot.clone(), query)?;
    let stats = snapshot.stats.lock().unwrap().clone();
    Ok((result, stats))
}
