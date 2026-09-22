//! Adapter for Codex's local conversation persistence (state layout 5 and JSONL rollouts).
//! Native pagination indexes are part of the readable closure; credentials and queues are not.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nodex_core::administration::ProfileCloneThread;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Result;
use crate::files::{self, invalid};

const DIRECTORIES: &[&str] = &["sessions", "archived_sessions", "attachments"];
const FILES: &[&str] = &["session_index.jsonl"];
const DATABASES: &[&str] = &[
    "state_5.sqlite",
    "thread_history_1.sqlite",
    "goals_1.sqlite",
];
const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshotReceipt {
    pub version: u32,
    pub capture_started_at: String,
    pub capture_completed_at: String,
    pub required_thread_count: usize,
    pub captured_thread_count: usize,
    pub external_thread_count: usize,
    pub missing_thread_ids: Vec<String>,
    pub rollout_count: usize,
    pub native_state_schema: Option<String>,
    pub content_sha256: String,
}

/// Holds native home coordination for the entire capture, excluding new writers/publication.
/// Existing writers cause a prompt rejection instead of interrupting source conversations.
struct IdleWriters {
    _coordination: File,
}

impl IdleWriters {
    fn acquire(home: &Path) -> Result<Self> {
        let directory = home.join("thread-writer-locks");
        files::private_directory(&directory)?;
        let path = directory.join(".coordination.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(&path)?;
        lock.try_lock().map_err(|_| {
            invalid("Source Agent is busy; stop its runtime before cloning the Profile")
        })?;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.file_name() == ".coordination.lock" {
                continue;
            }
            let file = files::read_file(&entry.path())?;
            file.try_lock().map_err(|_| invalid("Source Agent still owns a conversation writer; stop its runtime before cloning the Profile"))?;
        }
        Ok(Self {
            _coordination: lock,
        })
    }
}

struct DatabaseSource {
    path: PathBuf,
    connection: Connection,
    version: i64,
    fingerprint: files::Fingerprint,
}

