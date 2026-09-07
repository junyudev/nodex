use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use super::metrics::{DurationMetric, DurationMetricSnapshot};
use super::request_execution::{
    RequestExecutionClass, RequestExecutionPhase, current_request_execution_class,
    current_request_execution_observer, enter_request_execution_phase, query_control,
};
use super::sqlite::{
    DEFAULT_QUERY_BUDGET, QueryCancellation, StoreError, StoreErrorCode, open_reader, open_writer,
    optimize_query_planner_before_close, query_interrupted, with_mut_query_deadline,
    with_query_deadline,
};

pub const DEFAULT_WRITER_QUEUE_CAPACITY: usize = 64;
pub const DEFAULT_READ_CONNECTIONS: usize = 4;
const READER_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITER_RESULT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const WRITER_PRIORITY_AGING_THRESHOLD: Duration = Duration::from_secs(2);
static NEXT_WRITER_COMMAND_ID: AtomicU64 = AtomicU64::new(1);

type WriterJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

struct QueuedWriterJob {
    command_id: u64,
    class: RequestExecutionClass,
    enqueued_at: Instant,
    deadline: Instant,
    cancellation: QueryCancellation,
    operation: WriterJob,
}

impl QueuedWriterJob {
    fn interruption(&self, now: Instant) -> Option<bool> {
        if self.cancellation.is_cancelled() {
            return Some(true);
        }
        (now >= self.deadline).then_some(false)
    }
}

#[derive(Clone)]
struct WriterEndpoint {
    queue: Arc<WriterQueue>,
}

#[derive(Default)]
struct WriterQueueState {
    interactive: VecDeque<QueuedWriterJob>,
    background: VecDeque<QueuedWriterJob>,
    maintenance: VecDeque<QueuedWriterJob>,
    prefer_interactive_after_aged_job: bool,
    closed: bool,
}

struct WriterQueue {
    capacity: usize,
    aging_threshold: Duration,
    state: Mutex<WriterQueueState>,
    available: Condvar,
}

#[derive(Debug)]
enum WriterQueuePushError {
    Full,
    Closed,
    Interrupted(bool),
}

impl WriterQueue {
    fn new(capacity: usize) -> Self {
        Self::with_aging(capacity, WRITER_PRIORITY_AGING_THRESHOLD)
    }

    fn with_aging(capacity: usize, aging_threshold: Duration) -> Self {
        Self {
            capacity,
            aging_threshold,
            state: Mutex::new(WriterQueueState::default()),
            available: Condvar::new(),
        }
    }

    fn try_push(&self, job: QueuedWriterJob) -> Result<(), WriterQueuePushError> {
        let Ok(mut state) = self.state.lock() else {
            return Err(WriterQueuePushError::Closed);
        };
        if state.closed {
            return Err(WriterQueuePushError::Closed);
        }
        let now = Instant::now();
        Self::prune_interrupted_locked(&mut state, now);
        if let Some(cancelled) = job.interruption(now) {
            return Err(WriterQueuePushError::Interrupted(cancelled));
        }
        if Self::len_locked(&state) >= self.capacity {
            return Err(WriterQueuePushError::Full);
        }
        match job.class {
            RequestExecutionClass::Interactive => state.interactive.push_back(job),
            RequestExecutionClass::Background => state.background.push_back(job),
            RequestExecutionClass::Maintenance => state.maintenance.push_back(job),
        }
        self.available.notify_one();
        Ok(())
    }

    fn recv(&self, shutdown: &AtomicBool) -> Option<QueuedWriterJob> {
        let mut state = self.state.lock().ok()?;
        loop {
            if shutdown.load(Ordering::Acquire) || state.closed {
                return None;
            }
            let now = Instant::now();
            Self::prune_interrupted_locked(&mut state, now);
            if let Some(job) = self.pop_next(&mut state, now) {
                return Some(job);
            }
            state = self.available.wait(state).ok()?;
        }
    }

    fn pop_next(&self, state: &mut WriterQueueState, now: Instant) -> Option<QueuedWriterJob> {
        if state.prefer_interactive_after_aged_job {
            state.prefer_interactive_after_aged_job = false;
            if let Some(job) = state.interactive.pop_front() {
                return Some(job);
            }
        }
        let background_aged = state.background.front().is_some_and(|job| {
            now.saturating_duration_since(job.enqueued_at) >= self.aging_threshold
        });
        let maintenance_aged = state.maintenance.front().is_some_and(|job| {
            now.saturating_duration_since(job.enqueued_at) >= self.aging_threshold
        });
        if background_aged || maintenance_aged {
            // Aging admits one lower-class job at a time. If interactive work
            // arrived before it finishes, the next dequeue serves that work
            // before promoting another aged job.
            state.prefer_interactive_after_aged_job = true;
            let choose_maintenance = match (state.background.front(), state.maintenance.front()) {
                (Some(background), Some(maintenance)) => {
                    maintenance_aged
                        && (!background_aged || maintenance.enqueued_at <= background.enqueued_at)
                }
                (None, Some(_)) => true,
                _ => false,
            };
            return if choose_maintenance {
                state.maintenance.pop_front()
            } else {
                state.background.pop_front()
            };
        }
        state
            .interactive
            .pop_front()
            .or_else(|| state.background.pop_front())
            .or_else(|| state.maintenance.pop_front())
    }

    fn len(&self) -> usize {
        self.state.lock().map_or(0, |mut state| {
            Self::prune_interrupted_locked(&mut state, Instant::now());
            Self::len_locked(&state)
        })
    }

    fn len_locked(state: &WriterQueueState) -> usize {
        state.interactive.len() + state.background.len() + state.maintenance.len()
    }

    fn prune_interrupted_locked(state: &mut WriterQueueState, now: Instant) {
        state
            .interactive
            .retain(|job| job.interruption(now).is_none());
        state
            .background
            .retain(|job| job.interruption(now).is_none());
        state
            .maintenance
            .retain(|job| job.interruption(now).is_none());
    }

