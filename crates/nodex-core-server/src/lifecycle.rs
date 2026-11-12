use std::env;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::Instant;

const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_IDLE_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_IDLE_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MIN_IDLE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const IDLE_TIMEOUT_ENV: &str = "NODEX_CORE_IDLE_TIMEOUT_MS";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DrainReason {
    ExplicitShutdown,
    IdleTimeout,
    OperatingSystemSignal,
    Replacement,
}

struct LifecycleInner {
    draining: AtomicBool,
    activity_generation: Mutex<u64>,
    drain_observer: Arc<dyn Fn(DrainReason) + Send + Sync>,
    /// Drain is a state, not an event: the server, listeners and every stream observe
    /// it, whenever they begin waiting and however many of them wait.
    drain: watch::Sender<bool>,
}

#[derive(Clone)]
pub(crate) struct LifecycleCoordinator {
    inner: Arc<LifecycleInner>,
}

impl LifecycleCoordinator {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_drain_observer(|_| {})
    }

    pub(crate) fn with_drain_observer(
        observer: impl Fn(DrainReason) + Send + Sync + 'static,
    ) -> Self {
        let (drain, _) = watch::channel(false);
        Self {
            inner: Arc::new(LifecycleInner {
                draining: AtomicBool::new(false),
                activity_generation: Mutex::new(0),
                drain_observer: Arc::new(observer),
                drain,
            }),
        }
    }

    pub(crate) fn is_draining(&self) -> bool {
        self.inner.draining.load(Ordering::Acquire)
    }

    pub(crate) fn begin_drain(&self, reason: DrainReason) -> bool {
        let Ok(generation) = self.inner.activity_generation.lock() else {
            return false;
        };
        let began = self.begin_drain_locked();
        drop(generation);
        self.publish_drain(began, reason);
        began
    }

    pub(crate) fn record_activity(&self) -> bool {
        let Ok(mut generation) = self.inner.activity_generation.lock() else {
            return false;
        };
        if self.is_draining() {
            return false;
        }
        let Some(next) = generation.checked_add(1) else {
            return false;
        };
        *generation = next;
        true
    }

    fn activity_generation(&self) -> Option<u64> {
        self.inner
            .activity_generation
            .lock()
            .ok()
            .map(|value| *value)
    }

    fn try_begin_idle_drain(&self, expected_generation: u64) -> bool {
        let Ok(generation) = self.inner.activity_generation.lock() else {
            return false;
        };
        if *generation != expected_generation {
            return false;
        }
        let began = self.begin_drain_locked();
        drop(generation);
        self.publish_drain(began, DrainReason::IdleTimeout);
        began
    }

    pub(crate) fn try_begin_idle_drain_if(
        &self,
        reason: DrainReason,
        is_idle: impl FnOnce() -> bool,
    ) -> bool {
        let Ok(generation) = self.inner.activity_generation.lock() else {
            return false;
        };
        if self.is_draining() || !is_idle() {
            return false;
        }
        let began = self.begin_drain_locked();
        drop(generation);
        self.publish_drain(began, reason);
        began
    }

    fn begin_drain_locked(&self) -> bool {
        if self
            .inner
            .draining
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.inner.drain.send_replace(true);
        true
    }

    fn publish_drain(&self, began: bool, reason: DrainReason) {
        if !began {
            return;
        }
        (self.inner.drain_observer)(reason);
    }

    pub(crate) fn subscribe_stream_shutdown(&self) -> watch::Receiver<bool> {
        self.inner.drain.subscribe()
    }

    pub(crate) async fn wait_for_stream_shutdown(receiver: &mut watch::Receiver<bool>) {
        let _ = receiver.wait_for(|draining| *draining).await;
    }

    pub(crate) async fn wait_for_drain(&self) {
        let mut receiver = self.subscribe_stream_shutdown();
        Self::wait_for_stream_shutdown(&mut receiver).await;
    }
}

