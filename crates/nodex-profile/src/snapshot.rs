//! Execution capture participates in the Store's single Backup publication transaction.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use nodex_core::administration::{
    ProfileCloneThread, ProfileSnapshotCapture, ProfileSnapshotParticipant,
};
use nodex_core::infrastructure::sqlite::{StoreError, StoreErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::control::{ExecutionSnapshot, NativeHistorySource, SnapshotLease};
use crate::files::{self, invalid};
use crate::{ProfileCloneError, Result, codex, execution};

pub struct ExecutionProfileSnapshotParticipant;

impl ProfileSnapshotParticipant for ExecutionProfileSnapshotParticipant {
    fn estimated_bytes(
        &self,
        profile: &Path,
        source: Option<&nodex_core::administration::ProfileSnapshotSource>,
    ) -> std::result::Result<u64, StoreError> {
        estimate(profile, source).map_err(|error| {
            StoreError::new(StoreErrorCode::InvalidProfile, error.to_string(), false)
        })
    }
    fn capture(
        &self,
        request: ProfileSnapshotCapture<'_>,
    ) -> std::result::Result<bool, StoreError> {
        capture(request).map_err(|error| match error {
            ProfileCloneError::Store(error) => error,
            ProfileCloneError::Sqlite(error) => error.into(),
            error => StoreError::new(StoreErrorCode::InvalidProfile, error.to_string(), false),
        })
    }
}

fn estimate(
    profile: &Path,
    source: Option<&nodex_core::administration::ProfileSnapshotSource>,
) -> Result<u64> {
    let home = profile.join("agent-runtime");
    let mut total = 0u64;
    let database = source.map_or_else(
        || home.join("agent-runtime.sqlite"),
        |source| Path::new(&source.database_path).to_owned(),
    );
    if files::exists(&database)? {
        total = std::fs::metadata(database)?.len();
    }
    for fingerprint in files::inventory(
        &home.join("userdata"),
        &["attachments"],
        &["environment-id"],
    )?
    .values()
    {
        total = total.saturating_add(fingerprint.length());
    }
    let mut seen = BTreeSet::new();
    for native in source
        .map(|source| source.native_histories.as_slice())
        .unwrap_or_default()
    {
        let Some(path) = &native.home_path else {
            continue;
        };
        if !seen.insert((native.driver.clone(), path.clone())) {
            continue;
        }
        let (directories, names): (&[&str], &[&str]) = match native.driver.as_str() {
            "codex" => (
                &["sessions", "archived_sessions", "attachments"],
                &[
                    "session_index.jsonl",
                    "state_5.sqlite",
                    "thread_history_1.sqlite",
                    "goals_1.sqlite",
                ],
            ),
            "claudeAgent" => (&["projects", "file-history"], &[]),
            _ => continue,
        };
        for fingerprint in files::inventory(Path::new(path), directories, names)?.values() {
            total = total.saturating_add(fingerprint.length());
        }
    }
    Ok(total)
}

fn capture(request: ProfileSnapshotCapture<'_>) -> Result<bool> {
    let coordinated = if request.source.is_none() {
        SnapshotLease::acquire(request.source_profile)?
    } else {
        None
    };
    let supplied = request.source.map(|source| ExecutionSnapshot {
        runtime_id: source.runtime_id.clone(),
        runtime_generation: source.runtime_generation.clone(),
        sequence: source.sequence,
        database_path: source.database_path.clone().into(),
        environment_id_path: source.environment_id_path.clone().into(),
        attachments_path: source.attachments_path.clone().into(),
        native_histories: source
            .native_histories
            .iter()
            .map(|source| NativeHistorySource {
                provider_instance_id: source.provider_instance_id.clone(),
                driver: source.driver.clone(),
                home_path: source.home_path.clone(),
            })
            .collect(),
    });
    let live = supplied
        .as_ref()
        .or_else(|| coordinated.as_ref().and_then(SnapshotLease::execution));
    let offline = if live.is_none() {
        Some(execution::RuntimeWriterLease::acquire(
            request.source_profile,
        )?)
    } else {
        None
    };
    if live.is_some_and(|snapshot| {
        snapshot.runtime_generation.is_empty() || snapshot.runtime_generation.len() > 512
    }) {
        return Err(invalid(
            "Execution snapshot has no physical generation identity",
        ));
    }
    let (captured, _) = execution::capture(
        request.source_profile,
        request.staging_profile,
        request.target_profile,
        request.required,
        live,
    )?;
    let Some(captured) = captured else {
        return Ok(false);
    };
    let home = request.staging_profile.join("agent-runtime");
    let connection = rusqlite::Connection::open(home.join("agent-runtime.sqlite"))?;
    validate_session_roots(&connection, request.required)?;
    let required = native_requirements(&connection)?;
    let sources = live
        .map(|snapshot| snapshot.native_histories.clone())
        .unwrap_or_else(|| {
            vec![NativeHistorySource {
                provider_instance_id: "codex".into(),
                driver: "codex".into(),
                home_path: Some(
                    request
                        .source_profile
                        .join("agent")
                        .to_string_lossy()
                        .into_owned(),
                ),
            }]
        });
    let manifest = capture_native_histories(&home, request.target_profile, &sources, &required)?;
    files::create_file(&home.join("native-history/manifest.json"))?
        .write_all(&serde_json::to_vec(&manifest)?)?;
    files::create_file(&home.join("snapshot.json"))?.write_all(&serde_json::to_vec(&captured)?)?;
    drop(connection);
    drop(offline);
    if let Some(lease) = coordinated {
        lease.finish()?;
    }
    Ok(true)
}

fn validate_session_roots(
    connection: &rusqlite::Connection,
    required: &[nodex_core::administration::ProfileCloneExecution],
) -> Result<()> {
    for binding in required {
        let matches: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND json_extract(payload_json,'$.lineage.rootThreadId')=?1 AND json_extract(payload_json,'$.lineage.parentThreadId') IS NULL)", [&binding.thread_id], |row| row.get(0))?;
        if !matches {
            return Err(invalid(format!(
                "Session {} does not own its captured execution root",
                binding.session_id
            )));
        }
    }
    Ok(())
}

