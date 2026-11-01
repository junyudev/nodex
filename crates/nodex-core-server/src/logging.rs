use nodex_platform::private_fs::OpenOptions;
use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tracing::field::{Field, Visit};
use tracing::{Event, Id, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{Layer, Registry};

const DEFAULT_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_ENTRIES: usize = 10_000;
const DEFAULT_MAX_QUEUE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_STRING_LENGTH: usize = 1_200;
const DEFAULT_RETENTION_DAYS: u64 = 14;
const DEFAULT_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const LOG_DIRECTORY_MODE: u32 = 0o700;
const LOG_FILE_MODE: u32 = 0o600;
const LOG_PREFIX: &str = "core-";
const LOG_SUFFIX: &str = ".log";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Silent,
}

impl LogLevel {
    fn from_tracing(level: &Level) -> Self {
        match *level {
            Level::TRACE => Self::Trace,
            Level::DEBUG => Self::Debug,
            Level::INFO => Self::Info,
            Level::WARN => Self::Warn,
            Level::ERROR => Self::Error,
        }
    }

    fn parse(value: Option<&str>, fallback: Self) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("trace") => Self::Trace,
            Some("debug") => Self::Debug,
            Some("info") => Self::Info,
            Some("warn") => Self::Warn,
            Some("error") => Self::Error,
            Some("silent") => Self::Silent,
            _ => fallback,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Silent => "silent",
        }
    }

    fn enabled(self, threshold: Self) -> bool {
        threshold != Self::Silent && self >= threshold
    }

    fn index(self) -> usize {
        match self {
            Self::Trace => 0,
            Self::Debug => 1,
            Self::Info => 2,
            Self::Warn => 3,
            Self::Error => 4,
            Self::Silent => 5,
        }
    }
}

#[derive(Clone)]
struct LoggingConfig {
    console_enabled: bool,
    file_enabled: bool,
    console_level: LogLevel,
    file_level: LogLevel,
    log_dir: PathBuf,
    segment_prefix: String,
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_queue_entries: usize,
    max_queue_bytes: usize,
    max_string_length: usize,
    retention_days: u64,
    flush_timeout: Duration,
}