    fn remove(&self, command_id: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.interactive.retain(|job| job.command_id != command_id);
        state.background.retain(|job| job.command_id != command_id);
        state.maintenance.retain(|job| job.command_id != command_id);
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.interactive.clear();
            state.background.clear();
            state.maintenance.clear();
        }
        self.available.notify_all();
    }
}

struct WriterGeneration {
    endpoint: WriterEndpoint,
    join: Option<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
}

impl WriterGeneration {
    fn start(path: &Path, queue_capacity: usize) -> Result<Self, StoreError> {
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let queue = Arc::new(WriterQueue::new(queue_capacity));
        let shutdown = Arc::new(AtomicBool::new(false));
        let writer_shutdown = Arc::clone(&shutdown);
        let writer_queue = Arc::clone(&queue);
        let path = path.to_owned();
        let join = thread::Builder::new()
            .name("nodex-sqlite-writer".to_owned())
            .spawn(move || writer_loop(&path, &writer_queue, ready_sender, &writer_shutdown))
            .map_err(|error| {
                StoreError::new(
                    StoreErrorCode::Internal,
                    format!("Could not start SQLite writer thread: {error}"),
                    false,
                )
            })?;
        ready_receiver.recv().map_err(|_| {
            StoreError::new(
                StoreErrorCode::WriterClosed,
                "SQLite writer stopped during initialization",
                false,
            )
        })??;
        Ok(Self {
            endpoint: WriterEndpoint { queue },
            join: Some(join),
            shutdown,
        })
    }

    fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.endpoint.queue.close();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn writer_loop(
    path: &Path,
    queue: &WriterQueue,
    ready: SyncSender<Result<(), StoreError>>,
    shutdown: &AtomicBool,
) {
    struct CloseQueueOnExit<'a>(&'a WriterQueue);
    impl Drop for CloseQueueOnExit<'_> {
        fn drop(&mut self) {
            self.0.close();
        }
    }
    let _close_queue_on_exit = CloseQueueOnExit(queue);
    let mut connection = match open_writer(path) {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    while !shutdown.load(Ordering::Acquire) {
        let Some(job) = queue.recv(shutdown) else {
            break;
        };
        (job.operation)(&mut connection);
    }
    if let Err(error) = optimize_query_planner_before_close(&connection) {
        tracing::warn!(
            error = %error,
            "SQLite query planner maintenance failed during writer shutdown"
        );
    }
}

struct ReadPoolState {
    idle: Vec<Connection>,
    total: usize,
}

struct ReadPoolInner {
    path: PathBuf,
    max_connections: usize,
    state: Mutex<ReadPoolState>,
    available: Condvar,
}

impl ReadPoolInner {
    fn new(path: &Path, max_connections: usize) -> Self {
        Self {
            path: path.to_owned(),
            max_connections,
            state: Mutex::new(ReadPoolState {
                idle: Vec::new(),
                total: 0,
            }),
            available: Condvar::new(),
        }
    }

    fn checkout(
        &self,
        request_deadline: Instant,
        cancellation: &QueryCancellation,
    ) -> Result<Connection, StoreError> {
        let pool_deadline = (Instant::now() + READER_WAIT_TIMEOUT).min(request_deadline);
        let mut state = self.state.lock().map_err(|_| poisoned_pool())?;
        loop {
            if cancellation.is_cancelled() || Instant::now() >= request_deadline {
                return Err(query_interrupted(cancellation.is_cancelled()));
            }
            if let Some(connection) = state.idle.pop() {
                return Ok(connection);
            }
            if state.total < self.max_connections {
                state.total += 1;
                drop(state);
                return match open_reader(&self.path) {
                    Ok(connection) => Ok(connection),
                    Err(error) => {
                        let mut state = self.state.lock().map_err(|_| poisoned_pool())?;
                        state.total -= 1;
                        self.available.notify_one();
                        Err(error)
                    }
                };
            }
            let remaining = pool_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(StoreError::new(
                    StoreErrorCode::ReaderPoolTimeout,
                    "Timed out waiting for a SQLite read connection",
                    true,
                ));
            }
            let poll = remaining.min(Duration::from_millis(50));
            let (next_state, wait) = self
                .available
                .wait_timeout(state, poll)
                .map_err(|_| poisoned_pool())?;
            state = next_state;
            if wait.timed_out() && state.idle.is_empty() && Instant::now() >= pool_deadline {
                if cancellation.is_cancelled() || Instant::now() >= request_deadline {
                    return Err(query_interrupted(cancellation.is_cancelled()));
                }
                return Err(StoreError::new(
                    StoreErrorCode::ReaderPoolTimeout,
                    "Timed out waiting for a SQLite read connection",
                    true,
                ));
            }
        }
    }

    fn checkin(&self, connection: Connection) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.idle.push(connection);
        self.available.notify_one();
    }
}

struct RuntimeGeneration {
    writer: Option<WriterGeneration>,
    readers: Option<Arc<ReadPoolInner>>,
}

impl RuntimeGeneration {
    fn start(
        path: &Path,
        writer_queue_capacity: Option<usize>,
        read_connections: Option<usize>,
    ) -> Result<Self, StoreError> {
        let writer = writer_queue_capacity
            .map(|capacity| WriterGeneration::start(path, capacity))
            .transpose()?;
        let readers =
            read_connections.map(|connections| Arc::new(ReadPoolInner::new(path, connections)));
        Ok(Self { writer, readers })
    }