impl DatabaseSource {
    fn open(path: PathBuf) -> Result<Self> {
        let fingerprint = files::fingerprint(&path)?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
            if files::exists(&sidecar)? {
                files::fingerprint(&sidecar)?;
            }
        }
        let connection = Connection::open_with_flags(
            // SQLite NOFOLLOW rejects symlink ancestors too (including macOS /var).
            // The selected file and its sidecars were checked before resolving aliases.
            fs::canonicalize(&path)?,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_secs(2))?;
        let version = connection.query_row("PRAGMA data_version", [], |row| row.get(0))?;
        Ok(Self {
            path,
            connection,
            version,
            fingerprint,
        })
    }

    fn snapshot(&self, destination: &Path) -> Result<()> {
        drop(files::create_file(destination)?);
        let mut target = Connection::open(destination)?;
        {
            let backup = rusqlite::backup::Backup::new(&self.connection, &mut target)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                if backup.step(512)? == rusqlite::backup::StepResult::Done {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(invalid(
                        "Native database capture timed out; stop the source Agent runtime and retry",
                    ));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        target.execute_batch("PRAGMA journal_mode=DELETE")?;
        let valid: String = target.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if valid != "ok" {
            return Err(invalid(
                "Native conversation database failed integrity validation",
            ));
        }
        Ok(())
    }

    fn verify_unchanged(&self) -> Result<()> {
        let current: i64 = self
            .connection
            .query_row("PRAGMA data_version", [], |row| row.get(0))?;
        if current != self.version {
            return Err(invalid(
                "Source conversation metadata changed during capture; retry after stopping its Agent runtime",
            ));
        }
        if self.fingerprint != files::fingerprint(&self.path)? {
            return Err(invalid(
                "Source conversation database changed during capture",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct HistoryBase {
    id: String,
    bytes: u64,
    ordinal: u64,
}

#[derive(Clone, Debug)]
struct Rollout {
    thread_id: String,
    relative: PathBuf,
    base: Option<HistoryBase>,
    bytes: u64,
    end_ordinal: Option<u64>,
    paginated: bool,
}

pub(crate) fn capture(
    source_profile: &Path,
    staging_profile: &Path,
    target_profile: &Path,
    threads: &[ProfileCloneThread],
) -> Result<ConversationSnapshotReceipt> {
    let required: BTreeSet<String> = threads
        .iter()
        .filter(|thread| thread.backend_kind == "codex" && thread.execution_host_id == "local")
        .map(|thread| thread.thread_id.clone())
        .collect();
    let started = now();
    let source = source_profile.join("agent");
    let staging = staging_profile.join("agent");
    let target = target_profile.join("agent");
    files::private_directory(&staging)?;
    if !files::exists(&source)? {
        return receipt(
            started,
            &staging,
            &required,
            required.iter().cloned().collect(),
            threads.len(),
            0,
            false,
        );
    }
    files::require_directory(&source)?;
    validate_config(&source)?;
    validate_database_layout(&source)?;
    let _writers = IdleWriters::acquire(&source)?;
    let before = files::inventory(&source, DIRECTORIES, FILES)?;
    let databases = DATABASES
        .iter()
        .filter_map(|name| match files::exists(&source.join(name)) {
            Ok(false) => None,
            Ok(true) => Some(DatabaseSource::open(source.join(name))),
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>>>()?;
    for database in &databases {
        database.snapshot(&staging.join(database.path.file_name().expect("named database")))?;
    }
    for relative in before.keys() {
        files::copy_file(&source.join(relative), &staging.join(relative))?;
    }
    let rollouts = read_rollouts(&staging, before.keys())?;
    let projections = read_projections(&staging)?;
    let has_state = files::exists(&staging.join("state_5.sqlite"))?;
    let mut selected = if has_state {
        relocate_state(&source, &staging, &target, &rollouts)?
    } else {
        legacy_selections(&rollouts)
    };
    // A native metadata index may not have backfilled older rollouts yet.
    for (thread, id) in legacy_selections(&rollouts) {
        selected.entry(thread).or_insert(id);
    }
    let mut invalid_prefixes = BTreeSet::new();
    let mut checked_prefixes = BTreeMap::new();
    for (id, rollout) in &rollouts {
        let Some(base) = &rollout.base else { continue };
        let key = (base.id.clone(), base.bytes, base.ordinal);
        if !checked_prefixes.contains_key(&key) {
            let valid = match rollouts.get(&base.id) {
                Some(parent) => valid_prefix(&staging, parent, base)?,
                None => false,
            };
            checked_prefixes.insert(key.clone(), valid);
        }
        if !checked_prefixes[&key] {
            invalid_prefixes.insert(id.clone());
        }
    }
    let missing = required
        .iter()
        .filter(|id| !recoverable(id, &selected, &rollouts, &invalid_prefixes, &projections))
        .cloned()
        .collect::<Vec<_>>();
    for database in &databases {
        database.verify_unchanged()?;
    }
    validate_database_layout(&source)?;
    for name in DATABASES {
        if files::exists(&source.join(name))?
            != databases
                .iter()
                .any(|database| database.path == source.join(name))
        {
            return Err(invalid(
                "Source conversation database set changed during capture",
            ));
        }
    }
    if before != files::inventory(&source, DIRECTORIES, FILES)? {
        return Err(invalid(
            "Source conversation files changed during capture; retry after stopping its Agent runtime",
        ));
    }
    receipt(
        started,
        &staging,
        &required,
        missing,
        threads.len(),
        rollouts.len(),
        has_state,
    )
}

fn receipt(
    started: String,
    staging: &Path,
    required: &BTreeSet<String>,
    missing: Vec<String>,
    total: usize,
    rollouts: usize,
    has_state: bool,
) -> Result<ConversationSnapshotReceipt> {
    Ok(ConversationSnapshotReceipt {
        version: 1,
        capture_started_at: started,
        capture_completed_at: now(),
        required_thread_count: required.len(),
        captured_thread_count: required.len() - missing.len(),
        external_thread_count: total - required.len(),
        missing_thread_ids: missing,
        rollout_count: rollouts,
        native_state_schema: has_state.then(|| "state_5".to_owned()),
        content_sha256: files::digest_tree(staging)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn validate_config(home: &Path) -> Result<()> {
    let path = home.join("config.toml");
    if !files::exists(&path)? {
        return Ok(());
    }
    let mut text = String::new();
    files::read_file(&path)?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    if text.len() > 1024 * 1024 {
        return Err(invalid("Source Agent config is too large"));
    }
    let value: toml::Value =
        toml::from_str(&text).map_err(|_| invalid("Source Agent config is invalid"))?;
    if let Some(configured) = value.get("sqlite_home") {
        let configured = configured
            .as_str()
            .ok_or_else(|| invalid("Source Agent sqlite_home is invalid"))?;
        if fs::canonicalize(configured)? != fs::canonicalize(home)? {
            return Err(invalid(
                "Conversation snapshot requires native SQLite inside the source Profile's agent directory",
            ));
        }
    }
    Ok(())
}

fn validate_database_layout(home: &Path) -> Result<()> {
    for entry in fs::read_dir(home)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sqlite") {
            continue;
        }
        let supported = DATABASES.iter().find(|expected| {
            let (prefix, _) = expected
                .rsplit_once('_')
                .expect("versioned native database");
            name.strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('_'))
        });
        if supported.is_some_and(|expected| name != *expected) {
            return Err(invalid(format!(
                "Unsupported native conversation state layout: {name}"
            )));
        }
    }
    Ok(())
}

fn read_rollouts<'a>(
    home: &Path,
    paths: impl Iterator<Item = &'a PathBuf>,
) -> Result<BTreeMap<String, Rollout>> {
    let mut rollouts = BTreeMap::new();
    for relative in paths {
        if !relative.starts_with("sessions") && !relative.starts_with("archived_sessions") {
            continue;
        }
        let Some(id) = rollout_id(relative) else {
            return Err(invalid(format!(
                "Unsupported rollout artifact: {}",
                relative.display()
            )));
        };
        let rollout = read_rollout(home, relative)?;
        if rollouts.insert(id, rollout).is_some() {
            return Err(invalid("Source has ambiguous duplicate rollout identities"));
        }
    }
    Ok(rollouts)
}

fn rollout_id(path: &Path) -> Option<String> {
    let name = path
        .file_name()?
        .to_str()?
        .strip_suffix(".zst")
        .unwrap_or(path.file_name()?.to_str()?);
    let stem = name.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let valid = id.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    });
    valid.then(|| id.to_owned())
}

fn rollout_reader(home: &Path, relative: &Path) -> Result<Box<dyn BufRead>> {
    let file = files::read_file(&home.join(relative))?;
    if relative.extension().is_some_and(|ext| ext == "zst") {
        return Ok(Box::new(BufReader::new(zstd::stream::read::Decoder::new(
            file,
        )?)));
    }
    Ok(Box::new(BufReader::new(file)))
}

fn read_rollout(home: &Path, relative: &Path) -> Result<Rollout> {
    let mut reader = rollout_reader(home, relative)?;
    let mut first: Option<Value> = None;
    let mut bytes = 0;
    let mut end_ordinal = None;
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(MAX_RECORD_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count as u64 > MAX_RECORD_BYTES || line.last() != Some(&b'\n') {
            return Err(invalid(
                "Source rollout contains an oversized or unfinished record",
            ));
        }
        let value: Value = serde_json::from_slice(&line)?;
        end_ordinal = value["ordinal"]
            .as_u64()
            .and_then(|value| value.checked_add(1));
        if first.is_none() {
            first = Some(value);
        }
        bytes += count as u64;
    }
    let meta = first
        .filter(|line| line["type"] == "session_meta")
        .ok_or_else(|| invalid("Rollout has no initial session metadata"))?;
    let thread_id = meta["payload"]["id"]
        .as_str()
        .ok_or_else(|| invalid("Rollout has no Thread identity"))?
        .to_owned();
    let paginated = match meta["payload"]["history_mode"].as_str() {
        None | Some("legacy") => false,
        Some("paginated") => true,
        _ => return Err(invalid("Unsupported native rollout history mode")),
    };
    let base = match &meta["payload"]["history_base"] {
        Value::Null => None,
        value => Some(HistoryBase {
            id: value["thread_id"]
                .as_str()
                .ok_or_else(|| invalid("Invalid inherited rollout identity"))?
                .to_owned(),
            bytes: value["end_byte_offset"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid inherited rollout position"))?,
            ordinal: value["end_ordinal_exclusive"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid inherited rollout ordinal"))?,
        }),
    };
    Ok(Rollout {
        thread_id,
        relative: relative.to_owned(),
        base,
        bytes,
        end_ordinal,
        paginated,
    })
}

/// Native paginated reads use this index even when the underlying rollout is present.
/// Inherited ancestors are not automatically reprojected when a child is resumed.
fn read_projections(home: &Path) -> Result<BTreeMap<String, (u64, u64)>> {
    let path = home.join("thread_history_1.sqlite");
    if !files::exists(&path)? {
        return Ok(BTreeMap::new());
    }
    let connection = Connection::open(path)?;
    let values = connection.prepare(
        "SELECT thread_id, next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state"
    )?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    values
        .into_iter()
        .map(|(id, bytes, ordinal)| {
            Ok((
                id,
                (
                    u64::try_from(bytes)
                        .map_err(|_| invalid("Negative native projection offset"))?,
                    u64::try_from(ordinal)
                        .map_err(|_| invalid("Negative native projection ordinal"))?,
                ),
            ))
        })
        .collect()
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )?)
}

fn relocate_state(
    source: &Path,
    staging: &Path,
    target: &Path,
    rollouts: &BTreeMap<String, Rollout>,
) -> Result<BTreeMap<String, String>> {
    let mut connection = Connection::open(staging.join("state_5.sqlite"))?;
    let selected = connection
        .prepare("SELECT id, rollout_path FROM threads ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let transaction = connection.transaction()?;
    let mut result = BTreeMap::new();
    for (thread, path) in selected {
        let relative = files::relative_path(source, Path::new(&path))?;
        if !relative.starts_with("sessions") && !relative.starts_with("archived_sessions") {
            return Err(invalid(
                "Native metadata selects a rollout outside the session directories",
            ));
        }
        let id = rollout_id(&relative)
            .ok_or_else(|| invalid("Native metadata selects an invalid rollout path"))?;
        if let Some(rollout) = rollouts.get(&id) {
            if rollout.thread_id != thread {
                return Err(invalid("Native selected rollout belongs to another Thread"));
            }
            let actual = relative.to_string_lossy();
            let copied = rollout.relative.to_string_lossy();
            if actual.trim_end_matches(".zst") != copied.trim_end_matches(".zst") {
                return Err(invalid(
                    "Native selected rollout path does not match the copied artifact",
                ));
            }
        }
        transaction.execute(
            "UPDATE threads SET rollout_path = ?1 WHERE id = ?2",
            (target.join(&relative).to_string_lossy().as_ref(), &thread),
        )?;
        result.insert(thread, id);
    }
    // These are replayable progress/operational records, not selected conversation authority.
    for table in [
        "rollout_migration_skipped_rollouts",
        "rollout_migration_state",
        "backfill_state",
        "agent_job_items",
        "agent_jobs",
    ] {
        if table_exists(&transaction, table)? {
            transaction.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    transaction.commit()?;
    Ok(result)
}

fn legacy_selections(rollouts: &BTreeMap<String, Rollout>) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for (id, rollout) in rollouts {
        if id != &rollout.thread_id {
            continue;
        }
        result.insert(rollout.thread_id.clone(), id.clone());
    }
    for (id, rollout) in rollouts {
        if id != &rollout.thread_id {
            result.remove(&rollout.thread_id);
        }
    }
    result
}

fn recoverable(
    thread: &str,
    selected: &BTreeMap<String, String>,
    rollouts: &BTreeMap<String, Rollout>,
    invalid_prefixes: &BTreeSet<String>,
    projections: &BTreeMap<String, (u64, u64)>,
) -> bool {
    let Some(mut id) = selected.get(thread).map(String::as_str) else {
        return false;
    };
    let mut visited = BTreeSet::new();
    let mut inherited_position = None;
    loop {
        if !visited.insert(id) {
            return false;
        }
        let Some(rollout) = rollouts.get(id) else {
            return false;
        };
        if invalid_prefixes.contains(id) {
            return false;
        }
        if rollout.paginated {
            let required =
                inherited_position.or(rollout.end_ordinal.map(|ordinal| (rollout.bytes, ordinal)));
            if !required.zip(projections.get(id)).is_some_and(
                |((bytes, ordinal), &(projected_bytes, projected_ordinal))| {
                    projected_bytes >= bytes
                        && projected_ordinal >= ordinal
                        && projected_bytes <= rollout.bytes
                },
            ) {
                return false;
            }
        }
        let Some(base) = &rollout.base else {
            return true;
        };
        id = &base.id;
        inherited_position = Some((base.bytes, base.ordinal));
    }
}

/// A lineage cutoff is both a JSONL record boundary and a logical ordinal, not just a byte length.
fn valid_prefix(home: &Path, parent: &Rollout, base: &HistoryBase) -> Result<bool> {
    if base.bytes > parent.bytes {
        return Ok(false);
    }
    if base.bytes == 0 {
        return Ok(base.ordinal == 0);
    }
    let mut reader = rollout_reader(home, &parent.relative)?;
    let mut offset = 0;
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(MAX_RECORD_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 || count as u64 > MAX_RECORD_BYTES {
            return Ok(false);
        }
        offset += count as u64;
        if offset < base.bytes {
            continue;
        }
        if offset != base.bytes {
            return Ok(false);
        }
        let value: Value = serde_json::from_slice(&line)?;
        return Ok(value["ordinal"]
            .as_u64()
            .and_then(|ordinal| ordinal.checked_add(1))
            == Some(base.ordinal));
    }
}

#[cfg(test)]
mod tests;
