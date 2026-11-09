use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use nodex_core_contracts::{AdapterKind, RemotePrincipal};
pub(crate) use nodex_platform::local_endpoint::PeerIdentity;
use nodex_platform::process::ProcessInstance;

const MAX_CONNECTIONS: usize = 1_024;
const MAX_EVENT_SUBSCRIPTIONS: usize = 2_048;
const MAX_EVENT_SUBSCRIPTIONS_PER_CONNECTION: usize = 64;
const STALE_CONNECTION_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub(crate) struct BoundConnection {
    pub(crate) principal: Option<RemotePrincipal>,
    pub(crate) id: String,
    pub(crate) adapter: AdapterKind,
    pub(crate) peer_process: Option<ProcessInstance>,
}

struct ConnectionRecord {
    principal: Option<RemotePrincipal>,
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
    binding: String,
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
                if !constant_time_equal(record.binding.as_bytes(), self.binding.as_bytes()) {
                    return false;
                }
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

/// Who a connection claims to be when it registers: its binding and adapter, the peer
/// and build it runs, and the verified principal a remote Member presents.
pub(crate) struct ConnectionIdentity<'a> {
    pub(crate) binding: String,
    pub(crate) adapter: AdapterKind,
    pub(crate) peer: &'a PeerIdentity,
    pub(crate) build_id: &'a str,
    pub(crate) transport_version: u32,
    pub(crate) principal: Option<RemotePrincipal>,
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
        identity: ConnectionIdentity<'_>,
    ) -> Result<(), ConnectionRegistryError> {
        let ConnectionIdentity {
            transport_version,
            principal,
        } = identity;
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        if (adapter == AdapterKind::RemoteMember) != principal.is_some() {
            return Err(unauthorized(
                "Remote connections require a verified principal",
            ));
        }
        let now = Instant::now();
        state.records.retain(|_, record| {
            !record.event_subscriptions.is_empty()
                || now.duration_since(record.last_seen) <= STALE_CONNECTION_AGE
        });
        if let Some(record) = state.records.get_mut(connection_id) {
            if record.principal != principal
                || record.adapter != adapter
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
        if let Some(p) = &principal {
            let device_count = state
                .records
                .values()
                .filter(|r| {
                    r.principal
                        .as_ref()
                        .is_some_and(|old| old.device_id == p.device_id)
                })
                .count();
            if device_count >= 4 {
                let idle = state
                    .records
                    .iter()
                    .filter(|(_, r)| {
                        r.event_subscriptions.is_empty()
                            && r.principal
                                .as_ref()
                                .is_some_and(|old| old.device_id == p.device_id)
                    })
                    .min_by_key(|(_, r)| r.last_seen)
                    .map(|(id, _)| id.clone());
                let Some(idle) = idle else {
                    return Err(exhausted("Device connection capacity is exhausted"));
                };
                state.records.remove(&idle);
            }
            if state
                .records
                .values()
                .filter(|r| {
                    r.principal
                        .as_ref()
                        .is_some_and(|old| old.member_id == p.member_id)
                })
                .count()
                >= 32
            {
                return Err(exhausted("Member connection capacity is exhausted"));
            }
        }
        if state.records.len() >= MAX_CONNECTIONS {
            return Err(exhausted("connection registry is full"));
        }
        state.records.insert(
            connection_id.to_owned(),
            ConnectionRecord {
                principal,
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

    pub(crate) fn withdraw(
        &self,
        predicate: impl Fn(&RemotePrincipal) -> bool,
    ) -> Result<(), ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("Connection registry failed"))?;
        let mut released = 0;
        state.records.retain(|_, record| {
            if !record.principal.as_ref().is_some_and(&predicate) {
                return true;
            }
            released += record.event_subscriptions.len();
            false
        });
        state.event_subscriptions = state.event_subscriptions.saturating_sub(released);
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
            principal: record.principal.clone(),
            id: connection_id.to_owned(),
            adapter: record.adapter.clone(),
            peer_process: record.peer.process,
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
        let binding = record.binding.clone();
        state.event_subscriptions += 1;
        Ok(EventSubscriptionLease {
            binding,
            state: Arc::downgrade(&self.state),
            connection_id: connection_id.to_owned(),
            key,
        })
    }

    pub(crate) fn activity(&self) -> Result<ConnectionActivity, ConnectionRegistryError> {
        self.activity_with(|process| process.is_alive())
    }

    fn activity_with(
        &self,
        mut process_is_alive: impl FnMut(&ProcessInstance) -> bool,
    ) -> Result<ConnectionActivity, ConnectionRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("connection registry failed"))?;
        let now = Instant::now();
        state.records.retain(|_, record| {
            !record.event_subscriptions.is_empty()
                || (now.duration_since(record.last_seen) <= STALE_CONNECTION_AGE
                    && (record.adapter == AdapterKind::RemoteMember
                        || record
                            .peer
                            .process
                            .as_ref()
                            .is_some_and(&mut process_is_alive)))
        });
        Ok(ConnectionActivity {
            clients: state.records.len(),
            event_subscriptions: state.event_subscriptions,
        })
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
            user: Some(nodex_platform::process::current_user().unwrap()),
            process: Some(ProcessInstance { pid, started: 1 }),
        }
    }

    #[test]
    fn unavailable_peer_credentials_fail_closed_without_panicking() {
        let unavailable = PeerIdentity::unavailable();

        assert!(
            !unavailable.is_authenticated_owner(&nodex_platform::process::current_user().unwrap())
        );
        assert_ne!(unavailable, peer(10));
    }

    #[test]
    fn connection_binding_is_single_identity_and_peer_bound() {
        let registry = ConnectionRegistry::new();
        registry
            .register(
                "connection:one",
                ConnectionIdentity {
                    binding: "binding:one".to_owned(),
                    adapter: AdapterKind::ElectronHost,
                    peer: &peer(10),
                    build_id: "host-build",
                    transport_version: 1,
                    principal: None,
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
        let recycled = PeerIdentity {
            process: Some(ProcessInstance {
                pid: 10,
                started: 2,
            }),
            ..peer(10)
        };
        assert!(
            registry
                .bind("connection:one", "binding:one", &recycled)
                .is_err(),
            "a later process under the same PID is another peer"
        );
        assert!(
            registry
                .register(
                    "connection:one",
                    ConnectionIdentity {
                        binding: "binding:two".to_owned(),
                        adapter: AdapterKind::NativeCli,
                        peer: &peer(10),
                        build_id: "cli-build",
                        transport_version: 1,
                        principal: None
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
                ConnectionIdentity {
                    binding: "binding:one".to_owned(),
                    adapter: AdapterKind::ElectronHost,
                    peer: &peer(10),
                    build_id: "host-build",
                    transport_version: 1,
                    principal: None,
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
                ConnectionIdentity {
                    binding: "binding:one".to_owned(),
                    adapter: AdapterKind::ElectronHost,
                    peer: &peer(10),
                    build_id: "host-build",
                    transport_version: 1,
                    principal: None,
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
                    ConnectionIdentity {
                        binding: format!("binding:{pid}"),
                        adapter: AdapterKind::ElectronHost,
                        peer: &peer(pid),
                        build_id: "host-build",
                        transport_version: 1,
                        principal: None,
                )
                .expect("registration");
        }
        let streaming = registry
            .acquire_event_subscription("connection:dead", EventSubscriptionKey::Global)
            .expect("streaming lease");
        assert_eq!(
            registry
                .activity_with(|process| process.pid == 11)
                .expect("activity while stream is held"),
            ConnectionActivity {
                clients: 2,
                event_subscriptions: 1,
            }
        );
        drop(streaming);
        assert_eq!(
            registry
                .activity_with(|process| process.pid == 11)
                .expect("dead client is reaped"),
            ConnectionActivity {
                clients: 1,
                event_subscriptions: 0,
            }
        );
    }
    fn member_principal(device: &str) -> RemotePrincipal {
        RemotePrincipal {
            space_id: "space".into(),
            member_id: "member".into(),
            device_id: device.into(),
            session_id: format!("session:{device}"),
            role: nodex_core_contracts::library::MemberRole::Member,
        }
    }
    #[test]
    fn remote_connection_capacity_is_device_scoped_and_reclaims_idle_attempts() {
        let registry = ConnectionRegistry::new();
        let peer = PeerIdentity::unavailable();
        let mut leases = Vec::new();
        for index in 0..4 {
            let id = format!("connection:{index}");
            registry
                .register(
                    &id,
                    ConnectionIdentity {
                        binding: id.clone(),
                        adapter: AdapterKind::RemoteMember,
                        peer: &peer,
                        build_id: "build",
                        transport_version: 1,
                        principal: Some(member_principal("device")),
                )
                .unwrap();
            leases.push(
                registry
                    .acquire_event_subscription(&id, EventSubscriptionKey::Global)
                    .unwrap(),
            );
        }
        assert_eq!(
            registry
                .register(
                    "overflow",
                    ConnectionIdentity {
                        binding: "binding".into(),
                        adapter: AdapterKind::RemoteMember,
                        peer: &peer,
                        build_id: "build",
                        transport_version: 1,
                        principal: Some(member_principal("device"))
                )
                .unwrap_err()
                .kind,
            ConnectionRegistryErrorKind::ResourceExhausted
        );
        registry
            .register(
                "other-device",
                ConnectionIdentity {
                    binding: "binding".into(),
                    adapter: AdapterKind::RemoteMember,
                    peer: &peer,
                    build_id: "build",
                    transport_version: 1,
                    principal: Some(member_principal("other")),
            )
            .unwrap();
        drop(leases);
        registry
            .register(
                "replacement",
                ConnectionIdentity {
                    binding: "binding".into(),
                    adapter: AdapterKind::RemoteMember,
                    peer: &peer,
                    build_id: "build",
                    transport_version: 1,
                    principal: Some(member_principal("device")),
            )
            .unwrap();
        assert_eq!(registry.activity_with(|_| false).unwrap().clients, 5);
    }
    #[test]
    fn withdrawn_lease_cannot_remove_a_reused_connection_identity() {
        let registry = ConnectionRegistry::new();
        let peer = PeerIdentity::unavailable();
        registry
            .register(
                "connection",
                ConnectionIdentity {
                    binding: "old".into(),
                    adapter: AdapterKind::RemoteMember,
                    peer: &peer,
                    build_id: "build",
                    transport_version: 1,
                    principal: Some(member_principal("old")),
            )
            .unwrap();
        let old = registry
            .acquire_event_subscription("connection", EventSubscriptionKey::Global)
            .unwrap();
        registry.withdraw(|p| p.device_id == "old").unwrap();
        registry
            .register(
                "connection",
                ConnectionIdentity {
                    binding: "new".into(),
                    adapter: AdapterKind::RemoteMember,
                    peer: &peer,
                    build_id: "build",
                    transport_version: 1,
                    principal: Some(member_principal("new")),
            )
            .unwrap();
        let new = registry
            .acquire_event_subscription("connection", EventSubscriptionKey::Global)
            .unwrap();
        drop(old);
        assert_eq!(
            registry
                .activity_with(|_| false)
                .unwrap()
                .event_subscriptions,
            1
        );
        drop(new);
        assert_eq!(
            registry
                .activity_with(|_| false)
                .unwrap()
                .event_subscriptions,
            0
        );
    }
}