    fn shutdown(self) {
        if let Some(writer) = self.writer {
            writer.shutdown();
        }
        drop(self.readers);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimePhase {
    Running,
    Maintenance,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreRuntimePhase {
    Running,
    Maintenance,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoreRuntimeActivity {
    pub phase: StoreRuntimePhase,
    pub active_writes: usize,
    pub active_reads: usize,
    pub queued_writes: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StoreRuntimeMetrics {
    pub command_latency: DurationMetricSnapshot,
    pub writer_queue_wait: DurationMetricSnapshot,
    pub writer_execution: DurationMetricSnapshot,
}

struct RuntimeState {
    phase: RuntimePhase,
    active_writes: usize,
    active_reads: usize,
    generation: Option<RuntimeGeneration>,
}

struct RuntimeControl {
    path: PathBuf,
    writer_queue_capacity: Option<usize>,
    read_connections: Option<usize>,
    state: Mutex<RuntimeState>,
    drained: Condvar,
    command_latency: DurationMetric,
    writer_queue_wait: DurationMetric,
    writer_execution: DurationMetric,
}

impl RuntimeControl {
    fn new(
        path: &Path,
        writer_queue_capacity: Option<usize>,
        read_connections: Option<usize>,
    ) -> Result<Arc<Self>, StoreError> {
        if writer_queue_capacity == Some(0) {
            return Err(internal("SQLite writer queue capacity must be positive"));
        }
        if read_connections == Some(0) {
            return Err(internal("SQLite reader pool size must be positive"));
        }
        let generation = RuntimeGeneration::start(path, writer_queue_capacity, read_connections)?;
        Ok(Arc::new(Self {
            path: path.to_owned(),
            writer_queue_capacity,
            read_connections,
            state: Mutex::new(RuntimeState {
                phase: RuntimePhase::Running,
                active_writes: 0,
                active_reads: 0,
                generation: Some(generation),
            }),
            drained: Condvar::new(),
            command_latency: DurationMetric::default(),
            writer_queue_wait: DurationMetric::default(),
            writer_execution: DurationMetric::default(),
        }))
    }

    fn acquire_writer(self: &Arc<Self>) -> Result<(WriterEndpoint, RuntimeLease), StoreError> {
        let mut state = self.state.lock().map_err(|_| poisoned_runtime())?;
        match state.phase {
            RuntimePhase::Maintenance => return Err(maintenance_in_progress()),
            RuntimePhase::Closed => return Err(writer_closed()),
            RuntimePhase::Running => {}
        }
        let endpoint = state
            .generation
            .as_ref()
            .and_then(|generation| generation.writer.as_ref())
            .map(|writer| writer.endpoint.clone())
            .ok_or_else(writer_closed)?;
        state.active_writes += 1;
        Ok((endpoint, RuntimeLease::write(Arc::clone(self))))
    }

    fn acquire_reader(self: &Arc<Self>) -> Result<(Arc<ReadPoolInner>, RuntimeLease), StoreError> {
        let mut state = self.state.lock().map_err(|_| poisoned_runtime())?;
        match state.phase {
            RuntimePhase::Maintenance => return Err(maintenance_in_progress()),
            RuntimePhase::Closed => return Err(reader_closed()),
            RuntimePhase::Running => {}
        }
        let pool = state
            .generation
            .as_ref()
            .and_then(|generation| generation.readers.as_ref())
            .cloned()
            .ok_or_else(reader_closed)?;
        state.active_reads += 1;
        Ok((pool, RuntimeLease::read(Arc::clone(self))))
    }

    fn release(&self, kind: LeaseKind) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match kind {
            LeaseKind::Write => state.active_writes = state.active_writes.saturating_sub(1),
            LeaseKind::Read => state.active_reads = state.active_reads.saturating_sub(1),
        }
        if state.active_writes == 0 && state.active_reads == 0 {
            self.drained.notify_all();
        }
    }

    fn begin_maintenance(&self) -> Result<RuntimeGeneration, StoreError> {
        let mut state = self.state.lock().map_err(|_| poisoned_runtime())?;
        match state.phase {
            RuntimePhase::Running => state.phase = RuntimePhase::Maintenance,
            RuntimePhase::Maintenance => return Err(maintenance_in_progress()),
            RuntimePhase::Closed => return Err(writer_closed()),
        }
        while state.active_writes != 0 || state.active_reads != 0 {
            state = self.drained.wait(state).map_err(|_| poisoned_runtime())?;
        }
        state
            .generation
            .take()
            .ok_or_else(|| internal("SQLite runtime generation is unavailable"))
    }

    fn resume(&self) -> Result<(), StoreError> {
        let generation = RuntimeGeneration::start(
            &self.path,
            self.writer_queue_capacity,
            self.read_connections,
        )?;
        let mut state = self.state.lock().map_err(|_| poisoned_runtime())?;
        if state.phase != RuntimePhase::Maintenance || state.generation.is_some() {
            generation.shutdown();
            return Err(internal(
                "SQLite runtime cannot publish a replacement generation",
            ));
        }
        state.generation = Some(generation);
        state.phase = RuntimePhase::Running;
        self.drained.notify_all();
        Ok(())
    }

    fn close(&self) {
        let generation = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.phase == RuntimePhase::Closed {
                return;
            }
            state.phase = RuntimePhase::Maintenance;
            while state.active_writes != 0 || state.active_reads != 0 {
                let Ok(next) = self.drained.wait(state) else {
                    return;
                };
                state = next;
            }
            state.phase = RuntimePhase::Closed;
            state.generation.take()
        };
        if let Some(generation) = generation {
            generation.shutdown();
        }
    }

    fn activity(&self) -> StoreRuntimeActivity {
        let Ok(state) = self.state.lock() else {
            return StoreRuntimeActivity {
                phase: StoreRuntimePhase::Maintenance,
                active_writes: 1,
                active_reads: 1,
                queued_writes: 1,
            };
        };
        let phase = match state.phase {
            RuntimePhase::Running => StoreRuntimePhase::Running,
            RuntimePhase::Maintenance => StoreRuntimePhase::Maintenance,
            RuntimePhase::Closed => StoreRuntimePhase::Closed,
        };
        let queued_writes = state
            .generation
            .as_ref()
            .and_then(|generation| generation.writer.as_ref())
            .map_or(0, |writer| writer.endpoint.queue.len());
        StoreRuntimeActivity {
            phase,
            active_writes: state.active_writes,
            active_reads: state.active_reads,
            queued_writes,
        }
    }

    fn metrics(&self) -> StoreRuntimeMetrics {
        StoreRuntimeMetrics {
            command_latency: self.command_latency.snapshot(),
            writer_queue_wait: self.writer_queue_wait.snapshot(),
            writer_execution: self.writer_execution.snapshot(),
        }
    }
}

#[derive(Clone, Copy)]
enum LeaseKind {
    Write,
    Read,
}

struct RuntimeLease {
    control: Arc<RuntimeControl>,
    kind: LeaseKind,
}

impl RuntimeLease {
    fn write(control: Arc<RuntimeControl>) -> Self {
        Self {
            control,
            kind: LeaseKind::Write,
        }
    }

    fn read(control: Arc<RuntimeControl>) -> Self {
        Self {
            control,
            kind: LeaseKind::Read,
        }
    }
}

impl Drop for RuntimeLease {
    fn drop(&mut self) {
        self.control.release(self.kind);
    }
}

pub struct StoreRuntime {
    control: Arc<RuntimeControl>,
}

impl StoreRuntime {
    pub fn start(
        path: &Path,
        writer_queue_capacity: usize,
        read_connections: usize,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            control: RuntimeControl::new(
                path,
                Some(writer_queue_capacity),
                Some(read_connections),
            )?,
        })
    }

    fn start_writer(path: &Path, writer_queue_capacity: usize) -> Result<Self, StoreError> {
        Ok(Self {
            control: RuntimeControl::new(path, Some(writer_queue_capacity), None)?,
        })
    }

    pub fn writer(&self) -> StoreWriter {
        StoreWriter {
            control: Arc::clone(&self.control),
        }
    }

    pub fn readers(&self) -> StoreReaders {
        StoreReaders {
            control: Arc::clone(&self.control),
        }
    }

    pub fn maintenance(&self) -> StoreMaintenance {
        StoreMaintenance {
            control: Arc::clone(&self.control),
        }
    }

    pub fn activity(&self) -> StoreRuntimeActivity {
        self.control.activity()
    }

    pub fn metrics(&self) -> StoreRuntimeMetrics {
        self.control.metrics()
    }
}

impl Drop for StoreRuntime {
    fn drop(&mut self) {
        self.control.close();
    }
}

#[derive(Clone)]
pub struct StoreWriter {
    control: Arc<RuntimeControl>,
}

impl StoreWriter {
    pub fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.call_with_budget(DEFAULT_QUERY_BUDGET, QueryCancellation::new(), operation)
    }

