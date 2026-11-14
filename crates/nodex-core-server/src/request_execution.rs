use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use nodex_core::infrastructure::metrics::{DurationMetric, DurationMetricSnapshot};
use nodex_core::infrastructure::request_execution::{
    RequestExecutionClass, RequestExecutionContext, RequestExecutionPhase, within_request_execution,
};
use nodex_core::infrastructure::sqlite::QueryCancellation;
use nodex_core_contracts::{CoreError, CoreErrorCode, CoreErrorRecovery};
use nodex_core_protocol::{
    BACKGROUND_REQUEST_DEADLINE_MS, CoreRequestClass as RequestClass,
    INTERACTIVE_REQUEST_DEADLINE_MS, MAINTENANCE_REQUEST_DEADLINE_MS, MAX_REQUEST_DEADLINE_MS,
    MIN_REQUEST_DEADLINE_MS, RequestClassHealth, RequestClassHealthCounts,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const REQUEST_ID_HEADER: &str = "x-nodex-request-id";
pub(crate) const REQUEST_CLASS_HEADER: &str = "x-nodex-request-class";
pub(crate) const REQUEST_DEADLINE_HEADER: &str = "x-nodex-request-deadline-ms";

const TOTAL_EXECUTION_CAPACITY: usize = 4;
const BACKGROUND_EXECUTION_CAPACITY: usize = TOTAL_EXECUTION_CAPACITY - 1;
const MAINTENANCE_EXECUTION_CAPACITY: usize = 1;
const ADMISSION_CAPACITIES: AdmissionCapacities = AdmissionCapacities {
    interactive: 128,
    background: 48,
    maintenance: 8,
};
const ADMISSION_RETRY_MS: u64 = 100;
const REFUSAL_LOG_INTERVAL: Duration = Duration::from_secs(1);
const REFUSAL_OPERATION_LIMIT: usize = 5;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_CANCELLATION_TOMBSTONES: usize = 4_096;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn parse_request_class(value: &str) -> Option<RequestClass> {
    match value {
        "interactive" => Some(RequestClass::Interactive),
        "background" => Some(RequestClass::Background),
        "maintenance" => Some(RequestClass::Maintenance),
        _ => None,
    }
}

fn default_deadline(class: RequestClass) -> Duration {
    match class {
        RequestClass::Interactive => Duration::from_millis(INTERACTIVE_REQUEST_DEADLINE_MS),
        RequestClass::Background => Duration::from_millis(BACKGROUND_REQUEST_DEADLINE_MS),
        RequestClass::Maintenance => Duration::from_millis(MAINTENANCE_REQUEST_DEADLINE_MS),
    }
}

fn execution_class(class: RequestClass) -> RequestExecutionClass {
    match class {
        RequestClass::Interactive => RequestExecutionClass::Interactive,
        RequestClass::Background => RequestExecutionClass::Background,
        RequestClass::Maintenance => RequestExecutionClass::Maintenance,
    }
}

fn request_class_name(class: RequestClass) -> &'static str {
    match class {
        RequestClass::Interactive => "interactive",
        RequestClass::Background => "background",
        RequestClass::Maintenance => "maintenance",
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RequestKey {
    connection_id: String,
    request_id: String,
}

#[derive(Clone, Copy)]
struct AdmissionCapacities {
    interactive: u64,
    background: u64,
    maintenance: u64,
}

impl AdmissionCapacities {
    fn get(self, class: RequestClass) -> u64 {
        match class {
            RequestClass::Interactive => self.interactive,
            RequestClass::Background => self.background,
            RequestClass::Maintenance => self.maintenance,
        }
    }
}

struct ActiveRequest {
    cancellation: QueryCancellation,
    class: RequestClass,
    operation: &'static str,
    running: bool,
}

struct ActiveRequestGuard {
    registry: Arc<Mutex<RequestRegistry>>,
    key: RequestKey,
}

impl ActiveRequestGuard {
    fn mark_running(&self) {
        let mut registry = self.registry.lock().expect("request registry");
        let request = registry
            .active
            .get_mut(&self.key)
            .expect("admitted request");
        request.running = true;
        let class = request.class;
        let counts = registry.counts_mut(class);
        counts.queued -= 1;
        counts.running += 1;
    }
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        if let Some(request) = registry.active.remove(&self.key) {
            let counts = registry.counts_mut(request.class);
            if request.running {
                counts.running -= 1;
            } else {
                counts.queued -= 1;
            }
        }
    }
}

#[derive(Default)]
struct RequestRegistry {
    active: HashMap<RequestKey, ActiveRequest>,
    cancellation_tombstones: HashMap<RequestKey, Instant>,
    counts: RequestClassHealth,
    last_refusal_log: Option<Instant>,
}

#[derive(Debug)]
struct AdmissionPressure {
    class: RequestClass,
    operation: &'static str,
    counts: RequestClassHealth,
    top_operations: Vec<(&'static str, u64)>,
}

impl RequestRegistry {
    fn prune_tombstones(&mut self, now: Instant) {
        self.cancellation_tombstones
            .retain(|_, expires_at| *expires_at > now);
    }

    fn counts_mut(&mut self, class: RequestClass) -> &mut RequestClassHealthCounts {
        match class {
            RequestClass::Interactive => &mut self.counts.interactive,
            RequestClass::Background => &mut self.counts.background,
            RequestClass::Maintenance => &mut self.counts.maintenance,
        }
    }

    fn record_refusal(
        &mut self,
        class: RequestClass,
        operation: &'static str,
        now: Instant,
    ) -> Option<AdmissionPressure> {
        self.counts_mut(class).refused += 1;
        if self
            .last_refusal_log
            .is_some_and(|last| now - last < REFUSAL_LOG_INTERVAL)
        {
            return None;
        }
        self.last_refusal_log = Some(now);
        let mut operations = HashMap::<_, u64>::new();
        for request in self.active.values() {
            *operations.entry(request.operation).or_default() += 1;
        }
        let mut top_operations: Vec<_> = operations.into_iter().collect();
        top_operations
            .sort_unstable_by_key(|&(operation, count)| (std::cmp::Reverse(count), operation));
        top_operations.truncate(REFUSAL_OPERATION_LIMIT);
        Some(AdmissionPressure {
            class,
            operation,
            counts: self.counts,
            top_operations,
        })
    }
}

#[derive(Debug)]
pub(crate) struct AdmissionRefusal(RequestClass);

impl AdmissionRefusal {
    pub(crate) fn api_error(self) -> crate::http_error::ApiError {
        crate::http_error::ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            format!(
                "Core {} request admission is full",
                request_class_name(self.0)
            ),
        )
        .with_recovery(CoreErrorRecovery::RetryAdmission {
            milliseconds: ADMISSION_RETRY_MS,
        })
    }
}

impl axum::response::IntoResponse for AdmissionRefusal {
    fn into_response(self) -> axum::response::Response {
        self.api_error().into_response()
    }
}

struct ExecutionPermits {
    _class: Option<OwnedSemaphorePermit>,
    _maintenance: Option<OwnedSemaphorePermit>,
    _total: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(crate) struct RequestExecutor {
    total: Arc<Semaphore>,
    background: Arc<Semaphore>,
    maintenance: Arc<Semaphore>,
    admission: AdmissionCapacities,
    registry: Arc<Mutex<RequestRegistry>>,
    metrics: Arc<RequestExecutorMetrics>,
}

#[derive(Default)]
struct RequestExecutorMetrics {
    admission_wait: DurationMetric,
    execution_duration: DurationMetric,
    deadline_exceeded: AtomicU64,
    cancelled: AtomicU64,
    overloaded: AtomicU64,
}

pub(crate) struct RequestExecutorSnapshot {
    pub(crate) active: u64,
    pub(crate) queued: u64,
    pub(crate) classes: RequestClassHealth,
    pub(crate) admission_wait: DurationMetricSnapshot,
    pub(crate) execution_duration: DurationMetricSnapshot,
    pub(crate) deadline_exceeded: u64,
    pub(crate) cancelled: u64,
    pub(crate) overloaded: u64,
}

impl RequestExecutor {
    pub(crate) fn new() -> Self {
        Self::with_capacities(
            TOTAL_EXECUTION_CAPACITY,
            BACKGROUND_EXECUTION_CAPACITY,
            MAINTENANCE_EXECUTION_CAPACITY,
            ADMISSION_CAPACITIES,
        )
    }

    fn with_capacities(
        total: usize,
        background: usize,
        maintenance: usize,
        admission: AdmissionCapacities,
    ) -> Self {
        Self {
            total: Arc::new(Semaphore::new(total)),
            background: Arc::new(Semaphore::new(background)),
            maintenance: Arc::new(Semaphore::new(maintenance)),
            admission,
            registry: Arc::new(Mutex::new(RequestRegistry::default())),
            metrics: Arc::new(RequestExecutorMetrics::default()),
        }
    }

    pub(crate) async fn execute<T>(
        &self,
        connection_id: &str,
        headers: &HeaderMap,
        default_class: RequestClass,
        label: &'static str,
        operation: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<Result<T, CoreError>, AdmissionRefusal>
    where
        T: Send + 'static,
    {
        let spec = match RequestSpec::from_headers(connection_id, headers, default_class) {
            Ok(spec) => spec,
            Err(error) => return Ok(Err(error)),
        };
        let started_at = Instant::now();
        let cancellation = QueryCancellation::new();
        let guard = match self.admit(&spec, label, &cancellation)? {
            Ok(guard) => guard,
            Err(error) => {
                self.record_error(&error);
                return Ok(Err(error));
            }
        };
        Ok(self
            .run(spec, started_at, cancellation, guard, operation)
            .await)
    }

    async fn run<T: Send + 'static>(
        &self,
        spec: RequestSpec,
        started_at: Instant,
        cancellation: QueryCancellation,
        guard: ActiveRequestGuard,
        operation: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError> {
        let permits = match self
            .acquire_permits(spec.class, spec.deadline, &cancellation)
            .await
        {
            Ok(permits) => permits,
            Err(error) => {
                if error.code == CoreErrorCode::DeadlineExceeded {
                    self.log_execution_deadline(
                        &spec,
                        started_at,
                        started_at.elapsed(),
                        RequestExecutionPhase::Admission,
                    );
                }
                self.record_error(&error);
                return Err(error);
            }
        };
        if cancellation.is_cancelled() {
            let error = cancelled();
            self.record_error(&error);
            return Err(error);
        }
        let admission_wait = started_at.elapsed();
        self.metrics.admission_wait.record(admission_wait);
        let context = RequestExecutionContext::new(
            execution_class(spec.class),
            cancellation.clone(),
            spec.deadline,
        );
        let execution_observer = context.observer();
        let worker_observer = execution_observer.clone();
        let metrics = Arc::clone(&self.metrics);
        let request_span = tracing::Span::current();
        let mut worker = tokio::task::spawn_blocking(move || {
            let _permits = permits;
            let guard = guard;
            // Dispatch can wait on Tokio's blocking pool after acquiring permits.
            if Instant::now() >= context.deadline() {
                return Err(deadline_exceeded());
            }
            if context.cancellation().is_cancelled() {
                return Err(cancelled());
            }
            guard.mark_running();
            let started_at = Instant::now();
            // Tokio blocking workers do not inherit the async task's tracing
            // span. Carry it explicitly so SQLite work remains correlated with
            // the request, operation, and receipt that caused it.
            let result = request_span.in_scope(|| within_request_execution(context, operation));
            worker_observer.set_phase(RequestExecutionPhase::Response);
            metrics.execution_duration.record(started_at.elapsed());
            result
        });

        loop {
            let remaining = spec.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                cancellation.cancel();
                self.log_execution_deadline(
                    &spec,
                    started_at,
                    admission_wait,
                    execution_observer.phase(),
                );
                let error = deadline_exceeded();
                self.record_error(&error);
                return Err(error);
            }
            tokio::select! {
                worker_result = &mut worker => {
                    // The worker and the timer can become ready on the same
                    // scheduler turn. Preserve the transported request
                    // boundary instead of exposing whichever inner error won
                    // that race (for example, a Store query deadline mapped by
                    // a module adapter).
                    if Instant::now() >= spec.deadline {
                        cancellation.cancel();
                        self.log_execution_deadline(
                            &spec,
                            started_at,
                            admission_wait,
                            execution_observer.phase(),
                        );
                        let error = deadline_exceeded();
                        self.record_error(&error);
                        return Err(error);
                    }
                    if cancellation.is_cancelled() {
                        let error = cancelled();
                        self.record_error(&error);
                        return Err(error);
                    }
                    let result = worker_result
                        .map_err(|error| worker_failed(&error.to_string()))?;
                    if let Err(error) = &result {
                        self.record_error(error);
                    }
                    return result;
                }
                () = tokio::time::sleep(remaining) => {
                    cancellation.cancel();
                    self.log_execution_deadline(
                        &spec,
                        started_at,
                        admission_wait,
                        execution_observer.phase(),
                    );
                    let error = deadline_exceeded();
                    self.record_error(&error);
                    return Err(error);
                }
                () = tokio::time::sleep(CANCELLATION_POLL_INTERVAL) => {
                    if cancellation.is_cancelled() {
                        let error = cancelled();
                        self.record_error(&error);
                        return Err(error);
                    }
                }
            }
        }
    }

    pub(crate) fn cancel(&self, connection_id: &str, request_id: &str) -> bool {
        let key = RequestKey {
            connection_id: connection_id.to_owned(),
            request_id: request_id.to_owned(),
        };
        let Ok(mut registry) = self.registry.lock() else {
            return false;
        };
        registry.prune_tombstones(Instant::now());
        if let Some(request) = registry.active.get(&key) {
            request.cancellation.cancel();
            return true;
        }
        if registry.cancellation_tombstones.len() >= MAX_CANCELLATION_TOMBSTONES {
            return false;
        }
        registry
            .cancellation_tombstones
            .insert(key, Instant::now() + CANCELLATION_TOMBSTONE_TTL);
        true
    }

    pub(crate) fn snapshot(&self) -> RequestExecutorSnapshot {
        let classes = self.registry.lock().map_or_else(
            |_| RequestClassHealth::default(),
            |registry| registry.counts,
        );
        RequestExecutorSnapshot {
            active: classes.interactive.running
                + classes.background.running
                + classes.maintenance.running,
            queued: classes.interactive.queued
                + classes.background.queued
                + classes.maintenance.queued,
            classes,
            admission_wait: self.metrics.admission_wait.snapshot(),
            execution_duration: self.metrics.execution_duration.snapshot(),
            deadline_exceeded: self.metrics.deadline_exceeded.load(Ordering::Relaxed),
            cancelled: self.metrics.cancelled.load(Ordering::Relaxed),
            overloaded: self.metrics.overloaded.load(Ordering::Relaxed)
                + classes.interactive.refused
                + classes.background.refused
                + classes.maintenance.refused,
        }
    }

    fn record_error(&self, error: &CoreError) {
        let counter = match error.code {
            CoreErrorCode::DeadlineExceeded => Some(&self.metrics.deadline_exceeded),
            CoreErrorCode::Cancelled => Some(&self.metrics.cancelled),
            CoreErrorCode::Overloaded => Some(&self.metrics.overloaded),
            _ => None,
        };
        if let Some(counter) = counter {
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn log_execution_deadline(
        &self,
        spec: &RequestSpec,
        started_at: Instant,
        admission_wait: Duration,
        phase: RequestExecutionPhase,
    ) {
        let snapshot = self.snapshot();
        tracing::warn!(
            requestClass = request_class_name(spec.class),
            budgetMs = u64::try_from(spec.budget.as_millis()).unwrap_or(u64::MAX),
            elapsedMs = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            admissionWaitMs = u64::try_from(admission_wait.as_millis()).unwrap_or(u64::MAX),
            phase = phase.as_str(),
            activeExecutions = snapshot.active,
            queuedExecutions = snapshot.queued,
            "Core request reached its semantic deadline"
        );
    }

    fn admit(
        &self,
        spec: &RequestSpec,
        operation: &'static str,
        cancellation: &QueryCancellation,
    ) -> Result<Result<ActiveRequestGuard, CoreError>, AdmissionRefusal> {
        let Ok(mut registry) = self.registry.lock() else {
            return Ok(Err(worker_failed("registry")));
        };
        let now = Instant::now();
        registry.prune_tombstones(now);
        if registry.active.contains_key(&spec.key) {
            return Ok(Err(active_request_conflict()));
        }
        if registry.cancellation_tombstones.remove(&spec.key).is_some() {
            return Ok(Err(cancelled()));
        }
        // Admission and its accounting share the cancellation registry lock.
        let counts = registry.counts_mut(spec.class);
        if counts.queued + counts.running >= self.admission.get(spec.class) {
            let pressure = registry.record_refusal(spec.class, operation, now);
            drop(registry);
            if let Some(pressure) = pressure {
                tracing::warn!(
                    requestClass = request_class_name(pressure.class),
                    operation = pressure.operation,
                    classes = ?pressure.counts,
                    topOperations = ?pressure.top_operations,
                    "Core request admission is full"
                );
            }
            return Err(AdmissionRefusal(spec.class));
        }
        counts.queued += 1;
        registry.active.insert(
            spec.key.clone(),
            ActiveRequest {
                cancellation: cancellation.clone(),
                class: spec.class,
                operation,
                running: false,
            },
        );
        Ok(Ok(ActiveRequestGuard {
            registry: Arc::clone(&self.registry),
            key: spec.key.clone(),
        }))
    }

    async fn acquire_permits(
        &self,
        class: RequestClass,
        deadline: Instant,
        cancellation: &QueryCancellation,
    ) -> Result<ExecutionPermits, CoreError> {
        let maintenance = match class {
            RequestClass::Maintenance => {
                Some(acquire(Arc::clone(&self.maintenance), deadline, cancellation).await?)
            }
            RequestClass::Interactive | RequestClass::Background => None,
        };
        let class_permit = match class {
            RequestClass::Interactive => None,
            RequestClass::Background | RequestClass::Maintenance => {
                Some(acquire(Arc::clone(&self.background), deadline, cancellation).await?)
            }
        };
        let total = acquire(Arc::clone(&self.total), deadline, cancellation).await?;
        Ok(ExecutionPermits {
            _class: class_permit,
            _maintenance: maintenance,
            _total: total,
        })
    }
}

struct RequestSpec {
    key: RequestKey,
    class: RequestClass,
    deadline: Instant,
    budget: Duration,
}

impl RequestSpec {
    fn from_headers(
        connection_id: &str,
        headers: &HeaderMap,
        default_class: RequestClass,
    ) -> Result<Self, CoreError> {
        let request_id = header(headers, REQUEST_ID_HEADER)?
            .map(str::to_owned)
            .unwrap_or_else(|| format!("core-{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)));
        if request_id.is_empty() || request_id.len() > 128 || request_id.trim() != request_id {
            return Err(invalid_request("Core request ID is invalid"));
        }
        let class = header(headers, REQUEST_CLASS_HEADER)?
            .map(|value| {
                parse_request_class(value)
                    .ok_or_else(|| invalid_request("Core request class is invalid"))
            })
            .transpose()?
            .unwrap_or(default_class);
        let deadline_duration = header(headers, REQUEST_DEADLINE_HEADER)?
            .map(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .map(Duration::from_millis)
                    .filter(|value| {
                        *value >= Duration::from_millis(MIN_REQUEST_DEADLINE_MS)
                            && *value <= Duration::from_millis(MAX_REQUEST_DEADLINE_MS)
                    })
                    .ok_or_else(|| invalid_request("Core request deadline is invalid"))
            })
            .transpose()?
            .unwrap_or_else(|| default_deadline(class));
        Ok(Self {
            key: RequestKey {
                connection_id: connection_id.to_owned(),
                request_id,
            },
            class,
            deadline: Instant::now() + deadline_duration,
            budget: deadline_duration,
        })
    }
}

async fn acquire(
    semaphore: Arc<Semaphore>,
    deadline: Instant,
    cancellation: &QueryCancellation,
) -> Result<OwnedSemaphorePermit, CoreError> {
    loop {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if Instant::now() >= deadline {
            return Err(deadline_exceeded());
        }
        match semaphore.clone().try_acquire_owned() {
            Ok(permit) => return Ok(permit),
            Err(tokio::sync::TryAcquireError::Closed) => {
                return Err(worker_failed("execution semaphore closed"));
            }
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                tokio::time::sleep(CANCELLATION_POLL_INTERVAL).await;
            }
        }
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, CoreError> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| invalid_request("Core request header is invalid"))
        })
        .transpose()
}

fn invalid_request(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn active_request_conflict() -> CoreError {
    CoreError {
        code: CoreErrorCode::Conflict,
        message: "Core request ID is already active".to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

fn deadline_exceeded() -> CoreError {
    CoreError {
        code: CoreErrorCode::DeadlineExceeded,
        message: "Core request deadline was exceeded".to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

fn cancelled() -> CoreError {
    CoreError {
        code: CoreErrorCode::Cancelled,
        message: "Core request was cancelled".to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

fn worker_failed(detail: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::CoreUnavailable,
        message: format!("Core request worker failed: {detail}"),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;

    use nodex_core::infrastructure::writer::StoreWriterRuntime;
    use nodex_platform::test_support::tempdir;

    use super::*;

    struct BlockedWriter {
        release: Option<mpsc::SyncSender<()>>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl BlockedWriter {
        fn release(mut self) {
            self.release
                .take()
                .expect("release sender")
                .send(())
                .expect("release writer");
            self.thread
                .take()
                .expect("blocker thread")
                .join()
                .expect("blocker join");
        }
    }

    impl Drop for BlockedWriter {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn headers(request_id: &str, class: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(REQUEST_ID_HEADER, request_id.parse().unwrap());
        headers.insert(REQUEST_CLASS_HEADER, class.parse().unwrap());
        headers.insert(REQUEST_DEADLINE_HEADER, "2000".parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn full_background_admission_leaves_interactive_capacity_available() {
        let executor = RequestExecutor::with_capacities(
            2,
            1,
            1,
            AdmissionCapacities {
                background: 2,
                ..ADMISSION_CAPACITIES
            },
        );
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let background_executor = executor.clone();
        let background = tokio::spawn(async move {
            background_executor
                .execute(
                    "connection",
                    &headers("background", "background"),
                    RequestClass::Interactive,
                    "test",
                    move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), started_rx)
            .await
            .expect("background execution starts")
            .unwrap();

        let queued_headers = headers("queued-background", "background");
        let mut queued = std::pin::pin!(executor.execute(
            "connection",
            &queued_headers,
            RequestClass::Interactive,
            "library.read",
            || -> Result<(), CoreError> { panic!("background execution slot is busy") },
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(queued.as_mut().poll(cx)))
                .await
                .is_pending()
        );

        let refused = executor
            .execute(
                "connection",
                &headers("refused-background", "background"),
                RequestClass::Interactive,
                "database.read",
                || -> Result<(), CoreError> { panic!("refused operation must never execute") },
            )
            .await
            .expect_err("full background admission");
        let snapshot = executor.snapshot();
        assert_eq!(snapshot.active, 1);
        assert_eq!(snapshot.queued, 1);
        assert_eq!(snapshot.overloaded, 1);
        assert_eq!(
            snapshot.classes,
            RequestClassHealth {
                background: RequestClassHealthCounts {
                    queued: 1,
                    running: 1,
                    refused: 1
                },
                ..RequestClassHealth::default()
            }
        );

        use axum::response::IntoResponse;
        let response = refused.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], "1");
        assert_eq!(response.headers()["content-type"], "application/json");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "status": "error",
                "payload": {
                    "code": "overloaded",
                    "message": "Core background request admission is full",
                    "retryable": true,
                    "recovery": {"kind": "retry_admission", "milliseconds": 100}
                }
            })
        );

        let result = executor
            .execute(
                "connection",
                &headers("interactive", "interactive"),
                RequestClass::Interactive,
                "test",
                || Ok("ready"),
            )
            .await;

        assert_eq!(result.unwrap().unwrap(), "ready");
        assert!(executor.cancel("connection", "queued-background"));
        assert_eq!(
            queued.await.unwrap().unwrap_err().code,
            CoreErrorCode::Cancelled
        );
        release_tx.send(()).unwrap();
        background.await.unwrap().unwrap().unwrap();
    }

    #[tokio::test]
    async fn admitted_store_overload_remains_an_operation_error() {
        let executor = RequestExecutor::new();
        let result = executor
            .execute(
                "connection",
                &HeaderMap::new(),
                RequestClass::Interactive,
                "library.apply",
                || {
                    Err::<(), _>(CoreError {
                        code: CoreErrorCode::Overloaded,
                        message: "Store writer queue is full".to_owned(),
                        retryable: true,
                        recovery: CoreErrorRecovery::None,
                    })
                },
            )
            .await
            .expect("admitted");
        let error = result.expect_err("Store overload");
        assert_eq!(error.code, CoreErrorCode::Overloaded);
        assert_eq!(error.recovery, CoreErrorRecovery::None);
        let snapshot = executor.snapshot();
        assert_eq!(snapshot.overloaded, 1);
        assert_eq!(snapshot.classes, RequestClassHealth::default());
    }

    #[test]
    fn refusal_attribution_counts_holders_and_limits_reports() {
        let executor = RequestExecutor::new();
        let guards: Vec<_> = [
            ("one", "background", "workspace.read"),
            ("two", "background", "workspace.read"),
            ("three", "maintenance", "database.maintain_view_orders"),
            ("four", "interactive", "library.apply"),
        ]
        .into_iter()
        .map(|(id, class, label)| {
            let spec = RequestSpec::from_headers(
                "connection",
                &headers(id, class),
                RequestClass::Interactive,
            )
            .unwrap();
            executor
                .admit(&spec, label, &QueryCancellation::new())
                .unwrap()
                .unwrap()
        })
        .collect();
        guards[0].mark_running();
        let now = Instant::now();
        let mut registry = executor.registry.lock().unwrap();
        let pressure = registry
            .record_refusal(RequestClass::Background, "database.read", now)
            .unwrap();
        assert_eq!(pressure.class, RequestClass::Background);
        assert_eq!(pressure.operation, "database.read");
        assert_eq!(
            pressure.top_operations,
            vec![
                ("workspace.read", 2),
                ("database.maintain_view_orders", 1),
                ("library.apply", 1),
            ]
        );
        assert_eq!(
            pressure.counts,
            RequestClassHealth {
                interactive: RequestClassHealthCounts {
                    queued: 1,
                    running: 0,
                    refused: 0
                },
                background: RequestClassHealthCounts {
                    queued: 1,
                    running: 1,
                    refused: 1
                },
                maintenance: RequestClassHealthCounts {
                    queued: 1,
                    running: 0,
                    refused: 0
                },
            }
        );
        assert!(
            registry
                .record_refusal(RequestClass::Background, "database.read", now)
                .is_none()
        );
        assert_eq!(
            registry
                .record_refusal(
                    RequestClass::Maintenance,
                    "administration.apply",
                    now + Duration::from_secs(1)
                )
                .unwrap()
                .counts
                .maintenance
                .refused,
            1
        );
        assert_eq!(registry.counts.background.refused, 2);
    }

    #[tokio::test]
    async fn explicit_cancellation_reaches_running_sqlite_context() {
        let executor = RequestExecutor::with_capacities(1, 1, 1, ADMISSION_CAPACITIES);
        let worker_executor = executor.clone();
        let worker = tokio::spawn(async move {
            worker_executor
                .execute(
                    "connection",
                    &headers("cancel-me", "interactive"),
                    RequestClass::Interactive,
                    "test",
                    || {
                        while !nodex_core::infrastructure::request_execution::request_is_cancelled()
                        {
                            std::thread::yield_now();
                        }
                        Err::<(), _>(cancelled())
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert!(executor.cancel("connection", "cancel-me"));
        assert_eq!(
            worker.await.unwrap().unwrap().unwrap_err().code,
            CoreErrorCode::Cancelled
        );
    }

    #[test]
    fn cancellation_before_blocking_dispatch_prevents_operation() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let executor = RequestExecutor::with_capacities(1, 1, 1, ADMISSION_CAPACITIES);
        let operation_ran = Arc::new(AtomicBool::new(false));

        runtime.block_on(async {
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                let _ = release_rx.recv();
            });
            started_rx.await.unwrap();

            let request_headers = headers("cancel-before-dispatch", "interactive");
            let operation_ran = Arc::clone(&operation_ran);
            let mut request = std::pin::pin!(executor.execute(
                "connection",
                &request_headers,
                RequestClass::Interactive,
                "test",
                move || {
                    operation_ran.store(true, Ordering::Relaxed);
                    Ok(())
                },
            ));
            // Poll through permit acquisition and dispatch with the blocking pool occupied.
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(request.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            assert_eq!(executor.total.available_permits(), 0);
            assert_eq!(executor.snapshot().classes.interactive.queued, 1);
            assert!(executor.cancel("connection", "cancel-before-dispatch"));
            assert_eq!(
                request.await.unwrap().unwrap_err().code,
                CoreErrorCode::Cancelled
            );
            drop(release_tx);
            blocker.await.unwrap();
            // The sole blocking thread must dispatch the queued request before this task.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
        });

        assert!(!operation_ran.load(Ordering::Relaxed));
        assert_eq!(executor.snapshot().classes, RequestClassHealth::default());
        assert_eq!(executor.total.available_permits(), 1);
    }

    #[tokio::test]
    async fn writer_deadline_releases_the_execution_permit_before_dequeue() {
        let directory = tempdir().expect("store");
        let runtime = StoreWriterRuntime::start(&directory.path().join("nodex.db"), 4)
            .expect("writer runtime");
        let writer = runtime.handle();
        let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let blocker_thread = {
            let writer = writer.clone();
            thread::spawn(move || {
                writer
                    .call(move |_| {
                        entered_sender.send(()).expect("entered");
                        release_receiver.recv().expect("released");
                        Ok(())
                    })
                    .expect("blocking writer job")
            })
        };
        let blocker = BlockedWriter {
            release: Some(release_sender),
            thread: Some(blocker_thread),
        };
        entered_receiver.recv().expect("writer blocked");

        let executor = RequestExecutor::with_capacities(1, 1, 1, ADMISSION_CAPACITIES);
        let deadline_headers = headers("writer-deadline", "interactive");
        let timed_executor = executor.clone();
        let timed_writer = writer.clone();
        let timed = tokio::spawn(async move {
            timed_executor
                .execute(
                    "connection",
                    &deadline_headers,
                    RequestClass::Interactive,
                    "test",
                    move || {
                        timed_writer
                            .call(|_| Ok(()))
                            .map_err(|error| worker_failed(&error.to_string()))
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while writer.queued_job_count() != 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("deadline request queued at writer");
        assert_eq!(
            timed
                .await
                .expect("deadline task")
                .expect("admitted")
                .expect_err("deadline")
                .code,
            CoreErrorCode::DeadlineExceeded,
        );

        let next = tokio::time::timeout(
            Duration::from_millis(100),
            executor.execute(
                "connection",
                &headers("after-writer-deadline", "interactive"),
                RequestClass::Interactive,
                "test",
                || Ok("permit-released"),
            ),
        )
        .await
        .expect("cancelled writer worker released its execution permit")
        .expect("admitted")
        .expect("next interactive request");
        assert_eq!(next, "permit-released");

        blocker.release();
    }

    #[tokio::test]
    async fn cancellation_before_request_registration_is_honored() {
        let executor = RequestExecutor::with_capacities(1, 1, 1, ADMISSION_CAPACITIES);
        let operation_ran = Arc::new(AtomicBool::new(false));
        let operation_ran_in_worker = Arc::clone(&operation_ran);
        assert!(executor.cancel("connection", "cancel-before-register"));

        let result = executor
            .execute(
                "connection",
                &headers("cancel-before-register", "interactive"),
                RequestClass::Interactive,
                "test",
                move || {
                    operation_ran_in_worker.store(true, Ordering::Relaxed);
                    Ok::<_, CoreError>(())
                },
            )
            .await;

        assert_eq!(result.unwrap().unwrap_err().code, CoreErrorCode::Cancelled);
        assert!(!operation_ran.load(Ordering::Relaxed));
    }

    #[test]
    fn duplicate_active_request_is_a_retryable_conflict() {
        let executor = RequestExecutor::with_capacities(1, 1, 1, ADMISSION_CAPACITIES);
        let spec = RequestSpec::from_headers(
            "connection",
            &headers("duplicate", "interactive"),
            RequestClass::Interactive,
        )
        .unwrap();
        let first_cancellation = QueryCancellation::new();
        let _first_guard = executor
            .admit(&spec, "test", &first_cancellation)
            .expect("admission")
            .expect("first request registration");

        let error = match executor
            .admit(&spec, "test", &QueryCancellation::new())
            .unwrap()
        {
            Ok(_) => panic!("duplicate request identity was accepted"),
            Err(error) => error,
        };

        assert_eq!(error.code, CoreErrorCode::Conflict);
        assert!(error.retryable);
    }
}