impl LoggingConfig {
    fn from_environment(home: &Path) -> Self {
        let default_sink_enabled = !packaged_runtime() && !test_runtime();
        let legacy_level = env::var("NODEX_LOG_LEVEL").ok();
        let console_level = LogLevel::parse(
            env::var("NODEX_LOG_CONSOLE_LEVEL").ok().as_deref(),
            LogLevel::parse(legacy_level.as_deref(), LogLevel::Warn),
        );
        let file_level = LogLevel::parse(
            env::var("NODEX_LOG_FILE_LEVEL").ok().as_deref(),
            LogLevel::parse(legacy_level.as_deref(), LogLevel::Info),
        );
        let log_dir = env::var_os("NODEX_LOG_DIR").map_or_else(
            || home.join("logs"),
            |configured| {
                let configured = PathBuf::from(configured);
                if configured.is_absolute() {
                    configured
                } else {
                    env::current_dir()
                        .unwrap_or_else(|_| home.to_path_buf())
                        .join(configured)
                }
            },
        );
        let max_file_bytes =
            parse_u64_env("NODEX_LOG_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES, 1_024);
        let max_total_bytes =
            parse_u64_env("NODEX_LOG_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES, 1_024)
                .max(max_file_bytes);
        Self {
            console_enabled: parse_bool_env("NODEX_LOG_CONSOLE", default_sink_enabled),
            file_enabled: parse_bool_env("NODEX_LOG_FILE", default_sink_enabled),
            console_level,
            file_level,
            log_dir,
            segment_prefix: profile_segment_prefix(home),
            max_file_bytes,
            max_total_bytes,
            max_queue_entries: parse_usize_env(
                "NODEX_LOG_MAX_QUEUE_ENTRIES",
                DEFAULT_MAX_QUEUE_ENTRIES,
                1,
            ),
            max_queue_bytes: parse_usize_env(
                "NODEX_LOG_MAX_QUEUE_BYTES",
                DEFAULT_MAX_QUEUE_BYTES,
                1_024,
            ),
            max_string_length: parse_usize_env(
                "NODEX_LOG_MAX_STRING_LENGTH",
                DEFAULT_MAX_STRING_LENGTH,
                80,
            ),
            retention_days: parse_u64_env("NODEX_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1),
            flush_timeout: Duration::from_millis(parse_u64_env(
                "NODEX_LOG_FLUSH_TIMEOUT_MS",
                DEFAULT_FLUSH_TIMEOUT.as_millis() as u64,
                100,
            )),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct LoggingHandle {
    dropped_records: Arc<AtomicU64>,
}

impl LoggingHandle {
    pub(crate) fn dropped_records(&self) -> u64 {
        self.dropped_records.load(Ordering::Acquire)
    }
}

pub(crate) struct LoggingGuard {
    workers: Vec<LogWorkerGuard>,
    flush_timeout: Duration,
}

struct LogWorkerGuard {
    queue: Arc<LogQueue>,
    done: mpsc::Receiver<()>,
}

impl LoggingGuard {
    pub(crate) fn shutdown(mut self) {
        self.close_and_wait();
    }

    fn close_and_wait(&mut self) {
        for worker in &self.workers {
            worker.queue.close();
        }
        let deadline = std::time::Instant::now() + self.flush_timeout;
        for worker in self.workers.drain(..) {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let _ = worker.done.recv_timeout(remaining);
        }
    }
}

impl Drop for LoggingGuard {
    fn drop(&mut self) {
        self.close_and_wait();
    }
}

pub(crate) fn install(home: &Path) -> (LoggingGuard, LoggingHandle) {
    let config = LoggingConfig::from_environment(home);
    let handle = LoggingHandle::default();
    let mut guard = LoggingGuard {
        workers: Vec::new(),
        flush_timeout: config.flush_timeout,
    };
    let file_active = Arc::new(AtomicBool::new(config.file_enabled));
    let console_active = Arc::new(AtomicBool::new(config.console_enabled));
    let file_queue = config.file_enabled.then(|| {
        Arc::new(LogQueue::new(
            "file",
            config.max_queue_entries,
            config.max_queue_bytes,
            Arc::clone(&handle.dropped_records),
        ))
    });
    if let Some(queue) = file_queue.as_ref() {
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let worker_queue = Arc::clone(queue);
        let worker_config = config.clone();
        let worker_file_active = Arc::clone(&file_active);
        match thread::Builder::new()
            .name("nodex-core-log-writer".to_owned())
            .spawn(move || {
                run_file_sink(worker_queue, worker_config, worker_file_active);
                let _ = done_sender.send(());
            }) {
            Ok(_) => {
                guard.workers.push(LogWorkerGuard {
                    queue: Arc::clone(queue),
                    done: done_receiver,
                });
            }
            Err(_) => {
                file_active.store(false, Ordering::Release);
                emergency("Core file logger worker could not start");
            }
        }
    }
    let console_queue = config.console_enabled.then(|| {
        Arc::new(LogQueue::new(
            "console",
            config.max_queue_entries,
            config.max_queue_bytes,
            Arc::clone(&handle.dropped_records),
        ))
    });
    if let Some(queue) = console_queue.as_ref() {
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let worker_queue = Arc::clone(queue);
        let worker_console_active = Arc::clone(&console_active);
        match thread::Builder::new()
            .name("nodex-core-console-log-writer".to_owned())
            .spawn(move || {
                run_console_sink(worker_queue, worker_console_active);
                let _ = done_sender.send(());
            }) {
            Ok(_) => {
                guard.workers.push(LogWorkerGuard {
                    queue: Arc::clone(queue),
                    done: done_receiver,
                });
            }
            Err(_) => {
                console_active.store(false, Ordering::Release);
                emergency("Core console logger worker could not start");
            }
        }
    }
    if !config.console_enabled && !config.file_enabled {
        return (guard, handle);
    }
    let layer = JsonLayer {
        console_level: config.console_level,
        file_level: config.file_level,
        max_string_length: config.max_string_length,
        console_queue,
        file_queue,
        console_active,
        file_active,
    };
    if tracing::subscriber::set_global_default(Registry::default().with(layer)).is_err() {
        emergency("Core structured logger could not become the global subscriber");
        guard.close_and_wait();
    }
    (guard, handle)
}

#[derive(Default)]
struct SpanFields(BTreeMap<String, Value>);

struct JsonLayer {
    console_level: LogLevel,
    file_level: LogLevel,
    max_string_length: usize,
    console_queue: Option<Arc<LogQueue>>,
    file_queue: Option<Arc<LogQueue>>,
    console_active: Arc<AtomicBool>,
    file_active: Arc<AtomicBool>,
}

impl<S> Layer<S> for JsonLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn enabled(&self, metadata: &Metadata<'_>, _context: Context<'_, S>) -> bool {
        if metadata.is_span() {
            return self.console_active.load(Ordering::Acquire)
                || self.file_active.load(Ordering::Acquire);
        }
        let level = LogLevel::from_tracing(metadata.level());
        (self.console_active.load(Ordering::Acquire) && level.enabled(self.console_level))
            || (self.file_active.load(Ordering::Acquire) && level.enabled(self.file_level))
    }

    fn on_new_span(
        &self,
        attributes: &tracing::span::Attributes<'_>,
        id: &Id,
        context: Context<'_, S>,
    ) {
        let Some(span) = context.span(id) else {
            return;
        };
        let mut fields = SpanFields::default();
        attributes.record(&mut JsonVisitor::new(&mut fields.0, self.max_string_length));
        span.extensions_mut().insert(fields);
    }

    fn on_record(&self, id: &Id, values: &tracing::span::Record<'_>, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(fields) = extensions.get_mut::<SpanFields>() else {
            return;
        };
        values.record(&mut JsonVisitor::new(&mut fields.0, self.max_string_length));
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let level = LogLevel::from_tracing(event.metadata().level());
        let mut fields = BTreeMap::new();
        if let Some(scope) = context.event_scope(event) {
            for span in scope.from_root() {
                let extensions = span.extensions();
                if let Some(span_fields) = extensions.get::<SpanFields>() {
                    fields.extend(span_fields.0.clone());
                }
            }
        }
        event.record(&mut JsonVisitor::new(&mut fields, self.max_string_length));
        let message = fields
            .remove("message")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .unwrap_or_else(|| event.metadata().name().to_owned());
        let line = serialize_line(level, &message, fields);
        if level.enabled(self.console_level)
            && self.console_active.load(Ordering::Acquire)
            && let Some(queue) = self.console_queue.as_ref()
        {
            queue.push(level, line.clone());
        }
        if level.enabled(self.file_level)
            && self.file_active.load(Ordering::Acquire)
            && let Some(queue) = self.file_queue.as_ref()
        {
            queue.push(level, line);
        }
    }
}

struct JsonVisitor<'a> {
    fields: &'a mut BTreeMap<String, Value>,
    max_string_length: usize,
}

impl<'a> JsonVisitor<'a> {
    fn new(fields: &'a mut BTreeMap<String, Value>, max_string_length: usize) -> Self {
        Self {
            fields,
            max_string_length,
        }
    }

    fn insert(&mut self, field: &Field, value: Value) {
        let value = if sensitive_key(field.name()) {
            Value::String("[REDACTED]".to_owned())
        } else {
            bound_value(value, self.max_string_length)
        };
        self.fields.insert(field.name().to_owned(), value);
    }
}

impl Visit for JsonVisitor<'_> {
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, Value::Bool(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.insert(field, Value::from(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field, Value::String(value.to_owned()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.insert(
            field,
            Value::String(bounded_debug(value, self.max_string_length)),
        );
    }
}

struct BoundedFormatter {
    value: String,
    remaining: usize,
    truncated: bool,
}

impl BoundedFormatter {
    fn new(max_length: usize) -> Self {
        Self {
            value: String::new(),
            remaining: max_length,
            truncated: false,
        }
    }

    fn finish(mut self) -> String {
        if self.truncated {
            self.value.push_str("…[truncated]");
        }
        self.value
    }
}

impl std::fmt::Write for BoundedFormatter {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        if self.remaining == 0 {
            self.truncated = true;
            return Ok(());
        }
        let available = value.chars().count();
        if available <= self.remaining {
            self.value.push_str(value);
            self.remaining -= available;
            return Ok(());
        }
        self.value.extend(value.chars().take(self.remaining));
        self.remaining = 0;
        self.truncated = true;
        Ok(())
    }
}

fn bounded_debug(value: &dyn std::fmt::Debug, max_length: usize) -> String {
    use std::fmt::Write as _;

    let mut formatter = BoundedFormatter::new(max_length);
    let _ = write!(formatter, "{value:?}");
    formatter.finish()
}

fn bound_value(value: Value, max_string_length: usize) -> Value {
    match value {
        Value::String(value) => Value::String(truncate_string(&value, max_string_length)),
        value => value,
    }
}

fn truncate_string(value: &str, max_length: usize) -> String {
    if value.chars().count() <= max_length {
        return value.to_owned();
    }
    let mut truncated = value.chars().take(max_length).collect::<String>();
    truncated.push_str("…[truncated]");
    truncated
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "password",
        "pass",
        "secret",
        "token",
        "apikey",
        "authorization",
        "cookie",
        "session",
        "credential",
    ]
    .iter()
    .any(|sensitive| normalized.contains(sensitive))
}

fn serialize_line(level: LogLevel, message: &str, fields: BTreeMap<String, Value>) -> String {
    let mut entry = Map::new();
    entry.insert(
        "ts".to_owned(),
        Value::String(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    entry.insert("level".to_owned(), Value::String(level.as_str().to_owned()));
    entry.insert("msg".to_owned(), Value::String(message.to_owned()));
    entry.insert("pid".to_owned(), Value::from(std::process::id()));
    entry.insert("app".to_owned(), Value::String("nodex".to_owned()));
    entry.insert("scope".to_owned(), Value::String("core".to_owned()));
    for (key, value) in fields {
        if !entry.contains_key(&key) {
            entry.insert(key, value);
        }
    }
    let mut line = serde_json::to_string(&entry).unwrap_or_else(|_| {
        format!(
            "{{\"ts\":\"{}\",\"level\":\"error\",\"msg\":\"Core log serialization failed\",\"pid\":{},\"app\":\"nodex\",\"scope\":\"core\"}}",
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            std::process::id()
        )
    });
    line.push('\n');
    line
}

struct QueuedRecord {
    level: LogLevel,
    line: String,
}

#[derive(Default)]
struct QueueState {
    records: VecDeque<QueuedRecord>,
    bytes: usize,
    pending_drops: [u64; 5],
    pressure_active: bool,
    closed: bool,
}

struct LogQueue {
    sink: &'static str,
    state: Mutex<QueueState>,
    available: Condvar,
    max_entries: usize,
    max_bytes: usize,
    dropped_records: Arc<AtomicU64>,
}

impl LogQueue {
    fn new(
        sink: &'static str,
        max_entries: usize,
        max_bytes: usize,
        dropped_records: Arc<AtomicU64>,
    ) -> Self {
        Self {
            sink,
            state: Mutex::new(QueueState::default()),
            available: Condvar::new(),
            max_entries,
            max_bytes,
            dropped_records,
        }
    }

    fn push(&self, level: LogLevel, line: String) {
        let Ok(mut state) = self.state.lock() else {
            self.record_drop(level, None);
            return;
        };
        if state.closed || line.len() > self.max_bytes {
            self.record_drop(level, Some(&mut state));
            return;
        }
        while !fits(&state, line.len(), self.max_entries, self.max_bytes) && level >= LogLevel::Warn
        {
            let lowest = state
                .records
                .iter()
                .map(|record| record.level)
                .filter(|queued_level| *queued_level < level)
                .min();
            let Some(index) = lowest.and_then(|lowest| {
                state
                    .records
                    .iter()
                    .position(|record| record.level == lowest)
            }) else {
                break;
            };
            let removed = state
                .records
                .remove(index)
                .expect("queued record index exists");
            state.bytes = state.bytes.saturating_sub(removed.line.len());
            self.record_drop(removed.level, Some(&mut state));
        }
        if !fits(&state, line.len(), self.max_entries, self.max_bytes) {
            self.record_drop(level, Some(&mut state));
            return;
        }
        state.bytes = state.bytes.saturating_add(line.len());
        state.records.push_back(QueuedRecord { level, line });
        self.available.notify_one();
    }

    fn next(&self) -> Option<(Option<String>, QueuedRecord)> {
        let mut state = self.state.lock().ok()?;
        while state.records.is_empty() && !state.closed {
            state = self.available.wait(state).ok()?;
        }
        let record = state.records.pop_front()?;
        state.bytes = state.bytes.saturating_sub(record.line.len());
        let recovered = state.pressure_active
            && state.records.len() <= self.max_entries / 2
            && state.bytes <= self.max_bytes / 2;
        let summary = recovered
            .then(|| {
                state.pressure_active = false;
                dropped_summary(self.sink, &mut state.pending_drops)
            })
            .flatten();
        Some((summary, record))
    }

    fn final_drop_summary(&self) -> Option<String> {
        let mut state = self.state.lock().ok()?;
        dropped_summary(self.sink, &mut state.pending_drops)
    }

    fn close(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.closed = true;
        self.available.notify_all();
    }

    fn abandon(&self, in_flight: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let abandoned = u64::try_from(state.records.len())
            .unwrap_or(u64::MAX)
            .saturating_add(in_flight);
        self.dropped_records.fetch_add(abandoned, Ordering::AcqRel);
        state.records.clear();
        state.bytes = 0;
        state.closed = true;
        self.available.notify_all();
    }

    fn record_drop(&self, level: LogLevel, state: Option<&mut QueueState>) {
        self.dropped_records.fetch_add(1, Ordering::AcqRel);
        if let Some(state) = state
            && level != LogLevel::Silent
        {
            state.pressure_active = true;
            state.pending_drops[level.index()] =
                state.pending_drops[level.index()].saturating_add(1);
        }
    }
}

fn fits(state: &QueueState, line_bytes: usize, max_entries: usize, max_bytes: usize) -> bool {
    state.records.len() < max_entries && state.bytes.saturating_add(line_bytes) <= max_bytes
}

fn dropped_summary(sink: &str, drops: &mut [u64; 5]) -> Option<String> {
    let total = drops.iter().copied().fold(0_u64, u64::saturating_add);
    if total == 0 {
        return None;
    }
    let fields = BTreeMap::from([
        ("dropped_records".to_owned(), Value::from(total)),
        ("dropped_trace".to_owned(), Value::from(drops[0])),
        ("dropped_debug".to_owned(), Value::from(drops[1])),
        ("dropped_info".to_owned(), Value::from(drops[2])),
        ("dropped_warn".to_owned(), Value::from(drops[3])),
        ("dropped_error".to_owned(), Value::from(drops[4])),
        ("sink".to_owned(), Value::String(sink.to_owned())),
    ]);
    drops.fill(0);
    Some(serialize_line(
        LogLevel::Warn,
        &format!("Core log records dropped because the {sink} sink queue was full"),
        fields,
    ))
}

fn run_file_sink(queue: Arc<LogQueue>, config: LoggingConfig, file_active: Arc<AtomicBool>) {
    let mut writer = match SegmentWriter::open(config.clone()) {
        Ok(writer) => writer,
        Err(_) => {
            file_active.store(false, Ordering::Release);
            queue.abandon(0);
            emergency("Core file logging was disabled after sink initialization failed");
            return;
        }
    };
    while let Some((summary, record)) = queue.next() {
        if let Some(summary) = summary
            && writer.write(&summary).is_err()
        {
            disable_file_sink(&queue, &file_active, 2);
            return;
        }
        if writer.write(&record.line).is_err() {
            disable_file_sink(&queue, &file_active, 1);
            return;
        }
    }
    if let Some(summary) = queue.final_drop_summary() {
        let _ = writer.write(&summary);
    }
    let _ = writer.flush();
    file_active.store(false, Ordering::Release);
}

fn disable_file_sink(queue: &LogQueue, file_active: &AtomicBool, in_flight: u64) {
    file_active.store(false, Ordering::Release);
    queue.abandon(in_flight);
    emergency("Core file logging was disabled after a write failed");
}

fn run_console_sink(queue: Arc<LogQueue>, console_active: Arc<AtomicBool>) {
    let mut stderr = io::stderr().lock();
    while let Some((summary, record)) = queue.next() {
        if let Some(summary) = summary
            && stderr.write_all(summary.as_bytes()).is_err()
        {
            console_active.store(false, Ordering::Release);
            queue.abandon(2);
            return;
        }
        if stderr.write_all(record.line.as_bytes()).is_err() {
            console_active.store(false, Ordering::Release);
            queue.abandon(1);
            return;
        }
    }
    if let Some(summary) = queue.final_drop_summary() {
        let _ = stderr.write_all(summary.as_bytes());
    }
    let _ = stderr.flush();
    console_active.store(false, Ordering::Release);
}

fn emergency(message: &str) {
    let _ = writeln!(io::stderr(), "{message}");
}

struct SegmentWriter {
    config: LoggingConfig,
    file: BufWriter<File>,
    path: PathBuf,
    date: String,
    bytes: u64,
}

impl SegmentWriter {
    fn open(config: LoggingConfig) -> io::Result<Self> {
        prepare_log_directory(&config.log_dir)?;
        enforce_retention(&config, None)?;
        let date = current_date();
        let (file, path) = open_segment(&config, &date)?;
        Ok(Self {
            config,
            file: BufWriter::new(file),
            path,
            date,
            bytes: 0,
        })
    }

    fn write(&mut self, line: &str) -> io::Result<()> {
        let date = current_date();
        let line_bytes = u64::try_from(line.len()).unwrap_or(u64::MAX);
        if date != self.date || self.bytes.saturating_add(line_bytes) > self.config.max_file_bytes {
            self.rotate(date)?;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.flush()?;
        self.bytes = self.bytes.saturating_add(line_bytes);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }

    fn rotate(&mut self, date: String) -> io::Result<()> {
        self.file.flush()?;
        enforce_retention(&self.config, Some(&self.path))?;
        let (file, path) = open_segment(&self.config, &date)?;
        self.file = BufWriter::new(file);
        self.path = path;
        self.date = date;
        self.bytes = 0;
        Ok(())
    }
}

fn prepare_log_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_log_directory(path, &metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            nodex_platform::private_fs::create_dir_all(path)?;
            nodex_platform::private_fs::set_mode(path, LOG_DIRECTORY_MODE)?;
            let metadata = fs::symlink_metadata(path)?;
            validate_log_directory(path, &metadata)
        }
        Err(error) => Err(error),
    }
}

fn validate_log_directory(path: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    nodex_platform::private_fs::checked_metadata(
        path,
        nodex_platform::private_fs::EntryKind::Directory,
        Some(LOG_DIRECTORY_MODE),
    )
    .map(|_| ())
}

fn open_segment(config: &LoggingConfig, date: &str) -> io::Result<(File, PathBuf)> {
    let mut highest = None;
    for segment in log_segments(config)? {
        if segment.date == date {
            highest =
                Some(highest.map_or(segment.sequence, |value: u32| value.max(segment.sequence)));
        }
    }
    let mut sequence = highest.map_or(0, |value| value.saturating_add(1));
    for _ in 0..1_000 {
        let path = segment_path(config, date, sequence);
        match OpenOptions::new()
            .create_new(true)
            .append(true)
            .read(true)
            .mode(LOG_FILE_MODE)
            .open(&path)
        {
            Ok(file) => {
                validate_opened_log_file(&file)?;
                file.try_lock_exclusive()?;
                return Ok((file, path));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                sequence = sequence.checked_add(1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::AlreadyExists, "Core log sequence exhausted")
                })?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Core log sequence collision limit reached",
    ))
}

fn validate_opened_log_file(file: &File) -> io::Result<fs::Metadata> {
    nodex_platform::private_fs::validate_private_handle(file, LOG_FILE_MODE)
}

#[derive(Clone)]
struct LogSegment {
    path: PathBuf,
    date: String,
    sequence: u32,
    bytes: u64,
    modified: SystemTime,
}

fn log_segments(config: &LoggingConfig) -> io::Result<Vec<LogSegment>> {
    let mut segments = Vec::new();
    for entry in fs::read_dir(&config.log_dir)? {
        let entry = entry?;
        let Some((date, sequence)) =
            parse_segment_name(&config.segment_prefix, &entry.file_name().to_string_lossy())
        else {
            continue;
        };
        let file = open_existing_log_file(&entry.path())?;
        let metadata = validate_opened_log_file(&file)?;
        segments.push(LogSegment {
            path: entry.path(),
            date,
            sequence,
            bytes: metadata.len(),
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }
    Ok(segments)
}

fn open_existing_log_file(path: &Path) -> io::Result<File> {
    nodex_platform::private_fs::open_read(path)
}

fn remove_unlocked_segment(path: &Path) -> io::Result<bool> {
    let file = open_existing_log_file(path)?;
    validate_opened_log_file(&file)?;
    match file.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if nodex_platform::private_fs::lock_is_contended(&error) => return Ok(false),
        Err(error) => return Err(error),
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn enforce_retention(config: &LoggingConfig, active_path: Option<&Path>) -> io::Result<()> {
    let mut segments = log_segments(config)?;
    segments.sort_by_key(|segment| segment.modified);
    let retention = Duration::from_secs(config.retention_days.saturating_mul(86_400));
    let cutoff = SystemTime::now()
        .checked_sub(retention)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for segment in &segments {
        if segment.modified < cutoff && active_path != Some(segment.path.as_path()) {
            let _ = remove_unlocked_segment(&segment.path)?;
        }
    }
    segments.retain(|segment| segment.modified >= cutoff && segment.path.exists());
    let mut total = segments
        .iter()
        .map(|segment| segment.bytes)
        .fold(0_u64, u64::saturating_add);
    let target_bytes = config.max_total_bytes.saturating_sub(config.max_file_bytes);
    for segment in segments {
        if total <= target_bytes {
            break;
        }
        if active_path == Some(segment.path.as_path()) {
            continue;
        }
        if remove_unlocked_segment(&segment.path)? {
            total = total.saturating_sub(segment.bytes);
        }
    }
    Ok(())
}

fn parse_segment_name(prefix: &str, name: &str) -> Option<(String, u32)> {
    let stem = name.strip_prefix(prefix)?.strip_suffix(LOG_SUFFIX)?;
    let (date, sequence) = stem.rsplit_once('-')?;
    DateTime::parse_from_rfc3339(&format!("{date}T00:00:00Z")).ok()?;
    Some((date.to_owned(), sequence.parse().ok()?))
}

fn segment_path(config: &LoggingConfig, date: &str, sequence: u32) -> PathBuf {
    config.log_dir.join(format!(
        "{}{date}-{sequence:03}{LOG_SUFFIX}",
        config.segment_prefix
    ))
}

fn current_date() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn profile_segment_prefix(home: &Path) -> String {
    let digest = Sha256::digest(nodex_platform::process::path_bytes(home));
    format!("{LOG_PREFIX}{}-", &hex::encode(digest)[..16])
}

fn parse_bool_env(name: &str, fallback: bool) -> bool {
    match env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("1" | "true" | "yes" | "on") => true,
        Some("0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_u64_env(name: &str, fallback: u64, minimum: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= minimum)
        .unwrap_or(fallback)
}

fn parse_usize_env(name: &str, fallback: usize, minimum: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= minimum)
        .unwrap_or(fallback)
}

fn packaged_runtime() -> bool {
    let path_default = env::current_exe().is_ok_and(|path| {
        path.to_string_lossy()
            .contains(".app/Contents/Resources/bin/")
    });
    parse_bool_env("NODEX_INTERNAL_APP_PACKAGED", path_default)
}

fn test_runtime() -> bool {
    cfg!(test)
        || env::var("NODE_ENV").is_ok_and(|value| value.eq_ignore_ascii_case("test"))
        || env::var("BUN_ENV").is_ok_and(|value| value.eq_ignore_ascii_case("test"))
        || env::args().any(|argument| argument.to_ascii_lowercase().contains("test"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_platform::test_support::tempdir;
    use serde_json::json;

    fn config(log_dir: PathBuf) -> LoggingConfig {
        LoggingConfig {
            console_enabled: false,
            file_enabled: true,
            console_level: LogLevel::Warn,
            file_level: LogLevel::Trace,
            log_dir,
            segment_prefix: "core-test-profile-".to_owned(),
            max_file_bytes: 1_024,
            max_total_bytes: 4_096,
            max_queue_entries: 8,
            max_queue_bytes: 4_096,
            max_string_length: 80,
            retention_days: 14,
            flush_timeout: DEFAULT_FLUSH_TIMEOUT,
        }
    }

    #[test]
    fn sensitive_fields_are_redacted_and_strings_are_bounded() {
        for key in [
            "password",
            "dbPass",
            "client_secret",
            "refreshToken",
            "apiKey",
            "api-key",
            "Authorization",
            "cookie",
            "clientSessionId",
            "credential",
        ] {
            assert!(sensitive_key(key), "{key} must be sensitive");
        }
        assert!(!sensitive_key("operationId"));
        assert_eq!(truncate_string("abcdefgh", 4), "abcd…[truncated]");

        let dropped = Arc::new(AtomicU64::new(0));
        let queue = Arc::new(LogQueue::new("test", 8, 4_096, dropped));
        let layer = JsonLayer {
            console_level: LogLevel::Silent,
            file_level: LogLevel::Trace,
            max_string_length: 80,
            console_queue: None,
            file_queue: Some(Arc::clone(&queue)),
            console_active: Arc::new(AtomicBool::new(false)),
            file_active: Arc::new(AtomicBool::new(true)),
        };
        let subscriber = Registry::default().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "redaction_test",
                clientSecret = "span-secret",
                operationId = "safe-operation"
            );
            span.in_scope(|| {
                tracing::info!(
                    authorization = "Bearer event-secret",
                    detail = %"x".repeat(120),
                    "bounded"
                );
            });
        });
        queue.close();
        let (_, record) = queue.next().expect("captured log record");
        let line = record.line;
        let entry: Value = serde_json::from_str(&line).expect("valid JSON line");
        for field in ["ts", "level", "msg", "pid", "app", "scope"] {
            assert!(entry.get(field).is_some(), "missing {field}");
        }
        assert_eq!(entry["authorization"], "[REDACTED]");
        assert_eq!(entry["clientSecret"], "[REDACTED]");
        assert_eq!(entry["operationId"], "safe-operation");
        assert!(entry["detail"].as_str().is_some_and(|detail| {
            detail.chars().count() < 120 && detail.ends_with("…[truncated]")
        }));
        assert!(!line.contains("span-secret"));
        assert!(!line.contains("event-secret"));
    }

    #[test]
    fn warn_record_evicts_lower_priority_record_under_pressure() {
        let dropped = Arc::new(AtomicU64::new(0));
        let queue = LogQueue::new("test", 1, 1_024, Arc::clone(&dropped));
        queue.push(LogLevel::Info, "info\n".to_owned());
        queue.push(LogLevel::Warn, "warn\n".to_owned());
        queue.close();
        let (summary, record) = queue.next().expect("warn remains queued");
        assert_eq!(record.level, LogLevel::Warn);
        assert!(
            summary
                .expect("drop summary")
                .contains("\"dropped_info\":1")
        );
        assert_eq!(dropped.load(Ordering::Acquire), 1);
    }

    #[test]
    fn error_record_evicts_the_globally_lowest_priority_record() {
        let dropped = Arc::new(AtomicU64::new(0));
        let queue = LogQueue::new("test", 2, 1_024, Arc::clone(&dropped));
        queue.push(LogLevel::Warn, "warn\n".to_owned());
        queue.push(LogLevel::Info, "info\n".to_owned());
        queue.push(LogLevel::Error, "error\n".to_owned());
        queue.close();

        let (summary, first) = queue.next().expect("warn remains queued");
        assert_eq!(first.level, LogLevel::Warn);
        assert!(
            summary
                .expect("one recovery summary")
                .contains("\"dropped_info\":1")
        );
        let (summary, second) = queue.next().expect("error remains queued");
        assert!(summary.is_none());
        assert_eq!(second.level, LogLevel::Error);
        assert_eq!(dropped.load(Ordering::Acquire), 1);
    }

    #[test]
    fn sink_abandonment_counts_queued_and_in_flight_records() {
        let dropped = Arc::new(AtomicU64::new(0));
        let queue = LogQueue::new("test", 4, 1_024, Arc::clone(&dropped));
        queue.push(LogLevel::Info, "one\n".to_owned());
        queue.push(LogLevel::Warn, "two\n".to_owned());

        queue.abandon(1);

        assert!(queue.next().is_none());
        assert_eq!(dropped.load(Ordering::Acquire), 3);
    }

    #[test]
    fn segment_writer_rotates_and_uses_private_modes() {
        let temporary = tempdir().expect("temporary directory");
        let log_dir = temporary.path().join("logs");
        let config = config(log_dir.clone());
        let mut writer = SegmentWriter::open(config.clone()).expect("segment writer");
        for index in 0..20 {
            writer
                .write(&format!(
                    "{}\n",
                    json!({ "index": index, "value": "x".repeat(120) })
                ))
                .expect("write log record");
        }
        writer.flush().expect("flush logs");
        assert_eq!(
            nodex_platform::private_fs::effective_mode(&log_dir).expect("filesystem access"),
            0o700
        );
        let segments = log_segments(&config).expect("log segments");
        assert!(segments.len() > 1);
        assert!(segments.iter().all(|segment| {
            nodex_platform::private_fs::effective_mode(&segment.path).expect("filesystem access")
                == 0o600
        }));
    }

    #[test]
    fn separate_runtime_writers_never_append_the_same_segment() {
        let temporary = tempdir().expect("temporary directory");
        let config = config(temporary.path().join("logs"));
        let mut first = SegmentWriter::open(config.clone()).expect("first writer");
        first.write("{\"runtime\":1}\n").expect("first write");
        let first_path = first.path.clone();

        let mut second = SegmentWriter::open(config.clone()).expect("second writer");
        second.write("{\"runtime\":2}\n").expect("second write");
        let second_path = second.path.clone();

        assert_ne!(first_path, second_path);
        assert_eq!(log_segments(&config).expect("segments").len(), 2);
    }

    #[test]
    fn retention_reserves_space_for_the_next_segment() {
        let temporary = tempdir().expect("temporary directory");
        let mut config = config(temporary.path().join("logs"));
        config.max_file_bytes = 200;
        config.max_total_bytes = 600;
        let mut writer = SegmentWriter::open(config.clone()).expect("segment writer");
        for index in 0..30 {
            writer
                .write(&format!(
                    "{}\n",
                    json!({ "index": index, "value": "x".repeat(70) })
                ))
                .expect("write bounded segment");
        }
        writer.flush().expect("flush logs");
        drop(writer);

        let total = log_segments(&config)
            .expect("retained segments")
            .iter()
            .map(|segment| segment.bytes)
            .sum::<u64>();
        assert!(total <= config.max_total_bytes, "retained {total} bytes");
    }

    #[test]
    fn matching_symlink_segment_disables_file_logging() {
        let temporary = tempdir().expect("temporary directory");
        let config = config(temporary.path().join("logs"));
        prepare_log_directory(&config.log_dir).expect("log directory");
        let target = temporary.path().join("target.log");
        nodex_platform::private_fs::write(&target, "outside\n").expect("symlink target");
        nodex_platform::private_fs::set_mode(&target, LOG_FILE_MODE).expect("private target");
        nodex_platform::private_fs::symlink(&target, segment_path(&config, &current_date(), 0))
            .expect("matching symlink");

        assert!(SegmentWriter::open(config).is_err());
    }
}