    pub fn call_with_budget<T: Send + 'static>(
        &self,
        budget: Duration,
        cancellation: QueryCancellation,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let (deadline, cancellation) = query_control(budget, cancellation);
        let class = current_request_execution_class();
        let execution_observer = current_request_execution_observer();
        let _writer_queue_phase = enter_request_execution_phase(RequestExecutionPhase::WriterQueue);
        let (endpoint, _lease) = self.control.acquire_writer()?;
        let started_at = Instant::now();
        let command_id = NEXT_WRITER_COMMAND_ID.fetch_add(1, Ordering::Relaxed);
        let writer_command_id = format!("writer:{}:{command_id}", std::process::id());
        let parent = tracing::Span::current();
        let command_span = tracing::debug_span!(
            parent: &parent,
            "sqlite_writer_command",
            writerCommandId = %writer_command_id,
        );
        let rejected_span = command_span.clone();
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let runtime_metrics = Arc::clone(&self.control);
        let queued_at = Instant::now();
        let job_cancellation = cancellation.clone();
        let queued_cancellation = cancellation.clone();
        let job_execution_observer = execution_observer.clone();
        let job = Box::new(move |connection: &mut Connection| {
            command_span.in_scope(|| {
                if let Some(observer) = &job_execution_observer {
                    observer.set_phase(RequestExecutionPhase::WriterExecution);
                }
                let queue_wait = queued_at.elapsed();
                runtime_metrics.writer_queue_wait.record(queue_wait);
                let queue_wait_ms = u64::try_from(queue_wait.as_millis()).unwrap_or(u64::MAX);
                let operation_started_at = Instant::now();
                // A caller can stop waiting before this queued tombstone reaches
                // the writer. The shared cancellation makes that later dequeue
                // a no-op instead of executing an expired domain operation.
                let result =
                    with_mut_query_deadline(connection, deadline, &job_cancellation, operation);
                let execution = operation_started_at.elapsed();
                runtime_metrics.writer_execution.record(execution);
                let duration_ms = u64::try_from(execution.as_millis()).unwrap_or(u64::MAX);
                match &result {
                    Ok(_) => tracing::debug!(
                        queueWaitMs = queue_wait_ms,
                        durationMs = duration_ms,
                        status = "ok",
                        "SQLite writer command completed"
                    ),
                    Err(error) => tracing::debug!(
                        queueWaitMs = queue_wait_ms,
                        durationMs = duration_ms,
                        status = "error",
                        errorCode = store_error_code_name(error.code),
                        "SQLite writer command completed"
                    ),
                }
                let _ = result_sender.send(result);
            });
        });
        endpoint
            .queue
            .try_push(QueuedWriterJob {
                command_id,
                class,
                enqueued_at: queued_at,
                deadline,
                cancellation: queued_cancellation,
                operation: job,
            })
            .map_err(|error| {
                let error = match error {
                    WriterQueuePushError::Full => StoreError::new(
                        StoreErrorCode::WriterQueueFull,
                        "SQLite writer queue is full",
                        true,
                    ),
                    WriterQueuePushError::Closed => writer_closed(),
                    WriterQueuePushError::Interrupted(cancelled) => query_interrupted(cancelled),
                };
                rejected_span.in_scope(|| {
                    tracing::warn!(
                        status = "rejected",
                        errorCode = store_error_code_name(error.code),
                        "SQLite writer command rejected"
                    );
                });
                error
            })?;
        let result = loop {
            if cancellation.is_cancelled() {
                endpoint.queue.remove(command_id);
                break Err(query_interrupted(true));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                endpoint.queue.remove(command_id);
                break Err(query_interrupted(false));
            }
            match result_receiver.recv_timeout(remaining.min(WRITER_RESULT_POLL_INTERVAL)) {
                Ok(result) => break result,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if cancellation.is_cancelled() {
                        break Err(query_interrupted(true));
                    }
                    if Instant::now() >= deadline {
                        break Err(query_interrupted(false));
                    }
                    break Err(StoreError::new(
                        StoreErrorCode::WriterClosed,
                        "SQLite writer stopped before returning a result",
                        true,
                    ));
                }
            }
        };
        self.control.command_latency.record(started_at.elapsed());
        result
    }

    pub fn queued_job_count(&self) -> usize {
        let Ok(state) = self.control.state.lock() else {
            return 0;
        };
        state
            .generation
            .as_ref()
            .and_then(|generation| generation.writer.as_ref())
            .map_or(0, |writer| writer.endpoint.queue.len())
    }
}