type NativeRequirements = BTreeMap<String, (String, BTreeSet<String>)>;
fn native_requirements(connection: &rusqlite::Connection) -> Result<NativeRequirements> {
    let mut statement = connection.prepare("SELECT DISTINCT json_extract(payload_json,'$.providerInstanceId'), json_extract(payload_json,'$.driver'), json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM orchestration_v2_projection_provider_threads WHERE json_type(payload_json,'$.nativeThreadRef.nativeId')='text' LIMIT 100001")?;
    let mut rows = statement.query([])?;
    let mut result: NativeRequirements = BTreeMap::new();
    let mut bytes = 0usize;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        count += 1;
        for index in 0..3 {
            let rusqlite::types::ValueRef::Text(value) = row.get_ref(index)? else {
                return Err(invalid("Native history identity is malformed"));
            };
            bytes = bytes.saturating_add(value.len());
        }
        if count > 100000 || bytes > 16 * 1024 * 1024 {
            return Err(invalid("Native history references exceed snapshot bounds"));
        }
        let instance: String = row.get(0)?;
        let driver: String = row.get(1)?;
        let id: String = row.get(2)?;
        let entry = result
            .entry(instance)
            .or_insert_with(|| (driver.clone(), BTreeSet::new()));
        if entry.0 != driver {
            return Err(invalid(
                "A provider instance has mixed native history drivers",
            ));
        }
        entry.1.insert(id);
    }
    Ok(result)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHistoryManifest {
    version: u32,
    providers: Vec<NativeHistoryManifestEntry>,
    limitations: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHistoryManifestEntry {
    provider_instance_id: String,
    driver: String,
    /// Relative to agent-runtime. Never a source account's private home.
    relative_home: Option<String>,
    continuation: String,
    required_thread_count: usize,
    credential_policy: String,
}

fn capture_native_histories(
    home: &Path,
    target_profile: &Path,
    sources: &[NativeHistorySource],
    required: &NativeRequirements,
) -> Result<NativeHistoryManifest> {
    if sources.len() > 256 {
        return Err(invalid(
            "Provider history configuration exceeds its snapshot bound",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut providers = Vec::new();
    let mut captured_homes: BTreeMap<(String, String), String> = BTreeMap::new();
    for source in sources {
        if source.provider_instance_id.is_empty()
            || source.provider_instance_id.len() > 512
            || !seen.insert(source.provider_instance_id.clone())
        {
            return Err(invalid(
                "Provider history configuration has an invalid or duplicate instance",
            ));
        }
        let ids = required
            .get(&source.provider_instance_id)
            .map(|(driver, ids)| {
                if driver != &source.driver {
                    return Err(invalid(
                        "Native history driver does not match its execution instance",
                    ));
                }
                Ok(ids.clone())
            })
            .transpose()?
            .unwrap_or_default();
        let supported = matches!(source.driver.as_str(), "codex" | "claudeAgent");
        let relative_home = if supported {
            let source_home = source
                .home_path
                .as_ref()
                .ok_or_else(|| invalid("A local native history provider has no configured home"))?;
            let source_home = Path::new(source_home);
            if !source_home.is_absolute()
                || source_home.components().any(|part| {
                    matches!(
                        part,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
            {
                return Err(invalid(
                    "Native history homes must be absolute canonical paths",
                ));
            }
            let relative = format!(
                "native-history/{}",
                hex::encode(Sha256::digest(source.provider_instance_id.as_bytes()))
            );
            let key = (
                source.driver.clone(),
                source_home.to_string_lossy().into_owned(),
            );
            if let Some(shared) = captured_homes.get(&key) {
                providers.push(NativeHistoryManifestEntry {
                    provider_instance_id: source.provider_instance_id.clone(),
                    driver: source.driver.clone(),
                    relative_home: Some(shared.clone()),
                    continuation: "captured".into(),
                    required_thread_count: ids.len(),
                    credential_policy: "external".into(),
                });
                continue;
            }
            let shared_ids = sources
                .iter()
                .filter(|other| {
                    other.driver == source.driver && other.home_path == source.home_path
                })
                .filter_map(|other| required.get(&other.provider_instance_id))
                .flat_map(|(_, ids)| ids.iter().cloned())
                .collect::<BTreeSet<_>>();
            let staging = home.join(&relative);
            let target = target_profile.join("agent-runtime").join(&relative);
            if source.driver == "codex" {
                let threads = shared_ids
                    .iter()
                    .map(|id| ProfileCloneThread {
                        thread_id: id.clone(),
                        backend_kind: "codex".into(),
                        execution_host_id: "local".into(),
                    })
                    .collect::<Vec<_>>();
                let receipt = codex::capture_home(source_home, &staging, &target, &threads)?;
                if !receipt.missing_thread_ids.is_empty() {
                    return Err(invalid(
                        "Codex native history is incomplete for captured Sessions",
                    ));
                }
            } else {
                capture_claude(source_home, &staging, &shared_ids)?;
            }
            captured_homes.insert(key, relative.clone());
            Some(relative)
        } else {
            None
        };
        providers.push(NativeHistoryManifestEntry {
            provider_instance_id: source.provider_instance_id.clone(),
            driver: source.driver.clone(),
            relative_home,
            continuation: if supported { "captured" } else { "external" }.into(),
            required_thread_count: ids.len(),
            credential_policy: "external".into(),
        });
    }
    if required.keys().any(|instance| !seen.contains(instance)) {
        return Err(invalid(
            "Execution references a provider whose native history configuration is unavailable",
        ));
    }
    Ok(NativeHistoryManifest { version: 1, providers, limitations: vec![
        "Credentials are supplied by the configured account after restore; backups never contain authentication files.".into(),
        "ACP and OpenCode retain their canonical execution transcript, while native continuation requires the original external provider history.".into(),
    ] })
}

fn capture_claude(source: &Path, destination: &Path, required: &BTreeSet<String>) -> Result<()> {
    files::private_directory(destination)?;
    if !files::exists(source)? {
        if !required.is_empty() {
            return Err(invalid(
                "Claude native history is missing for captured Sessions",
            ));
        }
        return Ok(());
    }
    files::require_directory(source)?;
    let before = files::inventory(source, &["projects", "file-history"], &[])?;
    let mut found = BTreeSet::new();
    for relative in before.keys() {
        // Projects contain native transcripts and delegated transcript trees, not account files.
        let subagent_metadata = relative
            .components()
            .any(|part| part.as_os_str() == "subagents")
            && relative
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".meta.json"));
        if relative.starts_with("projects")
            && relative
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            && !subagent_metadata
        {
            continue;
        }
        let source_path = source.join(relative);
        if let Some(id) = relative
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|id| required.contains(*id))
        {
            validate_claude_session(&source_path, id)?;
            found.insert(id.to_owned());
        }
        files::copy_file(&source_path, &destination.join(relative))?;
    }
    if !required.is_subset(&found) {
        return Err(invalid(
            "Claude native transcripts are incomplete for captured Sessions",
        ));
    }
    if before != files::inventory(source, &["projects", "file-history"], &[])? {
        return Err(invalid("Claude native history changed during capture"));
    }
    Ok(())
}

fn validate_claude_session(path: &Path, session_id: &str) -> Result<()> {
    let mut input = BufReader::new(files::read_file(path)?);
    let mut line = Vec::new();
    let mut observed = false;
    loop {
        line.clear();
        use std::io::Read;
        (&mut input)
            .take(64 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if line.is_empty() {
            break;
        }
        if line.len() > 64 * 1024 * 1024 {
            return Err(invalid("Claude native transcript record exceeds its bound"));
        }
        let record: serde_json::Value = serde_json::from_slice(&line)?;
        if let Some(id) = record.get("sessionId").and_then(serde_json::Value::as_str) {
            if id != session_id {
                return Err(invalid(
                    "Claude native transcript has a foreign Session identity",
                ));
            }
            observed = true;
        }
    }
    if !observed {
        return Err(invalid(
            "Claude native transcript has no recoverable Session identity",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core::administration::{
        NativeHistorySnapshotSource, ProfileCloneExecution, ProfileSnapshotSource,
    };
    use serde_json::json;
    use std::fs;

    const CODEX_ID: &str = "11111111-1111-7111-8111-111111111111";
    const CLAUDE_ID: &str = "22222222-2222-7222-8222-222222222222";

    fn fixture(profile: &Path) -> ProfileSnapshotSource {
        let home = profile.join("agent-runtime");
        files::private_directory(&home.join("userdata/attachments")).unwrap();
        files::create_file(&home.join("userdata/environment-id"))
            .unwrap()
            .write_all(b"engine:test\n")
            .unwrap();
        files::create_file(&home.join("userdata/attachments/image.png"))
            .unwrap()
            .write_all(b"retained attachment")
            .unwrap();
        let database = home.join("agent-runtime.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(status TEXT); CREATE TABLE orchestration_v2_effect_outbox(status TEXT); CREATE TABLE orchestration_events(sequence INTEGER,aggregate_kind TEXT,application_event_version INTEGER); INSERT INTO orchestration_events VALUES(2,'project',1),(99,'thread',1); CREATE TABLE orchestration_v2_projection_provider_threads(payload_json TEXT); CREATE TABLE orchestration_v2_projection_turn_items(item_id TEXT,payload_json TEXT)").unwrap();
        for (thread, instance, driver, native) in [
            ("thread:codex", "codex", "codex", CODEX_ID),
            ("thread:claude", "claude-work", "claudeAgent", CLAUDE_ID),
        ] {
            connection.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?1,NULL,?2)", [thread, &json!({"id":thread,"lineage":{"rootThreadId":thread,"parentThreadId":null}}).to_string()]).unwrap();
            connection.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?1)", [json!({"providerInstanceId":instance,"driver":driver,"nativeThreadRef":{"driver":driver,"nativeId":native,"strength":"strong"}}).to_string()]).unwrap();
        }
        connection
            .execute(
                "INSERT INTO orchestration_v2_projection_turn_items VALUES('full-item',?1)",
                [json!({"text":"retained history ".repeat(150_000)}).to_string()],
            )
            .unwrap();
        let codex = profile.join("agent");
        files::create_file(&codex.join(format!("sessions/rollout-{CODEX_ID}.jsonl")))
            .unwrap()
            .write_all(
                format!(
                    "{}\n",
                    json!({"type":"session_meta","payload":{"id":CODEX_ID}})
                )
                .as_bytes(),
            )
            .unwrap();
        files::create_file(&codex.join("auth.json"))
            .unwrap()
            .write_all(b"private Codex credential")
            .unwrap();
        let claude = profile.join("private-claude-account");
        files::create_file(&claude.join(format!("projects/workspace/{CLAUDE_ID}.jsonl"))).unwrap().write_all(format!("{}\n", json!({"type":"assistant","sessionId":CLAUDE_ID,"message":{"content":[{"type":"text","text":"complete Claude history"}]}})).as_bytes()).unwrap();
        files::create_file(&claude.join(format!(
            "projects/workspace/{CLAUDE_ID}/subagents/agent-child.jsonl"
        )))
        .unwrap()
        .write_all(
            format!(
                "{}\n",
                json!({"type":"assistant","sessionId":CLAUDE_ID,"message":{"content":[]}})
            )
            .as_bytes(),
        )
        .unwrap();
        files::create_file(&claude.join(format!(
            "projects/workspace/{CLAUDE_ID}/subagents/agent-child.meta.json"
        )))
        .unwrap()
        .write_all(
            serde_json::to_string(&json!({"toolUseId":"tool:launch","parentAgentId":null}))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        files::create_file(&claude.join(".credentials.json"))
            .unwrap()
            .write_all(b"private Claude credential")
            .unwrap();
        ProfileSnapshotSource {
            runtime_id: "engine:test".into(),
            runtime_generation: "process:test".into(),
            sequence: 2,
            database_path: database.to_string_lossy().into_owned(),
            environment_id_path: home
                .join("userdata/environment-id")
                .to_string_lossy()
                .into_owned(),
            attachments_path: home
                .join("userdata/attachments")
                .to_string_lossy()
                .into_owned(),
            native_histories: vec![
                NativeHistorySnapshotSource {
                    provider_instance_id: "codex".into(),
                    driver: "codex".into(),
                    home_path: Some(codex.to_string_lossy().into_owned()),
                },
                NativeHistorySnapshotSource {
                    provider_instance_id: "claude-work".into(),
                    driver: "claudeAgent".into(),
                    home_path: Some(claude.to_string_lossy().into_owned()),
                },
                NativeHistorySnapshotSource {
                    provider_instance_id: "external-acp".into(),
                    driver: "acpRegistry".into(),
                    home_path: None,
                },
            ],
        }
    }

    fn required() -> Vec<ProfileCloneExecution> {
        ["codex", "claude"]
            .map(|kind| ProfileCloneExecution {
                session_id: format!("session:{kind}"),
                runtime_id: "engine:test".into(),
                thread_id: format!("thread:{kind}"),
            })
            .into()
    }

    #[test]
    fn captures_complete_two_provider_history_without_credentials_and_preserves_resume_identities()
    {
        let source = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir().unwrap();
        let input = fixture(source.path());
        assert!(
            capture(ProfileSnapshotCapture {
                source_profile: source.path(),
                staging_profile: staged.path(),
                target_profile: source.path(),
                source: Some(&input),
                required: &required()
            })
            .unwrap()
        );
        let home = staged.path().join("agent-runtime");
        let manifest: NativeHistoryManifest =
            serde_json::from_slice(&fs::read(home.join("native-history/manifest.json")).unwrap())
                .unwrap();
        for (instance, native, expected) in [
            ("codex", CODEX_ID, "session_meta"),
            ("claude-work", CLAUDE_ID, "complete Claude history"),
        ] {
            let provider = manifest
                .providers
                .iter()
                .find(|provider| provider.provider_instance_id == instance)
                .unwrap();
            assert_eq!(provider.continuation, "captured");
            assert_eq!(provider.required_thread_count, 1);
            let native_home = home.join(provider.relative_home.as_ref().unwrap());
            let relative = if instance == "codex" {
                format!("sessions/rollout-{native}.jsonl")
            } else {
                format!("projects/workspace/{native}.jsonl")
            };
            assert!(
                fs::read_to_string(native_home.join(relative))
                    .unwrap()
                    .contains(expected)
            );
            assert!(!native_home.join("auth.json").exists());
            assert!(!native_home.join(".credentials.json").exists());
            if instance == "claude-work" {
                let metadata: serde_json::Value = serde_json::from_slice(
                    &fs::read(native_home.join(format!(
                        "projects/workspace/{native}/subagents/agent-child.meta.json"
                    )))
                    .unwrap(),
                )
                .unwrap();
                assert_eq!(metadata["toolUseId"], "tool:launch");
            }
        }
        let external = manifest
            .providers
            .iter()
            .find(|provider| provider.provider_instance_id == "external-acp")
            .unwrap();
        assert_eq!(external.continuation, "external");
        assert!(external.relative_home.is_none());
        let database = rusqlite::Connection::open(home.join("agent-runtime.sqlite")).unwrap();
        let full_history: String = database.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE item_id='full-item'",[],|row|row.get(0)).unwrap();
        assert!(full_history.len() > 2_000_000);
        assert_eq!(
            fs::read(home.join("userdata/attachments/image.png")).unwrap(),
            b"retained attachment"
        );
        assert_eq!(
            native_requirements(&database).unwrap()["claude-work"].1,
            BTreeSet::from([CLAUDE_ID.into()])
        );
    }

    #[test]
    fn rejects_missing_or_foreign_native_history_and_child_session_roots_before_publication() {
        for failure in ["missing", "foreign", "child"] {
            let source = tempfile::tempdir().unwrap();
            let staged = tempfile::tempdir().unwrap();
            let input = fixture(source.path());
            let transcript = source.path().join(format!(
                "private-claude-account/projects/workspace/{CLAUDE_ID}.jsonl"
            ));
            if failure == "missing" {
                fs::remove_file(&transcript).unwrap();
            }
            if failure == "foreign" {
                fs::write(&transcript, format!("{}\n", json!({"sessionId":"foreign"}))).unwrap();
            }
            if failure == "child" {
                rusqlite::Connection::open(&input.database_path).unwrap().execute("UPDATE orchestration_v2_projection_threads SET payload_json=?1 WHERE thread_id='thread:claude'",[json!({"lineage":{"rootThreadId":"thread:codex","parentThreadId":"thread:codex"}}).to_string()]).unwrap();
            }
            assert!(
                capture(ProfileSnapshotCapture {
                    source_profile: source.path(),
                    staging_profile: staged.path(),
                    target_profile: source.path(),
                    source: Some(&input),
                    required: &required()
                })
                .is_err(),
                "{failure}"
            );
            assert!(
                !staged
                    .path()
                    .join("agent-runtime/native-history/manifest.json")
                    .exists()
            );
        }
    }
}
