use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::extract::connect_info::Connected;
use axum::serve::IncomingStream;
use nodex_core_contracts::AdapterKind;
use tokio::net::UnixListener;

const MAX_CONNECTIONS: usize = 1_024;
const MAX_EVENT_SUBSCRIPTIONS: usize = 2_048;
const MAX_EVENT_SUBSCRIPTIONS_PER_CONNECTION: usize = 64;
const STALE_CONNECTION_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PeerIdentity {
    pub(crate) uid: Option<u32>,
    pub(crate) gid: Option<u32>,
    pub(crate) pid: Option<u32>,
}

impl PeerIdentity {
    fn unavailable() -> Self {
        Self {
            uid: None,
            gid: None,
            pid: None,
        }
    }

    pub(crate) fn is_authenticated_owner(&self, owner_uid: u32) -> bool {
        self.uid == Some(owner_uid) && self.gid.is_some() && self.pid.is_some()
    }
}

impl Connected<IncomingStream<'_, UnixListener>> for PeerIdentity {
    fn connect_info(stream: IncomingStream<'_, UnixListener>) -> Self {
        let credential = match stream.io().peer_cred() {
            Ok(credential) => credential,
            Err(error) => {
                tracing::warn!(
                    subsystem = "transport",
                    error = %error,
                    "Disconnected Unix peer could not be authenticated"
                );
                return Self::unavailable();
            }
        };
        Self {
            uid: Some(credential.uid()),
            gid: Some(credential.gid()),
            pid: credential.pid().and_then(|pid| u32::try_from(pid).ok()),
        }
    }
}

#[derive(Clone)]
pub(crate) struct BoundConnection {
    pub(crate) id: String,
    pub(crate) adapter: AdapterKind,
    pub(crate) peer_pid: Option<u32>,
}

struct ConnectionRecord {
    binding: String,
    adapter: AdapterKind,
    peer: PeerIdentity,
    build_id: String,
    transport_version: u32,
    last_seen: Instant,
    event_subscriptions: HashSet<EventSubscriptionKey>,
}