fn store_error_code_name(code: StoreErrorCode) -> &'static str {
    match code {
        StoreErrorCode::AlreadyOwned => "already_owned",
        StoreErrorCode::Conflict => "conflict",
        StoreErrorCode::GenerationConflict => "generation_conflict",
        StoreErrorCode::HeadConflict => "head_conflict",
        StoreErrorCode::PatchNotFound => "patch_not_found",
        StoreErrorCode::PatchAmbiguous => "patch_ambiguous",
        StoreErrorCode::PatchOverlap => "patch_overlap",
        StoreErrorCode::IdempotencyKeyReused => "idempotency_key_reused",
        StoreErrorCode::IdempotencyWindowExpired => "idempotency_window_expired",
        StoreErrorCode::LegacyIdempotencyUnavailable => "legacy_idempotency_unavailable",
        StoreErrorCode::ProtectedOwnerDeletion => "protected_owner_deletion",
        StoreErrorCode::InvalidInput => "invalid_input",
        StoreErrorCode::InvalidProfile => "invalid_profile",
        StoreErrorCode::MissingDependencies => "missing_dependencies",
        StoreErrorCode::MaterializationStale => "materialization_stale",
        StoreErrorCode::NotFound => "not_found",
        StoreErrorCode::RevisionConflict => "revision_conflict",
        StoreErrorCode::StaleStoreEpoch => "stale_store_epoch",
        StoreErrorCode::Unauthorized => "unauthorized",
        StoreErrorCode::ResourceExhausted => "resource_exhausted",
        StoreErrorCode::WriterQueueFull => "writer_queue_full",
        StoreErrorCode::WriterClosed => "writer_closed",
        StoreErrorCode::ReaderPoolTimeout => "reader_pool_timeout",
        StoreErrorCode::QueryCancelled => "query_cancelled",
        StoreErrorCode::DeadlineExceeded => "deadline_exceeded",
        StoreErrorCode::SqliteBusy => "sqlite_busy",
        StoreErrorCode::SqliteFailure => "sqlite_failure",
        StoreErrorCode::RuntimeIncompatible => "runtime_incompatible",
        StoreErrorCode::UnsupportedSchema => "unsupported_schema",
        StoreErrorCode::StoreCorrupt => "store_corrupt",
        StoreErrorCode::MaintenanceInProgress => "maintenance_in_progress",
        StoreErrorCode::Internal => "internal",
    }
}

pub struct StoreWriterRuntime {
    runtime: StoreRuntime,
}

impl StoreWriterRuntime {
    pub fn start(path: &Path, queue_capacity: usize) -> Result<Self, StoreError> {
        Ok(Self {
            runtime: StoreRuntime::start_writer(path, queue_capacity)?,
        })
    }

    pub fn handle(&self) -> StoreWriter {
        self.runtime.writer()
    }
}

#[derive(Clone)]
pub struct StoreReaders {
    control: Arc<RuntimeControl>,
}

impl StoreReaders {
    /// Own one pooled, read-only transaction for synchronous query providers.
    /// The final owner rolls back and returns the connection to the pool.
    pub(crate) fn snapshot(&self) -> Result<Arc<StoreReadSnapshot>, StoreError> {
        let (deadline, cancellation) =
            query_control(DEFAULT_QUERY_BUDGET, QueryCancellation::new());
        let (pool, lease) = self.control.acquire_reader()?;
        let checkout_phase = enter_request_execution_phase(RequestExecutionPhase::ReaderCheckout);
        let connection = pool.checkout(deadline, &cancellation)?;
        drop(checkout_phase);
        let snapshot = Arc::new(StoreReadSnapshot {
            connection: Mutex::new(Some(connection)),
            pool,
            _lease: lease,
            deadline,
            cancellation,
        });
        snapshot.read(|connection| {
            connection.execute_batch("BEGIN DEFERRED")?;
            Ok(())
        })?;
        Ok(snapshot)
    }

    pub fn new(path: &Path, max_connections: usize) -> Result<Self, StoreError> {
        Ok(Self {
            control: RuntimeControl::new(path, None, Some(max_connections))?,
        })
    }

    pub fn read<T>(
        &self,
        budget: Duration,
        cancellation: &QueryCancellation,
        operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let (deadline, cancellation) = query_control(budget, cancellation.clone());
        let (pool, _lease) = self.control.acquire_reader()?;
        let checkout_phase = enter_request_execution_phase(RequestExecutionPhase::ReaderCheckout);
        let connection = pool.checkout(deadline, &cancellation)?;
        drop(checkout_phase);
        let _query_phase = enter_request_execution_phase(RequestExecutionPhase::ReaderQuery);
        let result = with_query_deadline(&connection, deadline, &cancellation, operation);
        pool.checkin(connection);
        result
    }

    pub fn read_default<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.read(DEFAULT_QUERY_BUDGET, &QueryCancellation::new(), operation)
    }
}

/// A shared ownership handle, not a second connection or a resumable public snapshot.
pub(crate) struct StoreReadSnapshot {
    connection: Mutex<Option<Connection>>,
    pool: Arc<ReadPoolInner>,
    _lease: RuntimeLease,
    pub(crate) deadline: Instant,
    pub(crate) cancellation: QueryCancellation,
}

impl StoreReadSnapshot {
    pub(crate) fn read<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let connection = self.connection.lock().map_err(|_| poisoned_pool())?;
        let connection = connection.as_ref().ok_or_else(reader_closed)?;
        let _phase = enter_request_execution_phase(RequestExecutionPhase::ReaderQuery);
        with_query_deadline(connection, self.deadline, &self.cancellation, operation)
    }
}

