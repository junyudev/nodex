use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use nodex_core_contracts::library::LibrarySearchSnapshotLease;
use sha2::{Digest, Sha256};
use signal_hook::consts::SIGINT;
use signal_hook::iterator::Signals;

use crate::error::{CliError, CliErrorCode};

pub(crate) const MAX_ARGUMENTS: usize = 64;
pub(crate) const MAX_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RipgrepInvocation {
    pub(crate) forwarded: Vec<OsString>,
    pub(crate) pattern: OsString,
    pub(crate) scope: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RipgrepOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) exit_status: i32,
}

pub(crate) fn parse(arguments: Vec<OsString>) -> Result<RipgrepInvocation, CliError> {
    if arguments.is_empty() || arguments.len() > MAX_ARGUMENTS {
        return Err(unsupported(
            "rg requires one pattern and accepts at most 64 bounded arguments",
        ));
    }
    let total_bytes = arguments.iter().try_fold(0usize, |total, argument| {
        total.checked_add(argument.as_os_str().as_bytes().len())
    });
    if total_bytes.is_none_or(|total| total > MAX_ARGUMENT_BYTES) {
        return Err(unsupported("rg arguments exceed their byte bound"));
    }

    let mut forwarded = Vec::new();
    let mut positional = Vec::new();
    let mut index = 0usize;
    let mut flags_ended = false;
    while index < arguments.len() {
        let argument = &arguments[index];
        if !flags_ended && argument == "--" {
            flags_ended = true;
            index += 1;
            continue;
        }
        if !flags_ended && argument.as_os_str().as_bytes().starts_with(b"-") {
            let consumed = validate_flag(argument, arguments.get(index + 1))?;
            forwarded.push(argument.clone());
            if consumed {
                index += 1;
                forwarded.push(arguments[index].clone());
            }
            index += 1;
            continue;
        }
        positional.push(argument.clone());
        index += 1;
    }
    if !(1..=2).contains(&positional.len()) {
        return Err(unsupported(
            "rg accepts exactly one pattern and at most one Nodex scope selector",
        ));
    }
    let scope = positional
        .get(1)
        .map(|value| {
            value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| unsupported("the optional rg scope selector must be valid UTF-8"))
        })
        .transpose()?;
    Ok(RipgrepInvocation {
        forwarded,
        pattern: positional.remove(0),
        scope,
    })
}

fn validate_flag(argument: &OsStr, next: Option<&OsString>) -> Result<bool, CliError> {
    let value = argument
        .to_str()
        .ok_or_else(|| unsupported("rg flags must be valid UTF-8"))?;
    if allowed_boolean_flag(value) {
        return Ok(false);
    }
    if allowed_value_flag(value) {
        if next.is_none() {
            return Err(unsupported(format!("rg option {value} requires a value")));
        }
        return Ok(true);
    }
    if let Some((name, option_value)) = value.split_once('=')
        && allowed_long_value_flag(name)
        && !option_value.is_empty()
    {
        return Ok(false);
    }
    if allowed_short_cluster(value) {
        return Ok(false);
    }
    if allowed_attached_short_value(value) {
        return Ok(false);
    }
    Err(unsupported(format!(
        "rg option {value} is outside Nodex's read-only flag subset"
    )))
}

pub(crate) const BOOLEAN_FLAGS: &[&str] = &[
    "-n",
    "--line-number",
    "-i",
    "--ignore-case",
    "-s",
    "--case-sensitive",
    "-S",
    "--smart-case",
    "-F",
    "--fixed-strings",
    "-w",
    "--word-regexp",
    "-x",
    "--line-regexp",
    "-v",
    "--invert-match",
    "-c",
    "--count",
    "--count-matches",
    "-l",
    "--files-with-matches",
    "--files-without-match",
    "-q",
    "--quiet",
    "--column",
    "--crlf",
    "-U",
    "--multiline",
    "--multiline-dotall",
    "-P",
    "--pcre2",
    "--trim",
];

fn allowed_boolean_flag(value: &str) -> bool {
    BOOLEAN_FLAGS.contains(&value)
}

pub(crate) const VALUE_FLAGS: &[&str] = &[
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-m",
    "--max-count",
    "-g",
    "--glob",
    "--max-columns",
];

fn allowed_value_flag(value: &str) -> bool {
    VALUE_FLAGS.contains(&value)
}

fn allowed_long_value_flag(value: &str) -> bool {
    value.starts_with("--") && allowed_value_flag(value)
}