pub(crate) fn configured_idle_timeout() -> io::Result<Option<Duration>> {
    let Some(value) = env::var_os(IDLE_TIMEOUT_ENV) else {
        return Ok(Some(DEFAULT_IDLE_TIMEOUT));
    };
    let value = value
        .to_str()
        .ok_or_else(|| invalid_idle_timeout("must be valid UTF-8"))?;
    let milliseconds = value
        .parse::<u64>()
        .map_err(|_| invalid_idle_timeout("must be a non-negative integer"))?;
    if milliseconds == 0 {
        return Ok(None);
    }
    let timeout = Duration::from_millis(milliseconds);
    if timeout > MAX_IDLE_TIMEOUT {
        return Err(invalid_idle_timeout("exceeds the 24-hour maximum"));
    }
    Ok(Some(timeout))
}

pub(crate) async fn monitor_idle(
    coordinator: LifecycleCoordinator,
    timeout: Duration,
    mut is_idle: impl FnMut() -> bool,
) {
    let poll_interval = timeout
        .checked_div(4)
        .unwrap_or(MIN_IDLE_POLL_INTERVAL)
        .clamp(MIN_IDLE_POLL_INTERVAL, MAX_IDLE_POLL_INTERVAL);
    let mut interval = tokio::time::interval(poll_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle_since = None::<(Instant, u64)>;
    loop {
        interval.tick().await;
        if coordinator.is_draining() {
            return;
        }
        let Some(generation) = coordinator.activity_generation() else {
            idle_since = None;
            continue;
        };
        if !is_idle() {
            idle_since = None;
            continue;
        }
        let (since, observed_generation) = idle_since.get_or_insert((Instant::now(), generation));
        if *observed_generation != generation {
            idle_since = Some((Instant::now(), generation));
            continue;
        }
        if since.elapsed() < timeout {
            continue;
        }
        if coordinator.try_begin_idle_drain(generation) {
            tracing::info!(reason = "idle_timeout", "Core drain began");
            return;
        }
        idle_since = None;
    }
}

fn invalid_idle_timeout(reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{IDLE_TIMEOUT_ENV} {reason}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn idle_monitor_resets_the_full_period_after_activity() {
        let coordinator = LifecycleCoordinator::new();
        let mut checks = 0;
        let task = tokio::spawn(monitor_idle(
            coordinator.clone(),
            Duration::from_millis(60),
            move || {
                checks += 1;
                checks != 3
            },
        ));
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!coordinator.is_draining());
        tokio::time::timeout(Duration::from_millis(80), task)
            .await
            .expect("Core drains after the renewed idle period")
            .expect("idle monitor");
        assert!(coordinator.is_draining());
    }

    #[tokio::test]
    async fn every_drain_waiter_observes_one_drain() {
        let coordinator = LifecycleCoordinator::new();
        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let coordinator = coordinator.clone();
                tokio::spawn(async move { coordinator.wait_for_drain().await })
            })
            .collect();
        tokio::task::yield_now().await;
        assert!(coordinator.begin_drain(DrainReason::ExplicitShutdown));
        for waiter in waiters {
            tokio::time::timeout(Duration::from_millis(200), waiter)
                .await
                .expect("each waiter observes the drain")
                .expect("waiter task");
        }
        tokio::time::timeout(Duration::from_millis(20), coordinator.wait_for_drain())
            .await
            .expect("a waiter that arrives after the drain observes it");
    }

    #[tokio::test]
    async fn stream_subscriber_created_after_drain_observes_shutdown() {
        let coordinator = LifecycleCoordinator::new();
        assert!(coordinator.begin_drain(DrainReason::ExplicitShutdown));
        let mut receiver = coordinator.subscribe_stream_shutdown();

        tokio::time::timeout(
            Duration::from_millis(20),
            LifecycleCoordinator::wait_for_stream_shutdown(&mut receiver),
        )
        .await
        .expect("already-draining stream shutdown remains observable");
    }
}