impl Drop for StoreReadSnapshot {
    fn drop(&mut self) {
        let connection = self
            .connection
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(connection) = connection.take() {
            let _ = connection.execute_batch("ROLLBACK");
            if connection.is_autocommit() {
                self.pool.checkin(connection);
            } else {
                // A failed rollback must never lend the old transaction to a new request.
                drop(connection);
                let mut state = self
                    .pool
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                state.total = state.total.saturating_sub(1);
                self.pool.available.notify_one();
            }
        }
    }
}

#[derive(Clone)]
pub struct StoreMaintenance {
    control: Arc<RuntimeControl>,
}

impl StoreMaintenance {
    pub fn run<T>(
        &self,
        operation: impl FnOnce(&Path) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let generation = self.control.begin_maintenance()?;
        generation.shutdown();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            operation(&self.control.path)
        }));
        let resume = self.control.resume();
        match result {
            Ok(operation_result) => {
                resume?;
                operation_result
            }
            Err(payload) => {
                let _ = resume;
                std::panic::resume_unwind(payload)
            }
        }
    }
}

fn poisoned_pool() -> StoreError {
    internal("SQLite read pool synchronization failed")
}

fn poisoned_runtime() -> StoreError {
    internal("SQLite runtime synchronization failed")
}

fn maintenance_in_progress() -> StoreError {
    StoreError::new(
        StoreErrorCode::MaintenanceInProgress,
        "The SQLite store is temporarily unavailable for maintenance",
        true,
    )
}

fn writer_closed() -> StoreError {
    StoreError::new(
        StoreErrorCode::WriterClosed,
        "SQLite writer is unavailable",
        true,
    )
}