fn allowed_short_cluster(value: &str) -> bool {
    value.len() > 2
        && value.starts_with('-')
        && !value.starts_with("--")
        && value[1..].bytes().all(|flag| {
            matches!(
                flag,
                b'n' | b'i'
                    | b's'
                    | b'S'
                    | b'F'
                    | b'w'
                    | b'x'
                    | b'v'
                    | b'c'
                    | b'l'
                    | b'q'
                    | b'U'
                    | b'P'
            )
        })
}

fn allowed_attached_short_value(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() > 2 && bytes[0] == b'-' && matches!(bytes[1], b'A' | b'B' | b'C' | b'm' | b'g')
}

pub(crate) fn run(
    lease: &LibrarySearchSnapshotLease,
    invocation: &RipgrepInvocation,
) -> Result<RipgrepOutput, CliError> {
    validate_lease(lease)?;
    let executable = discover_rg_executable()?;
    let mut signals = Signals::new([SIGINT]).map_err(|error| {
        CliError::new(
            CliErrorCode::CoreUnavailable,
            format!("could not install the ripgrep interrupt handler: {error}"),
        )
    })?;
    let mut child = Command::new(&executable)
        .args([
            "--no-config",
            "--no-heading",
            "--with-filename",
            "--color=never",
            "--sort=path",
        ])
        .args(&invocation.forwarded)
        .arg("--")
        .arg(&invocation.pattern)
        .arg("pages")
        .current_dir(&lease.physical_root)
        .env_remove("RIPGREP_CONFIG_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CliError::new(
                CliErrorCode::CoreUnavailable,
                format!("could not execute bundled ripgrep: {error}"),
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| internal("ripgrep stdout pipe is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| internal("ripgrep stderr pipe is unavailable"))?;
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));
    let (status, interrupted) = wait_for_child(&mut child, || {
        signals.pending().any(|signal| signal == SIGINT)
    })?;
    signals.handle().close();
    let stdout = join_pipe(stdout_reader, "stdout")?;
    let stderr = join_pipe(stderr_reader, "stderr")?;
    if interrupted {
        return Ok(RipgrepOutput {
            stdout: Vec::new(),
            exit_status: crate::EXIT_INTERRUPTED,
        });
    }
    if !matches!(status, 0 | 1) {
        let diagnostic = String::from_utf8_lossy(&stderr);
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("ripgrep rejected the search: {}", diagnostic.trim()),
        ));
    }
    Ok(RipgrepOutput {
        stdout: remap_output(&stdout, lease),
        exit_status: status,
    })
}

fn wait_for_child(
    child: &mut std::process::Child,
    mut interrupted: impl FnMut() -> bool,
) -> Result<(i32, bool), CliError> {
    loop {
        if interrupted() {
            let _ = child.kill();
            let _ = child.wait();
            return Ok((crate::EXIT_INTERRUPTED, true));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok((status.code().unwrap_or(crate::EXIT_REJECTED), false));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(internal(error));
            }
        }
    }
}