struct RegistryState {
    records: HashMap<String, ConnectionRecord>,
    event_subscriptions: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum EventSubscriptionKey {
    Global,
    ProjectionLive(String),
    Document(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionRegistryErrorKind {
    Unauthorized,
    Conflict,
    ResourceExhausted,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConnectionRegistryError {
    pub(crate) kind: ConnectionRegistryErrorKind,
    pub(crate) message: &'static str,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ConnectionActivity {
    pub(crate) clients: usize,
    pub(crate) event_subscriptions: usize,
}

pub(crate) struct EventSubscriptionLease {
    state: Weak<Mutex<RegistryState>>,
    connection_id: String,
    key: EventSubscriptionKey,
}

impl Drop for EventSubscriptionLease {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let Ok(mut state) = state.lock() else {
            return;
        };
        let removed = state
            .records
            .get_mut(&self.connection_id)
            .is_some_and(|record| {
                let removed = record.event_subscriptions.remove(&self.key);
                if removed {
                    record.last_seen = Instant::now();
                }
                removed
            });
        if !removed {
            return;
        }
        state.event_subscriptions = state.event_subscriptions.saturating_sub(1);
    }
}

#[derive(Clone)]
pub(crate) struct ConnectionRegistry {
    state: Arc<Mutex<RegistryState>>,
}

impl ConnectionRegistry {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState {
                records: HashMap::new(),
                event_subscriptions: 0,
            })),
        }
    }

    pub(crate) fn register(
        &self,
        connection_id: &str,
        binding: String,
        adapter: AdapterKind,
        peer: &PeerIdentity,
        build_id: &str,
        transport_version: u32,
    ) -> Result<(), ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        let now = Instant::now();
        state.records.retain(|_, record| {
            !record.event_subscriptions.is_empty()
                || now.duration_since(record.last_seen) <= STALE_CONNECTION_AGE
        });
        if let Some(record) = state.records.get_mut(connection_id) {
            if record.adapter != adapter
                || record.peer != *peer
                || record.build_id != build_id
                || record.transport_version != transport_version
                || !constant_time_equal(record.binding.as_bytes(), binding.as_bytes())
            {
                return Err(conflict("connection identity is already bound"));
            }
            record.last_seen = now;
            return Ok(());
        }
        if state.records.len() >= MAX_CONNECTIONS {
            return Err(exhausted("connection registry is full"));
        }
        state.records.insert(
            connection_id.to_owned(),
            ConnectionRecord {
                binding,
                adapter,
                peer: peer.clone(),
                build_id: build_id.to_owned(),
                transport_version,
                last_seen: now,
                event_subscriptions: HashSet::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn bind(
        &self,
        connection_id: &str,
        binding: &str,
        peer: &PeerIdentity,
    ) -> Result<BoundConnection, ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        let Some(record) = state.records.get_mut(connection_id) else {
            return Err(unauthorized(
                "connection has not completed a compatible Core handshake",
            ));
        };
        if record.peer != *peer
            || !constant_time_equal(record.binding.as_bytes(), binding.as_bytes())
        {
            return Err(unauthorized(
                "connection binding does not match its authenticated peer",
            ));
        }
        let now = Instant::now();
        record.last_seen = now;
        let bound = BoundConnection {
            id: connection_id.to_owned(),
            adapter: record.adapter.clone(),
            peer_pid: record.peer.pid,
        };
        Ok(bound)
    }

    pub(crate) fn acquire_event_subscription(
        &self,
        connection_id: &str,
        key: EventSubscriptionKey,
    ) -> Result<EventSubscriptionLease, ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        let record = state.records.get(connection_id).ok_or_else(|| {
            unauthorized("connection has not completed a compatible Core handshake")
        })?;
        if record.event_subscriptions.contains(&key) {
            return Err(conflict("event subscription identity is already active"));
        }
        if record.event_subscriptions.len() >= MAX_EVENT_SUBSCRIPTIONS_PER_CONNECTION {
            return Err(exhausted(
                "connection event subscription capacity is exhausted",
            ));
        }
        if state.event_subscriptions >= MAX_EVENT_SUBSCRIPTIONS {
            return Err(exhausted("Core event subscription capacity is exhausted"));
        }
        let record = state
            .records
            .get_mut(connection_id)
            .expect("validated connection remains registered while locked");
        record.event_subscriptions.insert(key.clone());
        let now = Instant::now();
        record.last_seen = now;
        state.event_subscriptions += 1;
        Ok(EventSubscriptionLease {
            state: Arc::downgrade(&self.state),
            connection_id: connection_id.to_owned(),
            key,
        })
    }

    pub(crate) fn activity(&self) -> Result<ConnectionActivity, ConnectionRegistryError> {
        self.activity_with(peer_process_is_alive)
    }

    fn activity_with(
        &self,
        mut process_is_alive: impl FnMut(Option<u32>) -> bool,
    ) -> Result<ConnectionActivity, ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        let now = Instant::now();
        state.records.retain(|_, record| {
            !record.event_subscriptions.is_empty()
                || (now.duration_since(record.last_seen) <= STALE_CONNECTION_AGE
                    && process_is_alive(record.peer.pid))
        });
        Ok(ConnectionActivity {
            clients: state.records.len(),
            event_subscriptions: state.event_subscriptions,
        })
    }
}

pub(crate) fn peer_process_is_alive(raw_pid: Option<u32>) -> bool {
    let Some(raw_pid) = raw_pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return false;
    };
    let Some(pid) = rustix::process::Pid::from_raw(raw_pid) else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) | Err(rustix::io::Errno::PERM) => true,
        Err(rustix::io::Errno::SRCH) => false,
        Err(_) => true,
    }
}

fn unauthorized(message: &'static str) -> ConnectionRegistryError {
    ConnectionRegistryError {
        kind: ConnectionRegistryErrorKind::Unauthorized,
        message,
    }
}

fn conflict(message: &'static str) -> ConnectionRegistryError {
    ConnectionRegistryError {
        kind: ConnectionRegistryErrorKind::Conflict,
        message,
    }
}

fn exhausted(message: &'static str) -> ConnectionRegistryError {
    ConnectionRegistryError {
        kind: ConnectionRegistryErrorKind::ResourceExhausted,
        message,
    }
}