fn reader_closed() -> StoreError {
    StoreError::new(
        StoreErrorCode::ReaderPoolTimeout,
        "SQLite readers are unavailable",
        true,
    )
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;

    use tempfile::tempdir;

    use crate::infrastructure::request_execution::{
        RequestExecutionContext, within_request_execution,
    };
    use crate::infrastructure::sqlite::with_immediate_transaction;

    use super::*;

    #[test]
    fn dropped_snapshot_releases_its_transaction_and_cancelled_reader() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreRuntime::start(&path, 2, 1).expect("single-reader runtime");
        runtime.writer().call(|connection| {
            connection.execute_batch("CREATE TABLE snapshot_probe(value INTEGER); INSERT INTO snapshot_probe VALUES(1)")?;
            Ok(())
        }).unwrap();
        let readers = runtime.readers();
        let snapshot = readers.snapshot().unwrap();
        let observed = snapshot
            .read(|connection| {
                Ok(
                    connection.query_row("SELECT value FROM snapshot_probe", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(observed, 1);
        runtime
            .writer()
            .call(|connection| {
                connection.execute("UPDATE snapshot_probe SET value=2", [])?;
                Ok(())
            })
            .unwrap();
        let still_observed = snapshot
            .read(|connection| {
                Ok(
                    connection.query_row("SELECT value FROM snapshot_probe", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(still_observed, 1);
        snapshot.cancellation.cancel();
        assert_eq!(
            snapshot.read(|_| Ok(())).unwrap_err().code,
            StoreErrorCode::QueryCancelled
        );
        drop(snapshot);
        let current = readers
            .read_default(|connection| {
                assert!(connection.is_autocommit());
                Ok(
                    connection.query_row("SELECT value FROM snapshot_probe", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(current, 2);
    }

    fn queued_test_job(class: RequestExecutionClass, enqueued_at: Instant) -> QueuedWriterJob {
        QueuedWriterJob {
            command_id: NEXT_WRITER_COMMAND_ID.fetch_add(1, Ordering::Relaxed),
            class,
            enqueued_at,
            deadline: enqueued_at + Duration::from_secs(60),
            cancellation: QueryCancellation::new(),
            operation: Box::new(|_| {}),
        }
    }

    #[test]
    fn writer_queue_prioritizes_interactive_work_until_lower_classes_age() {
        let queue = WriterQueue::with_aging(8, Duration::from_secs(1));
        let now = Instant::now();
        queue
            .try_push(queued_test_job(RequestExecutionClass::Maintenance, now))
            .expect("maintenance queued");
        queue
            .try_push(queued_test_job(RequestExecutionClass::Background, now))
            .expect("background queued");
        queue
            .try_push(queued_test_job(RequestExecutionClass::Interactive, now))
            .expect("interactive queued");

        let mut state = queue.state.lock().expect("writer queue");
        assert_eq!(
            queue.pop_next(&mut state, now).map(|job| job.class),
            Some(RequestExecutionClass::Interactive)
        );
        assert_eq!(
            queue
                .pop_next(&mut state, now + Duration::from_secs(2))
                .map(|job| job.class),
            Some(RequestExecutionClass::Maintenance)
        );
        assert_eq!(
            queue
                .pop_next(&mut state, now + Duration::from_secs(2))
                .map(|job| job.class),
            Some(RequestExecutionClass::Background)
        );
    }

    #[test]
    fn each_aged_promotion_yields_back_to_queued_interactive_work() {
        let queue = WriterQueue::with_aging(8, Duration::from_secs(1));
        let now = Instant::now();
        for _ in 0..2 {
            queue
                .try_push(queued_test_job(RequestExecutionClass::Maintenance, now))
                .expect("maintenance queued");
            queue
                .try_push(queued_test_job(RequestExecutionClass::Interactive, now))
                .expect("interactive queued");
        }

        let mut state = queue.state.lock().expect("writer queue");
        let aged = now + Duration::from_secs(2);
        assert_eq!(
            queue.pop_next(&mut state, aged).map(|job| job.class),
            Some(RequestExecutionClass::Maintenance)
        );
        assert_eq!(
            queue.pop_next(&mut state, aged).map(|job| job.class),
            Some(RequestExecutionClass::Interactive)
        );
        assert_eq!(
            queue.pop_next(&mut state, aged).map(|job| job.class),
            Some(RequestExecutionClass::Maintenance)
        );
        assert_eq!(
            queue.pop_next(&mut state, aged).map(|job| job.class),
            Some(RequestExecutionClass::Interactive)
        );
    }

    #[test]
    fn interactive_writer_runs_before_an_earlier_unaged_maintenance_job() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreWriterRuntime::start(&path, 4).expect("writer runtime");
        let writer = runtime.handle();
        let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let blocker = {
            let writer = writer.clone();
            thread::spawn(move || {
                writer.call(move |_| {
                    entered_sender.send(()).expect("entered signal");
                    release_receiver.recv().expect("release signal");
                    Ok(())
                })
            })
        };
        entered_receiver.recv().expect("blocker entered");

        let (order_sender, order_receiver) = mpsc::sync_channel(2);
        let maintenance = {
            let writer = writer.clone();
            let order_sender = order_sender.clone();
            thread::spawn(move || {
                within_request_execution(
                    RequestExecutionContext::new(
                        RequestExecutionClass::Maintenance,
                        QueryCancellation::new(),
                        Instant::now() + Duration::from_secs(5),
                    ),
                    || {
                        writer.call(move |_| {
                            order_sender.send("maintenance").expect("order");
                            Ok(())
                        })
                    },
                )
            })
        };
        while writer.queued_job_count() != 1 {
            thread::yield_now();
        }
        let interactive = {
            let writer = writer.clone();
            thread::spawn(move || {
                writer.call(move |_| {
                    order_sender.send("interactive").expect("order");
                    Ok(())
                })
            })
        };
        while writer.queued_job_count() != 2 {
            thread::yield_now();
        }
        release_sender.send(()).expect("release blocker");

        assert_eq!(order_receiver.recv().expect("first order"), "interactive");
        assert_eq!(order_receiver.recv().expect("second order"), "maintenance");
        assert!(blocker.join().expect("blocker join").is_ok());
        assert!(maintenance.join().expect("maintenance join").is_ok());
        assert!(interactive.join().expect("interactive join").is_ok());
    }

    #[test]
    fn dedicated_writer_serializes_jobs_and_readers_are_query_only() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreWriterRuntime::start(&path, DEFAULT_WRITER_QUEUE_CAPACITY)
            .expect("writer runtime");
        let caller_thread = thread::current().id();
        let writer_thread = runtime
            .handle()
            .call(move |connection| {
                assert_ne!(thread::current().id(), caller_thread);
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute_batch(
                        "CREATE TABLE ordered_values(position INTEGER PRIMARY KEY, value TEXT NOT NULL);\n\
                         INSERT INTO ordered_values(position, value) VALUES (1, 'first');",
                    )?;
                    Ok(thread::current().id())
                })
            })
            .expect("writer job");
        assert_ne!(writer_thread, thread::current().id());
        runtime
            .handle()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO ordered_values(position, value) VALUES (2, 'second')",
                    [],
                )?;
                Ok(())
            })
            .expect("second writer job");
        let command_latency = runtime.runtime.metrics().command_latency;
        assert_eq!(command_latency.count, 2);
        assert!(command_latency.total_micros >= command_latency.last_micros);

        let readers = StoreReaders::new(&path, 2).expect("read pool");
        let values = readers
            .read_default(|connection| {
                let values = connection
                    .prepare("SELECT value FROM ordered_values ORDER BY position")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert!(
                    connection
                        .execute("DELETE FROM ordered_values", [])
                        .is_err()
                );
                Ok(values)
            })
            .expect("read values");
        assert_eq!(values, vec!["first", "second"]);
    }

    #[test]
    fn bounded_writer_queue_rejects_excess_work() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreWriterRuntime::start(&path, 1).expect("writer runtime");
        let writer = runtime.handle();
        let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let first_writer = writer.clone();
        let first = thread::spawn(move || {
            first_writer.call(move |_| {
                entered_sender.send(()).expect("entered signal");
                release_receiver.recv().expect("release signal");
                Ok(())
            })
        });
        entered_receiver.recv().expect("first job entered");

        let second_writer = writer.clone();
        let second = thread::spawn(move || second_writer.call(|_| Ok(())));
        while writer.queued_job_count() != 1 {
            thread::yield_now();
        }
        let saturated = writer
            .call(|_| Ok::<_, StoreError>(()))
            .expect_err("third job exceeds queue capacity");
        assert_eq!(saturated.code, StoreErrorCode::WriterQueueFull);
        release_sender.send(()).expect("release first");
        assert!(first.join().expect("first join").is_ok());
        assert!(second.join().expect("second join").is_ok());
    }

    #[test]
    fn cancelled_queued_writer_releases_its_caller_without_late_execution() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreWriterRuntime::start(&path, 1).expect("writer runtime");
        let writer = runtime.handle();
        let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let first_writer = writer.clone();
        let first = thread::spawn(move || {
            first_writer.call(move |_| {
                entered_sender.send(()).expect("entered signal");
                release_receiver.recv().expect("release signal");
                Ok(())
            })
        });
        entered_receiver.recv().expect("first job entered");

        let cancellation = QueryCancellation::new();
        let caller_cancellation = cancellation.clone();
        let operation_ran = Arc::new(AtomicBool::new(false));
        let operation_ran_in_job = Arc::clone(&operation_ran);
        let queued_writer = writer.clone();
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let queued = thread::spawn(move || {
            let result = queued_writer.call_with_budget(
                Duration::from_secs(5),
                caller_cancellation,
                move |_| {
                    operation_ran_in_job.store(true, Ordering::Release);
                    Ok(())
                },
            );
            result_sender.send(result).expect("queued result");
        });
        while writer.queued_job_count() != 1 {
            thread::yield_now();
        }

        cancellation.cancel();
        let cancelled = result_receiver
            .recv_timeout(Duration::from_millis(250))
            .expect("cancelled caller released before the writer")
            .expect_err("cancelled job");
        assert_eq!(cancelled.code, StoreErrorCode::QueryCancelled);
        assert!(!operation_ran.load(Ordering::Acquire));
        assert_eq!(writer.queued_job_count(), 0);

        let replacement_writer = writer.clone();
        let replacement = thread::spawn(move || replacement_writer.call(|_| Ok("replacement")));
        while writer.queued_job_count() != 1 {
            thread::yield_now();
        }

        release_sender.send(()).expect("release first");
        assert!(first.join().expect("first join").is_ok());
        queued.join().expect("queued join");
        assert_eq!(
            replacement.join().expect("replacement join").unwrap(),
            "replacement"
        );
        while writer.queued_job_count() != 0 {
            thread::yield_now();
        }
        assert!(!operation_ran.load(Ordering::Acquire));
    }

    #[test]
    fn queued_writer_reports_its_absolute_deadline_before_dequeue() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreWriterRuntime::start(&path, 2).expect("writer runtime");
        let writer = runtime.handle();
        let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let first_writer = writer.clone();
        let first = thread::spawn(move || {
            first_writer.call(move |_| {
                entered_sender.send(()).expect("entered signal");
                release_receiver.recv().expect("release signal");
                Ok(())
            })
        });
        entered_receiver.recv().expect("first job entered");

        let operation_ran = Arc::new(AtomicBool::new(false));
        let operation_ran_in_job = Arc::clone(&operation_ran);
        let queued_writer = writer.clone();
        let expired = thread::spawn(move || {
            queued_writer.call_with_budget(
                Duration::from_millis(25),
                QueryCancellation::new(),
                move |_| {
                    operation_ran_in_job.store(true, Ordering::Release);
                    Ok(())
                },
            )
        })
        .join()
        .expect("deadline caller join")
        .expect_err("queued deadline");
        assert_eq!(expired.code, StoreErrorCode::DeadlineExceeded);
        assert_eq!(writer.queued_job_count(), 0);

        release_sender.send(()).expect("release first");
        assert!(first.join().expect("first join").is_ok());
        while writer.queued_job_count() != 0 {
            thread::yield_now();
        }
        assert!(!operation_ran.load(Ordering::Acquire));
    }

    #[test]
    fn maintenance_drains_closes_rejects_and_reuses_stable_handles() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreRuntime::start(&path, 4, 2).expect("restartable runtime");
        let writer = runtime.writer();
        let readers = runtime.readers();
        let maintenance = runtime.maintenance();
        writer
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE generation_values(value TEXT NOT NULL);\n\
                     INSERT INTO generation_values(value) VALUES ('before');",
                )?;
                Ok(())
            })
            .expect("seed store");

        let writer_during = writer.clone();
        let readers_during = readers.clone();
        maintenance
            .run(|database_path| {
                let writer_error = writer_during
                    .call(|_| Ok(()))
                    .expect_err("writer fenced during maintenance");
                assert_eq!(writer_error.code, StoreErrorCode::MaintenanceInProgress);
                let reader_error = readers_during
                    .read_default(|_| Ok(()))
                    .expect_err("reader fenced during maintenance");
                assert_eq!(reader_error.code, StoreErrorCode::MaintenanceInProgress);

                let connection = open_writer(database_path)?;
                connection.execute(
                    "INSERT INTO generation_values(value) VALUES ('maintenance')",
                    [],
                )?;
                Ok(())
            })
            .expect("maintenance");

        writer
            .call(|connection| {
                connection.execute("INSERT INTO generation_values(value) VALUES ('after')", [])?;
                Ok(())
            })
            .expect("writer resumed");
        let values = readers
            .read_default(|connection| {
                connection
                    .prepare("SELECT value FROM generation_values ORDER BY rowid")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(Into::into)
            })
            .expect("read replacement generation");
        assert_eq!(values, ["before", "maintenance", "after"]);
    }

    #[test]
    fn maintenance_waits_for_every_accepted_read_and_write() {
        let directory = tempdir().expect("store");
        let path = directory.path().join("nodex.db");
        let runtime = StoreRuntime::start(&path, 4, 2).expect("restartable runtime");
        let writer = runtime.writer();
        let readers = runtime.readers();
        writer
            .call(|connection| {
                connection.execute_batch("CREATE TABLE drain_probe(value INTEGER NOT NULL);")?;
                Ok(())
            })
            .expect("probe table");

        let (write_entered_sender, write_entered_receiver) = mpsc::sync_channel(1);
        let (write_release_sender, write_release_receiver) = mpsc::sync_channel(1);
        let active_writer = writer.clone();
        let write = thread::spawn(move || {
            active_writer.call(move |_| {
                write_entered_sender.send(()).expect("write entered");
                write_release_receiver.recv().expect("write release");
                Ok(())
            })
        });
        write_entered_receiver.recv().expect("accepted writer");

        let (read_entered_sender, read_entered_receiver) = mpsc::sync_channel(1);
        let (read_release_sender, read_release_receiver) = mpsc::sync_channel(1);
        let active_readers = readers.clone();
        let read = thread::spawn(move || {
            active_readers.read_default(move |_| {
                read_entered_sender.send(()).expect("read entered");
                read_release_receiver.recv().expect("read release");
                Ok(())
            })
        });
        read_entered_receiver.recv().expect("accepted reader");

        let maintenance = runtime.maintenance();
        let maintenance_control = Arc::clone(&maintenance.control);
        let (maintenance_entered_sender, maintenance_entered_receiver) = mpsc::sync_channel(1);
        let maintenance_thread = thread::spawn(move || {
            maintenance.run(|_| {
                maintenance_entered_sender
                    .send(())
                    .expect("maintenance entered");
                Ok(())
            })
        });
        loop {
            let phase = maintenance_control
                .state
                .lock()
                .expect("runtime state")
                .phase;
            if phase == RuntimePhase::Maintenance {
                break;
            }
            thread::yield_now();
        }
        assert!(matches!(
            maintenance_entered_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert_eq!(
            writer.call(|_| Ok(())).expect_err("new write fenced").code,
            StoreErrorCode::MaintenanceInProgress
        );
        assert_eq!(
            readers
                .read_default(|_| Ok(()))
                .expect_err("new read fenced")
                .code,
            StoreErrorCode::MaintenanceInProgress
        );

        write_release_sender.send(()).expect("release writer");
        assert!(write.join().expect("writer join").is_ok());
        assert!(matches!(
            maintenance_entered_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        read_release_sender.send(()).expect("release reader");
        assert!(read.join().expect("reader join").is_ok());
        maintenance_entered_receiver
            .recv()
            .expect("maintenance starts after drain");
        assert!(maintenance_thread.join().expect("maintenance join").is_ok());
    }
}