fn read_pipe(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_pipe(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    label: &str,
) -> Result<Vec<u8>, CliError> {
    reader
        .join()
        .map_err(|_| internal(format!("ripgrep {label} reader panicked")))?
        .map_err(|error| internal(format!("ripgrep {label} could not be read: {error}")))
}

fn validate_lease(lease: &LibrarySearchSnapshotLease) -> Result<(), CliError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_millis();
    if now >= u128::try_from(lease.expires_at_unix_ms).unwrap_or(0) {
        return Err(CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot lease expired before ripgrep started",
        ));
    }
    let root = Path::new(&lease.physical_root);
    let root_metadata = fs::symlink_metadata(root).map_err(|_| {
        CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot root is unavailable",
        )
    })?;
    if !root.is_absolute()
        || !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || root_metadata.permissions().mode() & 0o777 != 0o500
    {
        return Err(CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot root is not an immutable directory",
        ));
    }
    let manifest_path = root.join("manifest.json");
    let manifest = fs::symlink_metadata(&manifest_path).map_err(|_| {
        CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot manifest is unavailable",
        )
    })?;
    if !manifest.is_file()
        || manifest.file_type().is_symlink()
        || manifest.permissions().mode() & 0o777 != 0o400
    {
        return Err(CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot manifest is not immutable",
        ));
    }
    let marker = fs::read(&manifest_path)
        .map_err(internal)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).map_err(internal))?;
    let expected_manifest = serde_json::to_value(&lease.manifest).map_err(internal)?;
    if marker.get("lease_id").and_then(serde_json::Value::as_str) != Some(lease.lease_id.as_str())
        || marker
            .get("expires_at_unix_ms")
            .and_then(serde_json::Value::as_i64)
            != Some(lease.expires_at_unix_ms)
        || marker.get("manifest") != Some(&expected_manifest)
    {
        return Err(CliError::new(
            CliErrorCode::SnapshotExpired,
            "Core search snapshot manifest does not match its lease",
        ));
    }
    for page in &lease.manifest.pages {
        for file in [&page.meta, &page.body] {
            let relative = Path::new(&file.physical_relative_path);
            let components = relative.components().collect::<Vec<_>>();
            if relative.is_absolute()
                || components.len() != 3
                || components.first() != Some(&Component::Normal(OsStr::new("pages")))
                || relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(internal(
                    "Core search snapshot returned an unsafe file path",
                ));
            }
            let physical = root.join(relative);
            let metadata = fs::symlink_metadata(&physical).map_err(|_| {
                CliError::new(
                    CliErrorCode::SnapshotExpired,
                    "Core search snapshot file is unavailable",
                )
            })?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.permissions().mode() & 0o777 != 0o400
            {
                return Err(CliError::new(
                    CliErrorCode::SnapshotExpired,
                    "Core search snapshot file is not immutable",
                ));
            }
            let bytes = fs::read(&physical).map_err(internal)?;
            if hex::encode(Sha256::digest(&bytes)) != file.sha256
                || u64::try_from(bytes.len()).ok() != Some(file.byte_length)
            {
                return Err(CliError::new(
                    CliErrorCode::SnapshotExpired,
                    "Core search snapshot file failed manifest validation",
                ));
            }
        }
    }
    Ok(())
}

fn remap_output(output: &[u8], lease: &LibrarySearchSnapshotLease) -> Vec<u8> {
    let mappings = lease
        .manifest
        .pages
        .iter()
        .flat_map(|page| {
            [
                (
                    page.meta.physical_relative_path.as_bytes(),
                    page.meta.logical_path.as_bytes(),
                ),
                (
                    page.body.physical_relative_path.as_bytes(),
                    page.body.logical_path.as_bytes(),
                ),
            ]
        })
        .collect::<BTreeMap<_, _>>();
    let mut remapped = Vec::with_capacity(output.len());
    for line in output.split_inclusive(|byte| *byte == b'\n') {
        let line_without_newline = line.strip_suffix(b"\n").unwrap_or(line);
        let mapping = mappings.iter().find(|(physical, _)| {
            line_without_newline.starts_with(physical)
                && line_without_newline
                    .get(physical.len())
                    .is_none_or(|separator| matches!(separator, b':' | b'-'))
        });
        if let Some((physical, logical)) = mapping {
            remapped.extend_from_slice(logical);
            remapped.extend_from_slice(&line[physical.len()..]);
        } else {
            remapped.extend_from_slice(line);
        }
    }
    remapped
}

fn discover_rg_executable() -> Result<PathBuf, CliError> {
    if let Some(path) = std::env::var_os("NODEX_RG_BINARY") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(CliError::new(
            CliErrorCode::CoreUnavailable,
            format!("NODEX_RG_BINARY does not name a file: {}", path.display()),
        ));
    }
    let current = fs::canonicalize(std::env::current_exe().map_err(internal)?).map_err(internal)?;
    if let Some(packaged) = packaged_rg_path(&current)
        && packaged.is_file()
    {
        return Ok(packaged);
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from("rg"));
    }
    Err(CliError::new(
        CliErrorCode::CoreUnavailable,
        format!(
            "expected packaged codex-path/rg for {} or NODEX_RG_BINARY",
            current.display()
        ),
    ))
}

fn packaged_rg_path(cli_executable: &Path) -> Option<PathBuf> {
    let bin_dir = cli_executable.parent()?;
    if bin_dir.file_name() != Some(OsStr::new("bin")) {
        return None;
    }
    let runtime_root = bin_dir.parent()?;
    Some(runtime_root.join("codex-path").join("rg"))
}

