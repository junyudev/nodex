use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use fs2::FileExt;
use nodex_core_contracts::{
    DATABASE_CONTRACT_VERSION, LIBRARY_CONTRACT_VERSION, ModuleReadRequest,
    PROJECT_WORKSPACE_CONTRACT_VERSION, collection::CollectionWindowRequest,
    database::DatabaseRead,
};
use nodex_core_protocol::{
    ClientIdentity, ClientKind, CoreArtifactIdentity, CoreReplacementRequest,
    CoreSelectionDisposition, CoreSelectionPolicy, CoreSelectionReason, CoreSelectionResult,
    HandshakeRequest, LauncherKind, RuntimeDescriptor, RuntimeGenerationIdentity, ShutdownRequest,
    ShutdownResponse, ShutdownStatus, VersionRange, canonical_manifest_digest,
    core_client_requirements, core_compatibility_manifest,
};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn log_identity(identity: &str) -> String {
    let digest = Sha256::digest(identity.as_bytes());
    format!("sha256:{}", &hex::encode(digest)[..32])
}

fn read_selection_result(child: &mut Child) -> CoreSelectionResult {
    let stdout = child.stdout.take().expect("captured stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).expect("ready line");
    if bytes == 0 {
        let status = child.wait().expect("wait for failed Core startup");
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .expect("captured stderr")
            .read_to_string(&mut stderr)
            .expect("failed Core stderr");
        panic!("Core exited before readiness ({status}): {stderr}");
    }
    serde_json::from_str::<CoreSelectionResult>(line.trim()).expect("Core selection result JSON")
}

fn read_ready_descriptor(child: &mut Child) -> RuntimeDescriptor {
    read_selection_result(child).descriptor
}

fn request(socket: &str, auth: &str, method: &str, path: &str, body: &str) -> String {
    request_with_headers(socket, auth, method, path, body, &[])
}

fn request_with_headers(
    socket: &str,
    auth: &str,
    method: &str,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> String {
    request_bytes_with_headers(socket, auth, method, path, body.as_bytes(), headers)
}

fn request_bytes_with_headers(
    socket: &str,
    auth: &str,
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> String {
    let mut stream = UnixStream::connect(socket).expect("connect to Core socket");
    let headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let write_result = write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {auth}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
    );
    if write_result.is_ok() {
        let _ = stream.write_all(body).inspect_err(|error| {
            assert!(
                matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::NotConnected
                ),
                "unexpected request-body write error: {error}"
            );
        });
    }
    if let Err(error) = write_result {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::NotConnected
            ),
            "unexpected request write error: {error}"
        );
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

fn open_sse(
    socket: &str,
    auth: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> BufReader<UnixStream> {
    let mut stream = UnixStream::connect(socket).expect("connect SSE to Core socket");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("bound SSE read timeout");
    let headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {auth}\r\n{headers}Connection: close\r\n\r\n",
    )
    .expect("write SSE request");
    let mut reader = BufReader::new(stream);
    let mut response_head = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read SSE response head");
        assert!(!line.is_empty(), "SSE response ended before its headers");
        response_head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    assert!(
        response_head.starts_with("HTTP/1.1 200"),
        "unexpected SSE response: {response_head:?}"
    );
    reader
}

fn response_json(response: &str) -> serde_json::Value {
    let (_, body) = response.split_once("\r\n\r\n").expect("HTTP response body");
    serde_json::from_str(body)
        .unwrap_or_else(|error| panic!("JSON response ({error}): {response:?}"))
}

fn wait_for_event_replay_metrics(socket: &str, auth: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let health = response_json(&request(socket, auth, "GET", "/core/v1/health", ""));
        if health["metrics"]["event_replay_lag_max"]
            .as_u64()
            .is_some_and(|lag| lag > 0)
        {
            return health;
        }
        assert!(
            Instant::now() < deadline,
            "event replay metrics were not recorded after the stream opened"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn bind_test_client(descriptor: &RuntimeDescriptor, auth: &str, connection_id: &str) -> String {
    let handshake = serde_json::to_string(&HandshakeRequest {
        requirements: core_client_requirements(),
        client: ClientIdentity {
            kind: ClientKind::ElectronHost,
            build_id: "lifecycle-active-host-test".to_owned(),
        },
        connection_id: connection_id.to_owned(),
        expected_generation: RuntimeGenerationIdentity::from(descriptor),
    })
    .expect("handshake JSON");
    let response = request(
        &descriptor.socket_path,
        auth,
        "POST",
        "/core/v1/handshake",
        &handshake,
    );
    assert!(response.starts_with("HTTP/1.1 200"), "{response:?}");
    response_json(&response)["connection_binding"]
        .as_str()
        .expect("connection binding")
        .to_owned()
}

fn lifecycle_summary(home: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(
        &fs::read(home.join("run/core/lifecycle.json")).expect("lifecycle summary"),
    )
    .expect("lifecycle summary JSON")
}

fn replacement_request(descriptor: &RuntimeDescriptor) -> String {
    replacement_request_for(descriptor, descriptor.manifest.clone())
}

fn replacement_request_for(
    descriptor: &RuntimeDescriptor,
    candidate_manifest: nodex_core_protocol::CoreCompatibilityManifest,
) -> String {
    let candidate_manifest_digest =
        canonical_manifest_digest(&candidate_manifest).expect("candidate manifest digest");
    serde_json::to_string(&ShutdownRequest::Replacement(Box::new(
        CoreReplacementRequest {
            candidate_manifest,
            candidate_manifest_digest,
            candidate_artifact: CoreArtifactIdentity {
                sha256: "f".repeat(64),
                build_id: "future-core-test".to_owned(),
            },
            policy: CoreSelectionPolicy::PreferCurrentArtifact,
            launcher: LauncherKind::Test,
            expected: RuntimeGenerationIdentity::from(descriptor),
        },
    )))
    .expect("replacement handoff JSON")
}

#[test]
fn concurrent_launchers_reuse_one_authenticated_profile_core() {
    let directory = tempdir().expect("disposable Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = env!("CARGO_BIN_EXE_nodex-core");
    let mut children: Vec<Child> = (0..8)
        .map(|_| {
            Command::new(executable)
                .args(["--home", home.to_str().expect("UTF-8 home")])
                .env("NODEX_LOG_FILE", "true")
                .env("NODEX_LOG_CONSOLE", "false")
                .env("NODEX_LOG_FILE_LEVEL", "debug")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn Core contender")
        })
        .collect();

    let descriptors: Vec<RuntimeDescriptor> =
        children.iter_mut().map(read_ready_descriptor).collect();
    let expected = descriptors.first().expect("one descriptor");
    assert!(descriptors.iter().all(|descriptor| {
        descriptor.pid == expected.pid && descriptor.start_nonce == expected.start_nonce
    }));

    let runtime = home.join("run/core");
    for name in [
        "core.lock",
        "core.sock",
        "core.json",
        "core.auth",
        "lifecycle.json",
    ] {
        let mode = fs::symlink_metadata(runtime.join(name))
            .expect("runtime entry")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "{name}");
    }
    assert_eq!(
        fs::metadata(&runtime)
            .expect("runtime directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let auth = fs::read_to_string(runtime.join("core.auth"))
        .expect("auth capability")
        .trim()
        .to_owned();
    let unauthorized = request(&expected.socket_path, "wrong", "GET", "/core/v1/health", "");
    assert!(
        unauthorized.starts_with("HTTP/1.1 401"),
        "unexpected unauthorized response: {unauthorized:?}"
    );
    const PRIVATE_PATH_SENTINEL: &str = "PRIVATE_PATH_MUST_NOT_REACH_CORE_LOGS";
    let unknown_path = format!("/{PRIVATE_PATH_SENTINEL}");
    let unknown = request(&expected.socket_path, "wrong", "GET", &unknown_path, "");
    assert!(
        unknown.starts_with("HTTP/1.1 401"),
        "unexpected unknown-path response: {unknown:?}"
    );
    let health = request(&expected.socket_path, &auth, "GET", "/core/v1/health", "");
    assert!(health.starts_with("HTTP/1.1 200"));
    assert!(health.contains(&format!("\"pid\":{}", expected.pid)));

    let handshake = serde_json::to_string(&HandshakeRequest {
        requirements: core_client_requirements(),
        client: ClientIdentity {
            kind: ClientKind::Test,
            build_id: "lifecycle-test".to_owned(),
        },
        connection_id: "connection:lifecycle".to_owned(),
        expected_generation: RuntimeGenerationIdentity::from(expected),
    })
    .expect("handshake JSON");
    let response = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &handshake,
    );
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains(&expected.start_nonce));
    let handshake_json = response_json(&response);
    let connection_binding = handshake_json["connection_binding"]
        .as_str()
        .expect("connection binding")
        .to_owned();

    let mut invalid_requirements = core_client_requirements();
    invalid_requirements.transport.min = 0;
    invalid_requirements.transport.max = 0;
    let downgrade = serde_json::to_string(&HandshakeRequest {
        requirements: invalid_requirements,
        client: ClientIdentity {
            kind: ClientKind::Test,
            build_id: "lifecycle-test".to_owned(),
        },
        connection_id: "connection:downgrade".to_owned(),
        expected_generation: RuntimeGenerationIdentity::from(expected),
    })
    .expect("downgrade JSON");
    let downgrade = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &downgrade,
    );
    assert!(downgrade.starts_with("HTTP/1.1 409"));

    let rebound = serde_json::to_string(&HandshakeRequest {
        requirements: core_client_requirements(),
        client: ClientIdentity {
            kind: ClientKind::NativeCli,
            build_id: "different-client".to_owned(),
        },
        connection_id: "connection:lifecycle".to_owned(),
        expected_generation: RuntimeGenerationIdentity::from(expected),
    })
    .expect("rebind JSON");
    let rebound = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &rebound,
    );
    assert!(rebound.starts_with("HTTP/1.1 409"));

    let connection_headers = [
        ("x-nodex-connection-id", "connection:lifecycle"),
        ("x-nodex-connection-binding", connection_binding.as_str()),
    ];
    let library_read = serde_json::json!({
        "contract_version": LIBRARY_CONTRACT_VERSION,
        "read": { "kind": "metadata" }
    })
    .to_string();
    let read = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/read",
        &library_read,
        &connection_headers,
    );
    assert!(read.starts_with("HTTP/1.1 200"));
    let read_json = response_json(&read);
    assert_eq!(read_json["status"], "ok");
    assert_eq!(read_json["payload"]["commit_head"], 0);
    let library_id = read_json["payload"]["value"]["library_id"]
        .as_str()
        .expect("Library identity")
        .to_owned();
    assert!(library_id.starts_with("library-"));

    let create_initial_project = serde_json::json!({
        "contract_version": PROJECT_WORKSPACE_CONTRACT_VERSION,
        "operation_id": "lifecycle-initial-project",
        "store_epoch": expected.store_epoch,
        "intent": {
            "kind": "create_initial_project",
            "project_id": "project:default",
            "name": "Default",
            "description": "",
            "appearance": null,
            "source_roots": ["/workspace/default"],
            "starter_page": {
                "page_id": "page:getting-started",
                "document_id": "document:getting-started",
                "title_markdown": "Welcome to Nodex",
                "nfm": "Welcome to Nodex."
            }
        }
    })
    .to_string();
    let initial_project = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/workspace/apply",
        &create_initial_project,
        &connection_headers,
    );
    assert_eq!(response_json(&initial_project)["status"], "ok");

    let apply_body = serde_json::json!({
        "contract_version": LIBRARY_CONTRACT_VERSION,
        "operation_id": "lifecycle-operation-1",
        "store_epoch": expected.store_epoch,
        "intent": {
            "kind": "create_page",
            "page_id": "page:lifecycle",
            "document_id": "document:lifecycle",
            "title": "Core lifecycle",
            "parent": { "kind": "library", "before": null }
        }
    })
    .to_string();
    let module_headers = [
        ("x-nodex-project-id", "project:default"),
        ("x-nodex-connection-id", "connection:lifecycle"),
        ("x-nodex-connection-binding", connection_binding.as_str()),
    ];
    let apply = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &apply_body,
        &module_headers,
    );
    assert!(apply.starts_with("HTTP/1.1 200"));
    let apply_json = response_json(&apply);
    assert_eq!(apply_json["status"], "ok");
    assert_eq!(apply_json["payload"]["status"], "committed");
    let page_commit_sequence = apply_json["payload"]["commit"]["commit_seq"]
        .as_i64()
        .expect("Page commit sequence");
    assert!(page_commit_sequence >= 1);
    assert_eq!(apply_json["payload"]["receipt"]["duplicate"], false);

    const PRIVATE_LOG_SENTINEL: &str = "PRIVATE_TITLE_MUST_NOT_REACH_CORE_LOGS";
    const LOG_OPERATION_ID: &str = "logging-correlation-operation";
    let logged_apply_body = serde_json::json!({
        "contract_version": LIBRARY_CONTRACT_VERSION,
        "operation_id": LOG_OPERATION_ID,
        "store_epoch": expected.store_epoch,
        "intent": {
            "kind": "create_page",
            "page_id": "page:logging-correlation",
            "document_id": "document:logging-correlation",
            "title": PRIVATE_LOG_SENTINEL,
            "parent": { "kind": "library", "before": null }
        }
    })
    .to_string();
    let logged_apply = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &logged_apply_body,
        &module_headers,
    );
    let logged_apply = response_json(&logged_apply);
    assert_eq!(logged_apply["status"], "ok");
    let logged_commit_sequence = logged_apply["payload"]["commit"]["commit_seq"]
        .as_i64()
        .expect("logged commit sequence");

    let replay = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &apply_body,
        &module_headers,
    );
    assert_eq!(
        response_json(&replay)["payload"]["receipt"]["duplicate"],
        true
    );
    assert_eq!(
        response_json(&replay)["payload"]["commit"]["commit_seq"],
        page_commit_sequence
    );

    const DATABASE_ID: &str = "018f2000-0000-7000-8000-000000000001";
    const SOURCE_ID: &str = "018f2000-0000-7000-8000-000000000002";
    const VIEW_ID: &str = "018f2000-0000-7000-8000-000000000003";
    let create_database = serde_json::json!({
        "contract_version": LIBRARY_CONTRACT_VERSION,
        "operation_id": "lifecycle-database-create",
        "store_epoch": expected.store_epoch,
        "intent": {
            "kind": "create_database",
            "database_id": DATABASE_ID,
            "data_source_id": SOURCE_ID,
            "view_id": VIEW_ID,
            "name": "Lifecycle work",
            "parent": { "kind": "library", "before": null }
        }
    })
    .to_string();
    let created_database = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &create_database,
        &module_headers,
    );
    assert_eq!(response_json(&created_database)["status"], "ok");

    let grant_database = serde_json::json!({
        "contract_version": LIBRARY_CONTRACT_VERSION,
        "operation_id": "lifecycle-database-grant",
        "store_epoch": expected.store_epoch,
        "intent": {
            "kind": "grant_project_access",
            "project_id": "project:default",
            "target": { "kind": "database", "database_id": DATABASE_ID },
            "access": "read_write"
        }
    })
    .to_string();
    let granted_database = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &grant_database,
        &module_headers,
    );
    assert_eq!(response_json(&granted_database)["status"], "ok");

    let redundant_grant = grant_database.replace(
        "lifecycle-database-grant",
        "lifecycle-database-grant-redundant",
    );
    let redundant_grant = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/library/apply",
        &redundant_grant,
        &module_headers,
    );
    let redundant_grant = response_json(&redundant_grant);
    assert_eq!(redundant_grant["status"], "ok");
    assert_eq!(redundant_grant["payload"]["status"], "no_op");
    assert!(redundant_grant["payload"].get("commit").is_none());
    assert!(redundant_grant["payload"].get("delivery").is_none());
    assert_eq!(
        redundant_grant["payload"]["observed"]["store_epoch"],
        expected.store_epoch,
    );
    assert_eq!(redundant_grant["payload"]["receipt"]["did_mutate"], false,);

    let database_read = serde_json::to_string(&ModuleReadRequest {
        contract_version: DATABASE_CONTRACT_VERSION,
        read: DatabaseRead::PropertyWindow {
            data_source_id: SOURCE_ID.to_owned(),
            window: CollectionWindowRequest {
                after: None,
                first: Some(200),
            },
        },
    })
    .expect("Database Property window JSON");
    let database_read = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/database/read",
        &database_read,
        &module_headers,
    );
    let database_read = response_json(&database_read);
    assert_eq!(database_read["status"], "ok");
    assert_eq!(
        database_read["payload"]["value"]["properties"]["items"]
            .as_array()
            .map(Vec::len),
        Some(9)
    );

    let database_apply_body = serde_json::json!({
        "contract_version": DATABASE_CONTRACT_VERSION,
        "operation_id": "lifecycle-database-property",
        "store_epoch": expected.store_epoch,
        "intent": [{
            "kind": "put_property",
            "data_source_id": SOURCE_ID,
            "property_id": "p_risk0000",
            "expected_data_source_revision": 1,
            "expected_property_revision": 0,
            "name": "Risk",
            "schema": { "kind": "select" },
            "before_property_id": null
        }]
    })
    .to_string();
    let database_apply = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/modules/database/apply",
        &database_apply_body,
        &module_headers,
    );
    let database_apply = response_json(&database_apply);
    assert_eq!(database_apply["status"], "error");
    assert_eq!(database_apply["payload"]["code"], "unauthorized");

    let oversized = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &"x".repeat(2 * 1024 * 1024 + 1),
    );
    assert!(oversized.starts_with("HTTP/1.1 413"));

    let invalid_utf8 = request_bytes_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &[b'{', b'"', b'x', b'"', b':', b'"', 0xff, b'"', b'}'],
        &[],
    );
    assert!(invalid_utf8.starts_with("HTTP/1.1 400"));

    let deep_json = format!("{}0{}", "[".repeat(34), "]".repeat(34));
    let deep_json = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/handshake",
        &deep_json,
    );
    assert!(deep_json.starts_with("HTTP/1.1 400"));

    let handoff = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        &replacement_request(expected),
    );
    assert!(handoff.starts_with("HTTP/1.1 200"));
    let handoff = response_json(&handoff);
    assert_eq!(handoff["status"], "busy");
    assert_eq!(handoff["retry_after_ms"], 250);
    assert_eq!(handoff["runtime"]["start_nonce"], expected.start_nonce);

    let mut forged_descriptor = expected.clone();
    forged_descriptor.start_nonce = "f".repeat(32);
    let forged_handoff = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        &replacement_request(&forged_descriptor),
    );
    assert!(forged_handoff.starts_with("HTTP/1.1 200"));
    assert_eq!(response_json(&forged_handoff)["status"], "incompatible");

    let mut downgraded_manifest = expected.manifest.clone();
    downgraded_manifest
        .modules
        .iter_mut()
        .find(|entry| entry.module == nodex_core_contracts::ModuleName::ProjectWorkspace)
        .expect("Workspace contract")
        .versions = nodex_core_protocol::VersionRange::exact(1);
    let downgrade_handoff = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        &replacement_request_for(expected, downgraded_manifest),
    );
    assert!(downgrade_handoff.starts_with("HTTP/1.1 200"));
    assert_eq!(response_json(&downgrade_handoff)["status"], "incompatible");
    let legacy_handoff = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        r#"{"version_handoff":null}"#,
    );
    assert!(legacy_handoff.starts_with("HTTP/1.1 422"));

    let unbound_shutdown = request(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        r#"{"kind":"shutdown"}"#,
    );
    assert!(unbound_shutdown.starts_with("HTTP/1.1 401"));

    let mut event_stream = open_sse(
        &expected.socket_path,
        &auth,
        "/core/v1/events?after=0",
        &connection_headers,
    );
    let health = wait_for_event_replay_metrics(&expected.socket_path, &auth);
    assert_eq!(health["status"], "ready");
    assert_eq!(health["metrics"]["active_event_subscriptions"], 1);
    assert!(health["metrics"]["active_clients"].as_u64().unwrap() >= 1);
    assert!(
        health["metrics"]["command_latency"]["count"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(
        health["metrics"]["transaction_duration"]["count"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(health["metrics"]["commit_head"].as_i64().unwrap() > 0);
    assert!(health["metrics"]["event_replay_lag_max"].as_u64().unwrap() > 0);
    assert!(health["metrics"]["wal_size_bytes"].as_u64().unwrap() > 0);
    assert!(
        health["metrics"]["document_cache_hit_rate_ppm"]
            .as_u64()
            .unwrap()
            <= 1_000_000
    );
    assert_eq!(health["metrics"]["dropped_log_records"], 0);

    let shutdown = request_with_headers(
        &expected.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        r#"{"kind":"shutdown"}"#,
        &connection_headers,
    );
    assert!(shutdown.starts_with("HTTP/1.1 200"));
    let mut remaining_events = Vec::new();
    event_stream
        .read_to_end(&mut remaining_events)
        .expect("graceful drain closes the SSE stream");

    let deadline = Instant::now() + Duration::from_secs(5);
    for child in &mut children {
        loop {
            if child.try_wait().expect("poll Core process").is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "Core process did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert!(!runtime.join("core.sock").exists());
    assert!(!runtime.join("core.json").exists());
    assert!(!runtime.join("core.auth").exists());
    let lifecycle = lifecycle_summary(&home);
    assert_eq!(lifecycle["current"]["phase"], "stopped");
    assert_eq!(lifecycle["current"]["drain_reason"], "explicit_shutdown");
    assert_eq!(lifecycle["current"]["stop_outcome"], "success");

    let log_directory = home.join("logs");
    assert_eq!(
        fs::metadata(&log_directory)
            .expect("Core log directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let mut log_entries = Vec::new();
    let mut raw_logs = String::new();
    for entry in fs::read_dir(&log_directory).expect("Core log directory entries") {
        let entry = entry.expect("Core log entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("core-") || !name.ends_with(".log") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).expect("Core log metadata");
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let contents = fs::read_to_string(entry.path()).expect("Core log contents");
        raw_logs.push_str(&contents);
        for line in contents.lines().filter(|line| !line.is_empty()) {
            log_entries
                .push(serde_json::from_str::<serde_json::Value>(line).expect("Core JSONL record"));
        }
    }
    assert!(!log_entries.is_empty(), "Core emitted no JSONL records");
    let logged_operation_id = log_identity(LOG_OPERATION_ID);
    let correlated = log_entries
        .iter()
        .filter(|entry| entry["operationId"] == logged_operation_id)
        .collect::<Vec<_>>();
    assert!(
        !correlated.is_empty(),
        "operation has no correlated records"
    );
    let request_ids = correlated
        .iter()
        .filter_map(|entry| entry["requestId"].as_str())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        request_ids.len(),
        1,
        "one operation must have one request chain"
    );
    assert!(correlated.iter().any(|entry| {
        entry["writerCommandId"]
            .as_str()
            .is_some_and(|value| value.starts_with("writer:"))
    }));
    assert!(
        correlated
            .iter()
            .any(|entry| { entry["receiptKey"] == format!("library:{logged_operation_id}") })
    );
    assert!(
        correlated
            .iter()
            .any(|entry| { entry["commitSequence"].as_i64() == Some(logged_commit_sequence) })
    );
    assert!(correlated.iter().all(|entry| entry["module"] == "library"));
    assert!(correlated.iter().all(|entry| entry["adapter"] == "test"));
    assert!(
        correlated
            .iter()
            .all(|entry| entry.get("eventSequence").is_none())
    );
    for forbidden in [
        auth.as_str(),
        PRIVATE_LOG_SENTINEL,
        PRIVATE_PATH_SENTINEL,
        LOG_OPERATION_ID,
        "connection:lifecycle",
        "page:logging-correlation",
        home.to_str().expect("UTF-8 home"),
        expected.socket_path.as_str(),
    ] {
        assert!(
            !raw_logs.contains(forbidden),
            "Core logs leaked {forbidden}"
        );
    }
}

#[test]
fn core_idle_exits_after_startup_clients_are_gone() {
    let directory = tempdir().expect("disposable Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = env!("CARGO_BIN_EXE_nodex-core");
    let spawn = || {
        Command::new(executable)
            .args(["--home", home.to_str().expect("UTF-8 home")])
            .env("NODEX_CORE_IDLE_TIMEOUT_MS", "5000")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn Core")
    };
    let mut core = spawn();
    let descriptor = read_ready_descriptor(&mut core);
    let mut contender = spawn();
    let reused = read_ready_descriptor(&mut contender);
    assert_eq!(reused.pid, descriptor.pid);
    assert_eq!(reused.start_nonce, descriptor.start_nonce);
    assert!(contender.wait().expect("wait for startup client").success());

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = core.try_wait().expect("poll idle Core") {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "idle Core did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
    let runtime = home.join("run/core");
    assert!(!runtime.join("core.sock").exists());
    assert!(!runtime.join("core.json").exists());
    assert!(!runtime.join("core.auth").exists());
    let lifecycle = lifecycle_summary(&home);
    assert_eq!(lifecycle["current"]["phase"], "stopped");
    assert_eq!(lifecycle["current"]["drain_reason"], "idle_timeout");
    assert_eq!(lifecycle["current"]["stop_outcome"], "success");
}

#[test]
fn live_electron_host_and_event_stream_prevent_idle_exit() {
    let directory = tempdir().expect("disposable Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = env!("CARGO_BIN_EXE_nodex-core");
    let mut core = Command::new(executable)
        .args(["--home", home.to_str().expect("UTF-8 home")])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "250")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Core");
    let descriptor = read_ready_descriptor(&mut core);
    let auth = fs::read_to_string(home.join("run/core/core.auth"))
        .expect("auth capability")
        .trim()
        .to_owned();
    let connection_id = "connection:active-electron-host";
    let binding = bind_test_client(&descriptor, &auth, connection_id);
    let headers = [
        ("x-nodex-connection-id", connection_id),
        ("x-nodex-connection-binding", binding.as_str()),
    ];
    let mut event_stream = open_sse(
        &descriptor.socket_path,
        &auth,
        "/core/v1/events?after=0",
        &headers,
    );

    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(core.try_wait().expect("poll active Core"), None);
    let health = response_json(&request(
        &descriptor.socket_path,
        &auth,
        "GET",
        "/core/v1/health",
        "",
    ));
    assert_eq!(health["status"], "ready");
    assert!(health["metrics"]["active_clients"].as_u64().unwrap() >= 1);
    assert_eq!(health["metrics"]["active_event_subscriptions"], 1);

    let shutdown = request_with_headers(
        &descriptor.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        r#"{"kind":"shutdown"}"#,
        &headers,
    );
    assert!(shutdown.starts_with("HTTP/1.1 200"), "{shutdown:?}");
    let mut tail = Vec::new();
    event_stream
        .read_to_end(&mut tail)
        .expect("drain closes stream");
    assert!(core.wait().expect("wait for Core").success());
}

#[test]
fn incompatible_idle_core_drains_before_a_replacement_starts() {
    let directory = tempdir().expect("disposable Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = env!("CARGO_BIN_EXE_nodex-core");
    let spawn = || {
        Command::new(executable)
            .args(["--home", home.to_str().expect("UTF-8 home")])
            .env("NODEX_CORE_IDLE_TIMEOUT_MS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn Core")
    };
    let mut incumbent = spawn();
    let incumbent_descriptor = read_ready_descriptor(&mut incumbent);
    let runtime = home.join("run/core");
    let auth = fs::read_to_string(runtime.join("core.auth"))
        .expect("incumbent auth")
        .trim()
        .to_owned();
    let handoff = request(
        &incumbent_descriptor.socket_path,
        &auth,
        "POST",
        "/core/v1/admin/shutdown",
        &replacement_request(&incumbent_descriptor),
    );
    assert!(handoff.starts_with("HTTP/1.1 200"));
    assert_eq!(response_json(&handoff)["status"], "draining");
    let mut replacements = [spawn(), spawn()];
    let replacement_descriptors = replacements
        .iter_mut()
        .map(read_ready_descriptor)
        .collect::<Vec<_>>();
    let replacement_descriptor = replacement_descriptors
        .first()
        .expect("replacement descriptor");
    assert!(replacement_descriptors.iter().all(|descriptor| {
        descriptor.pid == replacement_descriptor.pid
            && descriptor.start_nonce == replacement_descriptor.start_nonce
    }));
    assert!(
        incumbent
            .wait()
            .expect("wait for incumbent drain")
            .success()
    );
    assert_ne!(
        replacement_descriptor.start_nonce,
        incumbent_descriptor.start_nonce
    );
    assert_eq!(
        replacement_descriptor.profile_id,
        incumbent_descriptor.profile_id
    );
    assert_eq!(
        replacement_descriptor.store_epoch,
        incumbent_descriptor.store_epoch
    );
    for contender in replacements
        .iter_mut()
        .filter(|contender| contender.id() != replacement_descriptor.pid)
    {
        assert!(
            contender
                .wait()
                .expect("wait for replacement contender")
                .success()
        );
    }
    let replacement_auth = fs::read_to_string(runtime.join("core.auth"))
        .expect("replacement auth")
        .trim()
        .to_owned();
    let replacement_handoff = request(
        &replacement_descriptor.socket_path,
        &replacement_auth,
        "POST",
        "/core/v1/admin/shutdown",
        &replacement_request(replacement_descriptor),
    );
    assert_eq!(response_json(&replacement_handoff)["status"], "draining");
    let replacement = replacements
        .iter_mut()
        .find(|replacement| replacement.id() == replacement_descriptor.pid)
        .expect("replacement Core process");
    assert!(replacement.wait().expect("wait for replacement").success());
}

#[test]
fn workspace_contract_mismatch_is_replaced_before_a_projectless_session_request() {
    let directory = tempdir().expect("disposable stale-runtime Profile");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = env!("CARGO_BIN_EXE_nodex-core");

    let mut seed = Command::new(executable)
        .args(["--home", home.to_str().expect("UTF-8 home")])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "100")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("seed current Store identity");
    let seeded_descriptor = read_ready_descriptor(&mut seed);
    assert!(seed.wait().expect("wait for seed Core idle exit").success());

    let runtime = home.join("run/core");
    let socket = runtime.join("core.sock");
    let descriptor_path = runtime.join("core.json");
    let auth_path = runtime.join("core.auth");
    let lock_path = runtime.join("core.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .expect("open fixture Profile lock");
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
        .expect("private fixture lock");
    lock.lock_exclusive().expect("hold fixture Profile lock");
    let listener = UnixListener::bind(&socket).expect("bind stale Core fixture");
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
        .expect("private fixture socket");

    let mut stale_manifest = core_compatibility_manifest();
    let workspace = stale_manifest
        .modules
        .get_mut(3)
        .expect("canonical Project Workspace manifest entry");
    assert_eq!(
        serde_json::to_value(workspace.module).expect("Module name JSON"),
        serde_json::json!("project_workspace")
    );
    workspace.versions = VersionRange::exact(1);
    let stale_manifest_digest =
        canonical_manifest_digest(&stale_manifest).expect("stale manifest digest");
    let stale_descriptor = RuntimeDescriptor {
        manifest: stale_manifest,
        manifest_digest: stale_manifest_digest,
        artifact: seeded_descriptor.artifact.clone(),
        actual_store_format: seeded_descriptor.actual_store_format.clone(),
        pid: std::process::id(),
        start_nonce: "c".repeat(32),
        socket_path: socket.to_string_lossy().into_owned(),
        profile_id: seeded_descriptor.profile_id.clone(),
        store_epoch: seeded_descriptor.store_epoch.clone(),
        readiness_generation: 1,
    };
    let fixture_auth = "d".repeat(64);
    fs::write(&auth_path, format!("{fixture_auth}\n")).expect("fixture auth");
    fs::set_permissions(&auth_path, fs::Permissions::from_mode(0o600))
        .expect("private fixture auth");
    fs::write(
        &descriptor_path,
        format!(
            "{}\n",
            serde_json::to_string(&stale_descriptor).expect("fixture descriptor JSON")
        ),
    )
    .expect("fixture descriptor");
    fs::set_permissions(&descriptor_path, fs::Permissions::from_mode(0o600))
        .expect("private fixture descriptor");

    let expected_stale_generation = RuntimeGenerationIdentity::from(&stale_descriptor);
    let fixture_generation = expected_stale_generation.clone();
    let fixture = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept replacement request");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("bound fixture read");
        let mut reader = BufReader::new(stream.try_clone().expect("clone fixture stream"));
        let mut request_head = String::new();
        let mut content_length = None;
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("read replacement header");
            assert!(
                !line.is_empty(),
                "replacement request ended before its body"
            );
            if let Some(value) = line
                .strip_prefix("Content-Length: ")
                .and_then(|value| value.trim().parse::<usize>().ok())
            {
                content_length = Some(value);
            }
            request_head.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let mut request_body = vec![0_u8; content_length.expect("replacement content length")];
        reader
            .read_exact(&mut request_body)
            .expect("read replacement body");
        let response_body = serde_json::to_vec(&ShutdownResponse {
            status: ShutdownStatus::Draining,
            runtime: Some(fixture_generation),
            retry_after_ms: None,
        })
        .expect("fixture response JSON");
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response_body.len()
        )
        .expect("write replacement response head");
        stream
            .write_all(&response_body)
            .expect("write replacement response body");
        drop(lock);
        (
            request_head,
            serde_json::from_slice::<ShutdownRequest>(&request_body)
                .expect("strict replacement request"),
        )
    });

    let mut current = Command::new(executable)
        .args([
            "--home",
            home.to_str().expect("UTF-8 home"),
            "--selection-policy",
            "prefer-current-artifact",
            "--launcher",
            "electron-host",
        ])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn current Electron Core selector");
    let selection = read_selection_result(&mut current);
    assert_eq!(selection.disposition, CoreSelectionDisposition::Started);
    assert_eq!(selection.reason, CoreSelectionReason::ReplacedContract);
    assert_eq!(
        selection.descriptor.store_epoch,
        seeded_descriptor.store_epoch
    );
    let (fixture_head, replacement) = fixture.join().expect("join stale Core fixture");
    assert!(fixture_head.starts_with("POST /core/v1/admin/shutdown HTTP/1.1"));
    assert!(fixture_head.contains(&format!("Authorization: Bearer {fixture_auth}")));
    let ShutdownRequest::Replacement(replacement) = replacement else {
        panic!("Workspace mismatch must request a typed replacement");
    };
    assert_eq!(replacement.expected, expected_stale_generation);
    assert_eq!(
        replacement.candidate_manifest.modules[3].versions,
        VersionRange::exact(PROJECT_WORKSPACE_CONTRACT_VERSION)
    );

    let selected = selection.descriptor;
    let selected_auth = fs::read_to_string(runtime.join("core.auth"))
        .expect("selected Core auth")
        .trim()
        .to_owned();
    let handshake = serde_json::to_string(&HandshakeRequest {
        requirements: core_client_requirements(),
        client: ClientIdentity {
            kind: ClientKind::ElectronHost,
            build_id: "stale-runtime-regression".to_owned(),
        },
        connection_id: "connection:stale-runtime-regression".to_owned(),
        expected_generation: RuntimeGenerationIdentity::from(&selected),
    })
    .expect("handshake JSON");
    let handshake = response_json(&request(
        &selected.socket_path,
        &selected_auth,
        "POST",
        "/core/v1/handshake",
        &handshake,
    ));
    let binding = handshake["connection_binding"]
        .as_str()
        .expect("connection binding")
        .to_owned();
    let connection_headers = [
        (
            "x-nodex-connection-id",
            "connection:stale-runtime-regression",
        ),
        ("x-nodex-connection-binding", binding.as_str()),
    ];
    let create_initial_project = serde_json::json!({
        "contract_version": PROJECT_WORKSPACE_CONTRACT_VERSION,
        "operation_id": "workspace-contract-regression-initial-project",
        "store_epoch": selected.store_epoch,
        "intent": {
            "kind": "create_initial_project",
            "project_id": "project:default",
            "name": "Default",
            "description": "",
            "appearance": null,
            "source_roots": ["/workspace/default"],
            "starter_page": {
                "page_id": "page:getting-started",
                "document_id": "document:getting-started",
                "title_markdown": "Welcome to Nodex",
                "nfm": "Welcome to Nodex."
            }
        }
    })
    .to_string();
    let initial_project = request_with_headers(
        &selected.socket_path,
        &selected_auth,
        "POST",
        "/core/v1/modules/workspace/apply",
        &create_initial_project,
        &connection_headers,
    );
    assert_eq!(response_json(&initial_project)["status"], "ok");

    let apply = serde_json::json!({
        "contract_version": PROJECT_WORKSPACE_CONTRACT_VERSION,
        "operation_id": "workspace-create-projectless-session",
        "store_epoch": selected.store_epoch,
        "intent": {
            "kind": "create_session",
            "session_id": "session:projectless-regression",
            "project_id": null,
            "title": "Projectless",
            "initial_page_ids": []
        }
    })
    .to_string();
    let raw_response = request_with_headers(
        &selected.socket_path,
        &selected_auth,
        "POST",
        "/core/v1/modules/workspace/apply",
        &apply,
        &connection_headers,
    );
    assert!(
        raw_response.starts_with("HTTP/1.1 200"),
        "unexpected Workspace apply response: {raw_response:?}"
    );
    let response = response_json(&raw_response);
    assert_eq!(response["status"], "ok", "{response}");

    let session = response_json(&request_with_headers(
        &selected.socket_path,
        &selected_auth,
        "POST",
        "/core/v1/modules/workspace/read",
        &serde_json::json!({
            "contract_version": PROJECT_WORKSPACE_CONTRACT_VERSION,
            "read": {
                "kind": "session",
                "session_id": "session:projectless-regression"
            }
        })
        .to_string(),
        &connection_headers,
    ));
    assert_eq!(session["status"], "ok", "{session}");
    assert_eq!(
        session["payload"]["value"]["session"]["project_id"],
        serde_json::Value::Null
    );
    assert!(
        session["payload"]["value"]["session"]
            .get("database_starter")
            .is_none()
    );

    let shutdown = response_json(&request_with_headers(
        &selected.socket_path,
        &selected_auth,
        "POST",
        "/core/v1/admin/shutdown",
        r#"{"kind":"shutdown"}"#,
        &connection_headers,
    ));
    assert_eq!(shutdown["status"], "draining");
    assert!(current.wait().expect("wait for selected Core").success());
}

#[test]
fn compatibility_policy_reuses_while_electron_artifact_policy_replaces_without_a_second_writer() {
    let directory = tempdir().expect("disposable update installation");
    let home = directory.path().join("profile");
    fs::create_dir(&home).expect("Profile home");
    let old_bundle = directory.path().join("Old Nodex.app");
    let old_bin = old_bundle.join("Contents/Resources/bin");
    fs::create_dir_all(&old_bin).expect("old app runtime directory");
    let old_executable = old_bin.join("nodex-core");
    fs::copy(env!("CARGO_BIN_EXE_nodex-core"), &old_executable).expect("copy old packaged Core");
    fs::set_permissions(&old_executable, fs::Permissions::from_mode(0o755))
        .expect("old packaged Core is executable");

    let mut incumbent = Command::new(&old_executable)
        .args(["--home", home.to_str().expect("UTF-8 home")])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start Core from old app bundle");
    let incumbent_descriptor = read_ready_descriptor(&mut incumbent);

    fs::remove_dir_all(&old_bundle).expect("delete old app bundle after update");
    assert!(!old_executable.exists());

    let mut compatible_new_app = Command::new(env!("CARGO_BIN_EXE_nodex-core"))
        .args(["--home", home.to_str().expect("UTF-8 home")])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start compatible Core from new app bundle");
    let reused = read_ready_descriptor(&mut compatible_new_app);
    assert_eq!(reused.pid, incumbent_descriptor.pid);
    assert_eq!(reused.start_nonce, incumbent_descriptor.start_nonce);
    assert!(
        compatible_new_app
            .wait()
            .expect("wait for compatible new app launcher")
            .success()
    );

    let new_bundle = directory.path().join("New Nodex.app");
    let new_bin = new_bundle.join("Contents/Resources/bin");
    fs::create_dir_all(&new_bin).expect("new app runtime directory");
    let new_executable = new_bin.join("nodex-core");
    fs::copy(env!("CARGO_BIN_EXE_nodex-core"), &new_executable).expect("copy new packaged Core");
    fs::OpenOptions::new()
        .append(true)
        .open(&new_executable)
        .expect("open new packaged Core")
        .write_all(b"\nNodex distinct artifact fixture\n")
        .expect("different artifact digest");
    fs::set_permissions(&new_executable, fs::Permissions::from_mode(0o755))
        .expect("new packaged Core is executable");
    let mut current_app = Command::new(&new_executable)
        .args([
            "--home",
            home.to_str().expect("UTF-8 home"),
            "--selection-policy",
            "prefer-current-artifact",
            "--launcher",
            "electron-host",
        ])
        .env("NODEX_CORE_IDLE_TIMEOUT_MS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start current Electron Core selector");
    let selected = read_selection_result(&mut current_app);
    assert_eq!(selected.disposition, CoreSelectionDisposition::Started);
    assert_eq!(selected.reason, CoreSelectionReason::ReplacedArtifact);
    let current_descriptor = selected.descriptor;
    assert_ne!(current_descriptor.pid, incumbent_descriptor.pid);
    assert_ne!(current_descriptor.artifact, incumbent_descriptor.artifact);
    assert_eq!(
        current_descriptor.store_epoch,
        incumbent_descriptor.store_epoch
    );
    assert!(incumbent.wait().expect("wait for old Core drain").success());

    let runtime = home.join("run/core");
    let auth = fs::read_to_string(runtime.join("core.auth"))
        .expect("current Core auth")
        .trim()
        .to_owned();
    // Readiness admits clients before background work necessarily becomes idle.
    // Honor replacement backpressure instead of assuming immediate handoff.
    let deadline = Instant::now() + Duration::from_secs(5);
    let handoff = loop {
        let response = request(
            &current_descriptor.socket_path,
            &auth,
            "POST",
            "/core/v1/admin/shutdown",
            &replacement_request(&current_descriptor),
        );
        assert!(response.starts_with("HTTP/1.1 200"));
        let handoff = response_json(&response);
        if handoff["status"] != "busy" {
            break handoff;
        }
        assert!(
            Instant::now() < deadline,
            "Core never became idle: {handoff}"
        );
        let retry_after_ms = handoff["retry_after_ms"]
            .as_u64()
            .expect("busy retry delay");
        std::thread::sleep(Duration::from_millis(retry_after_ms));
    };
    assert_eq!(handoff["status"], "draining");
    assert!(
        current_app
            .wait()
            .expect("wait for current Core drain")
            .success()
    );
    assert!(!runtime.join("core.sock").exists());
    assert!(!runtime.join("core.json").exists());
    assert!(!runtime.join("core.auth").exists());
}