fn unavailable(message: &'static str) -> ConnectionRegistryError {
    ConnectionRegistryError {
        kind: ConnectionRegistryErrorKind::Unavailable,
        message,
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(pid: u32) -> PeerIdentity {
        PeerIdentity {
            uid: Some(501),
            gid: Some(20),
            pid: Some(pid),
        }
    }

    #[test]
    fn unavailable_peer_credentials_fail_closed_without_panicking() {
        let unavailable = PeerIdentity::unavailable();

        assert!(!unavailable.is_authenticated_owner(501));
        assert_ne!(unavailable, peer(10));
    }

    #[test]
    fn connection_binding_is_single_identity_and_peer_bound() {
        let registry = ConnectionRegistry::new();
        registry
            .register(
                "connection:one",
                "binding:one".to_owned(),
                AdapterKind::ElectronHost,
                &peer(10),
                "host-build",
                1,
            )
            .expect("first registration");
        assert!(
            registry
                .bind("connection:one", "binding:one", &peer(10))
                .is_ok()
        );
        assert!(
            registry
                .bind("connection:one", "binding:one", &peer(11))
                .is_err()
        );
        assert!(
            registry
                .register(
                    "connection:one",
                    "binding:two".to_owned(),
                    AdapterKind::NativeCli,
                    &peer(10),
                    "cli-build",
                    1,
                )
                .is_err()
        );
    }

    #[test]
    fn event_subscription_leases_are_unique_bounded_and_released() {
        let registry = ConnectionRegistry::new();
        registry
            .register(
                "connection:one",
                "binding:one".to_owned(),
                AdapterKind::ElectronHost,
                &peer(10),
                "host-build",
                1,
            )
            .expect("registration");

        let global = registry
            .acquire_event_subscription("connection:one", EventSubscriptionKey::Global)
            .expect("global subscription");
        assert_eq!(
            registry
                .acquire_event_subscription("connection:one", EventSubscriptionKey::Global)
                .err()
                .expect("duplicate subscription")
                .kind,
            ConnectionRegistryErrorKind::Conflict
        );
        let mut document_leases = Vec::new();
        for index in 1..MAX_EVENT_SUBSCRIPTIONS_PER_CONNECTION {
            document_leases.push(
                registry
                    .acquire_event_subscription(
                        "connection:one",
                        EventSubscriptionKey::Document(format!("session:{index}")),
                    )
                    .expect("bounded Document subscription"),
            );
        }
        assert_eq!(
            registry
                .acquire_event_subscription(
                    "connection:one",
                    EventSubscriptionKey::Document("session:overflow".to_owned()),
                )
                .err()
                .expect("per-connection capacity")
                .kind,
            ConnectionRegistryErrorKind::ResourceExhausted
        );

        drop(global);
        registry
            .acquire_event_subscription("connection:one", EventSubscriptionKey::Global)
            .expect("released subscription capacity");
        drop(document_leases);
    }

    #[test]
    fn projection_live_leases_are_unique_per_canonical_scope_set() {
        let registry = ConnectionRegistry::new();
        registry
            .register(
                "connection:one",
                "binding:one".to_owned(),
                AdapterKind::ElectronHost,
                &peer(10),
                "host-build",
                1,
            )
            .expect("registration");

        let first = registry
            .acquire_event_subscription(
                "connection:one",
                EventSubscriptionKey::ProjectionLive("scope-set:a".to_owned()),
            )
            .expect("first Projection live lease");
        let duplicate = registry.acquire_event_subscription(
            "connection:one",
            EventSubscriptionKey::ProjectionLive("scope-set:a".to_owned()),
        );
        assert_eq!(
            duplicate.err().expect("duplicate lease is rejected").kind,
            ConnectionRegistryErrorKind::Conflict
        );
        registry
            .acquire_event_subscription(
                "connection:one",
                EventSubscriptionKey::ProjectionLive("scope-set:b".to_owned()),
            )
            .expect("overlapping replacement lease");

        drop(first);
    }

    #[test]
    fn idle_activity_reaps_dead_unleased_clients_but_retains_live_and_streaming_clients() {
        let registry = ConnectionRegistry::new();
        for (connection_id, pid) in [("connection:dead", 10), ("connection:live", 11)] {
            registry
                .register(
                    connection_id,
                    format!("binding:{pid}"),
                    AdapterKind::ElectronHost,
                    &peer(pid),
                    "host-build",
                    1,
                )
                .expect("registration");
        }
        let streaming = registry
            .acquire_event_subscription("connection:dead", EventSubscriptionKey::Global)
            .expect("streaming lease");
        assert_eq!(
            registry
                .activity_with(|pid| pid == Some(11))
                .expect("activity while stream is held"),
            ConnectionActivity {
                clients: 2,
                event_subscriptions: 1,
            }
        );
        drop(streaming);
        assert_eq!(
            registry
                .activity_with(|pid| pid == Some(11))
                .expect("dead client is reaped"),
            ConnectionActivity {
                clients: 1,
                event_subscriptions: 0,
            }
        );
    }
}