fn unsupported(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::RgArgumentUnsupported, message)
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::library::LibraryPageProjectionFileKind;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn resolves_packaged_ripgrep_from_the_shared_runtime_root() {
        let cli = Path::new("/Applications/Nodex.app/Contents/Resources/bin/nodex");
        assert_eq!(
            packaged_rg_path(cli),
            Some(PathBuf::from(
                "/Applications/Nodex.app/Contents/Resources/codex-path/rg",
            )),
        );
        assert_eq!(
            packaged_rg_path(Path::new("/workspace/target/debug/nodex")),
            None,
        );
    }

    #[test]
    fn accepts_only_the_documented_read_only_flag_subset() {
        let parsed = parse(
            [
                "-niF",
                "--glob",
                "*.nested.md",
                "--context=2",
                "Core starts",
                "@page-1",
            ]
            .map(OsString::from)
            .to_vec(),
        )
        .expect("safe ripgrep invocation");
        assert_eq!(parsed.pattern, "Core starts");
        assert_eq!(parsed.scope.as_deref(), Some("@page-1"));
        assert_eq!(
            parsed.forwarded,
            ["-niF", "--glob", "*.nested.md", "--context=2"].map(OsString::from)
        );

        for rejected in [
            vec!["--pre", "cat", "pattern"],
            vec!["--follow", "pattern"],
            vec!["--search-zip", "pattern"],
            vec!["--json", "pattern"],
            vec!["--null", "pattern"],
            vec!["--context-separator", "x", "pattern"],
            vec!["pattern", "scope", "external-path"],
        ] {
            let error = parse(rejected.into_iter().map(OsString::from).collect())
                .expect_err("unsafe ripgrep arguments must fail");
            assert_eq!(error.code, CliErrorCode::RgArgumentUnsupported);
        }
    }

    #[test]
    fn remaps_only_physical_path_prefixes() {
        let lease = LibrarySearchSnapshotLease {
            lease_id: "0".repeat(32),
            expires_at_unix_ms: i64::MAX,
            physical_root: "/tmp/snapshot".to_owned(),
            manifest: nodex_core_contracts::library::LibrarySearchSnapshotManifest {
                version: 1,
                projection_version: 1,
                library_id: "library-1".to_owned(),
                access_project_id: "project-1".to_owned(),
                store_epoch: "epoch-1".to_owned(),
                commit_head: 1,
                scope: nodex_core_contracts::library::LibrarySearchSnapshotScope::Page {
                    page_id: "page-1".to_owned(),
                },
                pages: vec![nodex_core_contracts::library::LibrarySearchSnapshotPage {
                    page_id: "page-1".to_owned(),
                    title_markdown: "CLI".to_owned(),
                    database_id: None,
                    data_source_id: None,
                    ownership_path: Vec::new(),
                    metadata_revision: 1,
                    document_generation: 1,
                    document_head_seq: 1,
                    data_source_schema_revision: None,
                    property_revisions: BTreeMap::new(),
                    value_revisions: BTreeMap::new(),
                    schedule_revision: None,
                    title_sha256: "a".repeat(64),
                    meta: file(
                        LibraryPageProjectionFileKind::MetaYaml,
                        "pages/hash/meta.yaml",
                        "Library/CLI~page-1/meta.yaml",
                    ),
                    body: file(
                        LibraryPageProjectionFileKind::BodyNestedMarkdown,
                        "pages/hash/body.nested.md",
                        "Library/CLI~page-1/body.nested.md",
                    ),
                }],
                warnings: Vec::new(),
            },
        };
        assert_eq!(
            remap_output(
                b"pages/hash/body.nested.md:4:Core starts\n2 matches\n",
                &lease
            ),
            b"Library/CLI~page-1/body.nested.md:4:Core starts\n2 matches\n"
        );
    }

    #[test]
    fn executes_real_ripgrep_and_preserves_match_and_no_match_statuses() {
        let directory = tempdir().expect("snapshot parent");
        let root = directory.path().join("snapshot");
        let page_root = root.join("pages/hash");
        fs::create_dir_all(&page_root).expect("snapshot layout");
        let meta_bytes = b"id: \"page-1\"\ntitle: \"CLI\"\nproperties: {}\nschedule: null\n";
        let body_bytes = b"## Runtime\nCore starts on demand.\n";
        let meta_path = page_root.join("meta.yaml");
        let body_path = page_root.join("body.nested.md");
        fs::write(&meta_path, meta_bytes).expect("metadata projection");
        fs::write(&body_path, body_bytes).expect("body projection");
        let mut lease = LibrarySearchSnapshotLease {
            lease_id: "0".repeat(32),
            expires_at_unix_ms: i64::MAX,
            physical_root: root.to_string_lossy().into_owned(),
            manifest: nodex_core_contracts::library::LibrarySearchSnapshotManifest {
                version: 1,
                projection_version: 1,
                library_id: "library-1".to_owned(),
                access_project_id: "project-1".to_owned(),
                store_epoch: "epoch-1".to_owned(),
                commit_head: 1,
                scope: nodex_core_contracts::library::LibrarySearchSnapshotScope::Page {
                    page_id: "page-1".to_owned(),
                },
                pages: vec![nodex_core_contracts::library::LibrarySearchSnapshotPage {
                    page_id: "page-1".to_owned(),
                    title_markdown: "CLI".to_owned(),
                    database_id: None,
                    data_source_id: None,
                    ownership_path: Vec::new(),
                    metadata_revision: 1,
                    document_generation: 1,
                    document_head_seq: 1,
                    data_source_schema_revision: None,
                    property_revisions: BTreeMap::new(),
                    value_revisions: BTreeMap::new(),
                    schedule_revision: None,
                    title_sha256: digest(b"CLI"),
                    meta: projected_file(
                        LibraryPageProjectionFileKind::MetaYaml,
                        "pages/hash/meta.yaml",
                        "Library/CLI~page-1/meta.yaml",
                        meta_bytes,
                    ),
                    body: projected_file(
                        LibraryPageProjectionFileKind::BodyNestedMarkdown,
                        "pages/hash/body.nested.md",
                        "Library/CLI~page-1/body.nested.md",
                        body_bytes,
                    ),
                }],
                warnings: Vec::new(),
            },
        };
        let marker = serde_json::json!({
            "lease_id": lease.lease_id,
            "expires_at_unix_ms": lease.expires_at_unix_ms,
            "manifest": lease.manifest,
        });
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&marker).expect("marker JSON"),
        )
        .expect("manifest marker");
        for file in [&meta_path, &body_path, &root.join("manifest.json")] {
            fs::set_permissions(file, fs::Permissions::from_mode(0o400)).expect("immutable file");
        }
        fs::set_permissions(&page_root, fs::Permissions::from_mode(0o500))
            .expect("immutable Page directory");
        fs::set_permissions(root.join("pages"), fs::Permissions::from_mode(0o500))
            .expect("immutable pages directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500))
            .expect("immutable lease root");

        // Rebuild the typed value because `json!` above borrowed rather than consumed it.
        lease.manifest =
            serde_json::from_value(marker["manifest"].clone()).expect("typed manifest");
        let matching = run(
            &lease,
            &parse(["-n", "Core"].map(OsString::from).to_vec()).expect("matching invocation"),
        )
        .expect("real ripgrep match");
        assert_eq!(matching.exit_status, 0);
        assert_eq!(
            matching.stdout,
            b"Library/CLI~page-1/body.nested.md:2:Core starts on demand.\n"
        );

        let missing = run(
            &lease,
            &parse(["definitely-no-match"].map(OsString::from).to_vec())
                .expect("no-match invocation"),
        )
        .expect("real ripgrep no-match result");
        assert_eq!(missing.exit_status, 1);
        assert!(missing.stdout.is_empty());

        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("release root");
        fs::set_permissions(root.join("pages"), fs::Permissions::from_mode(0o700))
            .expect("release pages");
        fs::set_permissions(&page_root, fs::Permissions::from_mode(0o700))
            .expect("release Page directory");
        for file in [&meta_path, &body_path, &root.join("manifest.json")] {
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).expect("release file");
        }
    }

    #[test]
    fn interrupt_polling_terminates_the_child_and_returns_130_for_caller_cleanup() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("long-running child");
        let mut polls = 0;
        let outcome = wait_for_child(&mut child, || {
            polls += 1;
            polls == 1
        })
        .expect("interrupt outcome");
        assert_eq!(outcome, (crate::EXIT_INTERRUPTED, true));
        assert!(child.try_wait().expect("reaped child").is_some());
    }

    fn file(
        kind: LibraryPageProjectionFileKind,
        physical: &str,
        logical: &str,
    ) -> nodex_core_contracts::library::LibrarySearchSnapshotFile {
        nodex_core_contracts::library::LibrarySearchSnapshotFile {
            kind,
            sha256: "b".repeat(64),
            byte_length: 1,
            physical_relative_path: physical.to_owned(),
            logical_path: logical.to_owned(),
        }
    }

    fn projected_file(
        kind: LibraryPageProjectionFileKind,
        physical: &str,
        logical: &str,
        bytes: &[u8],
    ) -> nodex_core_contracts::library::LibrarySearchSnapshotFile {
        nodex_core_contracts::library::LibrarySearchSnapshotFile {
            kind,
            sha256: digest(bytes),
            byte_length: u64::try_from(bytes.len()).expect("fixture length"),
            physical_relative_path: physical.to_owned(),
            logical_path: logical.to_owned(),
        }
    }

    fn digest(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }
}
