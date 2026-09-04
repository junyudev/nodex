use std::sync::{Condvar, Mutex, OnceLock};

use super::sqlite::{StoreError, StoreErrorCode};

#[derive(Default)]
struct LeaseState {
    readers: usize,
    collecting: bool,
}

#[derive(Default)]
struct LeaseRegistry {
    state: Mutex<LeaseState>,
    released: Condvar,
}

fn registry() -> &'static LeaseRegistry {
    static REGISTRY: OnceLock<LeaseRegistry> = OnceLock::new();
    REGISTRY.get_or_init(LeaseRegistry::default)
}

/// Owned, Send lease: a publication can cross the transport's async boundary
/// and remain pinned until its owner commits durable roots. Snapshots use the
/// same boundary. GC never waits behind either activity on the Store writer.
#[derive(Debug)]
pub(crate) struct ManagedAssetSnapshotLease {
    _private: (),
}

impl Drop for ManagedAssetSnapshotLease {
    fn drop(&mut self) {
        let registry = registry();
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.readers -= 1;
        registry.released.notify_all();
    }
}

pub(crate) struct ManagedAssetGcLease {
    _private: (),
}

impl Drop for ManagedAssetGcLease {
    fn drop(&mut self) {
        let registry = registry();
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.collecting = false;
        registry.released.notify_all();
    }
}

pub(crate) fn acquire_snapshot_lease() -> Result<ManagedAssetSnapshotLease, StoreError> {
    let registry = registry();
    let state = registry.state.lock().map_err(|_| unavailable())?;
    let mut state = registry
        .released
        .wait_while(state, |state| state.collecting)
        .map_err(|_| unavailable())?;
    state.readers += 1;
    Ok(ManagedAssetSnapshotLease { _private: () })
}

pub(crate) fn try_acquire_gc_lease() -> Result<Option<ManagedAssetGcLease>, StoreError> {
    let mut state = registry().state.lock().map_err(|_| unavailable())?;
    if state.collecting || state.readers != 0 {
        return Ok(None);
    }
    state.collecting = true;
    Ok(Some(ManagedAssetGcLease { _private: () }))
}

fn unavailable() -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        "Managed asset lease is unavailable",
        false,
    )
}
