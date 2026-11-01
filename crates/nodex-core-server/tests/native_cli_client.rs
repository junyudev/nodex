use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use nodex_core::infrastructure::schema::CURRENT_STORE_REVISION;
use nodex_core_contracts::administration::{StoreAdministrationRead, StoreAdministrationReadValue};
use nodex_core_contracts::events::DeliveryAddress;
use nodex_core_contracts::library::{
    LibraryIntent, LibraryPageFileEntryChange, LibraryPagePrepareKind,
    LibraryPageProjectionFileKind, LibraryRead, LibraryReadValue, LibraryWriteParent,
};
use nodex_core_contracts::workspace::{ProjectWorkspaceIntent, ProjectWorkspaceStarterPage};
use nodex_core_contracts::{
    ApplyResponse, ModuleApplyRequest, StoreEpoch, VersionedModuleContract,
};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use nodex_platform::test_support::tempdir;

struct ProcessGuard(u32);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _ = nodex_platform::process::terminate_process(self.0);
    }
}

#[test]
fn native_client_cold_starts_reuses_and_reads_the_authenticated_core() {
    let directory = tempdir().expect("Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = Path::new(env!("CARGO_BIN_EXE_nodex-core"));

    let client = connect_or_launch(&home, "native-client-test", Some(executable))
        .expect("cold native client launch");
    let expected_schema_version =
        u32::try_from(CURRENT_STORE_REVISION).expect("Core schema version fits the wire contract");
    let pid = client.handshake.generation.pid;
    let guard = ProcessGuard(pid);
    assert_eq!(client.descriptor.pid, client.handshake.generation.pid);
    assert_eq!(client.handshake.schema_version, expected_schema_version);

    let second = CoreClient::connect(&home, "native-client-test").expect("reuse running Core");
    assert_eq!(
        second.handshake.generation.pid,
        client.handshake.generation.pid
    );
    assert_eq!(
        second.handshake.generation.start_nonce,
        client.handshake.generation.start_nonce
    );

    let health = client.health().expect("health");
    assert_eq!(health.pid, client.handshake.generation.pid);
    let response = client
        .administration_read(StoreAdministrationRead::Status)
        .expect("administration status");
    let ResponseEnvelope::Ok(snapshot) = response.0 else {
        panic!("expected administration status")
    };
    let StoreAdministrationReadValue::Status { schema_version, .. } = snapshot.value else {
        panic!("expected Store status value")
    };
    assert_eq!(schema_version, expected_schema_version);

    let source = home.join("source");
    nodex_platform::private_fs::create_dir(&source).expect("Project source");
    let project_id = "019b1000-1000-7000-8000-000000000001";
    let page_id = "019b1000-1000-7000-8000-000000000002";
    let document_id = "019b1000-1000-7000-8000-000000000003";
    let store_epoch = StoreEpoch(client.handshake.store_epoch.clone());
    let created_project = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: <nodex_core_contracts::workspace::ProjectWorkspaceContract as VersionedModuleContract>::VERSION,
                operation_id: "native-client:create-project".to_owned(),
                store_epoch: store_epoch.clone(),
                intent: ProjectWorkspaceIntent::CreateInitialProject {
                    project_id: project_id.to_owned(),
                    name: "Native CLI".to_owned(),
                    description: String::new(),
                    appearance: None,
                    source_roots: vec![source.to_string_lossy().into_owned()],
                    page_key_prefix: None,
                    starter_page: ProjectWorkspaceStarterPage {
                        page_id: "019b1000-1000-7000-8000-000000000004".to_owned(),
                        document_id: "019b1000-1000-7000-8000-000000000005".to_owned(),
                        title_markdown: "Welcome to Nodex".to_owned(),
                        markdown: "Welcome to Nodex.".to_owned(),
                    },
                },
            },
        )
        .expect("create Project through native client");
    assert!(matches!(created_project.0, ResponseEnvelope::Ok(_)));
    let created_page = client
        .library_apply(
            Some(project_id),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                operation_id: "native-client:create-page".to_owned(),
                store_epoch: store_epoch.clone(),
                intent: LibraryIntent::CreatePage {
                    page_id: page_id.to_owned(),
                    document_id: document_id.to_owned(),
                    title: "Native **read**".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .expect("create Page through native client");
    let ResponseEnvelope::Ok(ApplyResponse::Committed {
        delivery: Some(delivery),
        ..
    }) = created_page.0
    else {
        panic!("expected committed Page creation with fast-path delivery")
    };
    assert!(matches!(
        delivery.delivery_address,
        DeliveryAddress::Project {
            ref library_id,
            project_id: ref delivery_project_id,
        } if library_id == &client.handshake.library_id && delivery_project_id == project_id
    ));
    verify_native_recovery_bundle(&client, document_id);
    let page_projection_file = client
        .library_read(
            Some(project_id),
            LibraryRead::PageProjectionFile {
                page_id: page_id.to_owned(),
                file_kind: LibraryPageProjectionFileKind::MetaYaml,
                prepare: Some(LibraryPagePrepareKind::TitleSet),
            },
        )
        .expect("read Page file through native client");
    let ResponseEnvelope::Ok(snapshot) = page_projection_file.0 else {
        panic!("expected Page file snapshot")
    };
    let LibraryReadValue::PageProjectionFile { value } = snapshot.value else {
        panic!("expected Page file value")
    };
    let encoded_title = value
        .content
        .lines()
        .find_map(|line| line.strip_prefix("title: "))
        .expect("Page title field");
    let title_markdown: String = serde_json::from_str(encoded_title).unwrap();
    let title = nodex_core::domain::markdown::parse_markdown(&title_markdown).unwrap();
    let title_blocks =
        nodex_core::domain::markdown::materialize_markdown_blocks_with_ids(&title, &mut || {
            "title".to_owned()
        })
        .unwrap();
    assert_eq!(
        title_blocks[0].content,
        Some(serde_json::json!([
            { "type": "text", "text": "Native **read**", "styles": {} }
        ]))
    );
    assert!(value.validators.title_etag.is_some());
    let body_projection = client
        .library_read(
            Some(project_id),
            LibraryRead::PageProjectionFile {
                page_id: page_id.to_owned(),
                file_kind: LibraryPageProjectionFileKind::BodyMarkdown,
                prepare: None,
            },
        )
        .expect("read Page body validators through native client");
    let ResponseEnvelope::Ok(body_snapshot) = body_projection.0 else {
        panic!("expected Page body snapshot")
    };
    let LibraryReadValue::PageProjectionFile { value: body } = body_snapshot.value else {
        panic!("expected Page body file value")
    };
    assert!(value.validators.body_etag.is_some());
    assert_eq!(value.validators.body_etag, body.validators.body_etag);

    let file_bytes = b"native client Library File";
    let file_operation_id = "native-client-page-file";
    let prepared = client
        .prepare_file_blob(
            Some(project_id),
            file_operation_id,
            &client.handshake.store_epoch,
            Some("references/native.txt"),
            &mut Cursor::new(file_bytes),
            file_bytes.len() as u64,
        )
        .expect("stream File through native client");
    let file_request = ModuleApplyRequest {
        contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
        operation_id: file_operation_id.to_owned(),
        store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
        intent: LibraryIntent::ApplyPageFileEntries {
            page_id: page_id.to_owned(),
            expected_manifest_revision: 0,
            changes: vec![LibraryPageFileEntryChange::Import {
                file_id: "native-client-file".to_owned(),
                logical_path: "references/native.txt".to_owned(),
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: prepared.receipt_id.clone(),
                collision_policy:
                    nodex_core_contracts::library::LibraryPageFileCollisionPolicy::Reject,
            }],
            turn_id: None,
        },
    };
    let applied = client
        .library_apply(Some(project_id), file_request.clone())
        .expect("commit File relation through native client");
    assert!(matches!(applied.0, ResponseEnvelope::Ok(_)));
    let prepared_replay = client
        .prepare_file_blob(
            Some(project_id),
            file_operation_id,
            &client.handshake.store_epoch,
            Some("references/native.txt"),
            &mut Cursor::new(file_bytes),
            file_bytes.len() as u64,
        )
        .expect("replay prepared File through native client");
    assert_eq!(prepared_replay.receipt_id, prepared.receipt_id);
    let replayed = client
        .library_apply(Some(project_id), file_request)
        .expect("replay File relation commit through native client");
    let ResponseEnvelope::Ok(replayed) = replayed.0 else {
        panic!("expected replayed File relation commit")
    };
    assert!(replayed.receipt().mutation.duplicate);
    let read_back = client
        .read_file_blob(
            Some(project_id),
            "native-client-file",
            &nodex_core_contracts::library::LibraryFileReadSource::Page {
                page_id: page_id.to_owned(),
            },
            None,
        )
        .expect("read File through native client");
    assert_eq!(read_back.bytes, file_bytes);
    assert_eq!(read_back.mime_type, "text/plain");
    assert_library_file_streams(&client, project_id, page_id);
    assert_thread_asset_streams(&client, project_id);

    drop(second);
    client.shutdown().expect("authenticated cleanup");
    drop(client);
    wait_for_runtime_cleanup(&home);
    drop(guard);
}

fn assert_library_file_streams(client: &CoreClient, project_id: &str, unrelated_page_id: &str) {
    use nodex_core_contracts::library::{LibraryFileChange, LibraryFileReadSource};
    let file_id = "native-library-file";
    for (index, bytes) in [
        b"first File bytes".as_slice(),
        b"updated File bytes".as_slice(),
    ]
    .into_iter()
    .enumerate()
    {
        let operation_id = format!("native-library-file:{index}");
        let prepared = client
            .prepare_file_blob(
                Some(project_id),
                &operation_id,
                &client.handshake.store_epoch,
                None,
                &mut Cursor::new(bytes),
                bytes.len() as u64,
            )
            .unwrap();
        let change = if index == 0 {
            LibraryFileChange::Create {
                file_id: file_id.to_owned(),
                default_name: "native.txt".to_owned(),
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: prepared.receipt_id,
            }
        } else {
            LibraryFileChange::ReplaceContent {
                file_id: file_id.to_owned(),
                expected_revision: 1,
                expected_head_version: 1,
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: prepared.receipt_id,
            }
        };
        let result = client
            .library_apply(
                Some(project_id),
                ModuleApplyRequest {
                    contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                    operation_id,
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: LibraryIntent::ApplyFileChange {
                        change,
                        turn_id: None,
                    },
                },
            )
            .unwrap();
        assert!(matches!(result.0, ResponseEnvelope::Ok(_)), "{result:?}");
        let current = client
            .read_file_blob(
                Some(project_id),
                file_id,
                &LibraryFileReadSource::Direct,
                None,
            )
            .unwrap();
        assert_eq!(current.bytes, bytes);
        assert_eq!(current.mime_type, "text/plain");
    }
    let first = client
        .read_file_blob(
            Some(project_id),
            file_id,
            &LibraryFileReadSource::Direct,
            Some(1),
        )
        .unwrap();
    assert_eq!(first.bytes, b"first File bytes");
    assert!(
        client
            .read_file_blob(
                Some(project_id),
                file_id,
                &LibraryFileReadSource::Page {
                    page_id: unrelated_page_id.to_owned()
                },
                None
            )
            .is_err()
    );
}

fn assert_thread_asset_streams(client: &CoreClient, project_id: &str) {
    use nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch;
    let thread_id = "native-client-attachment-thread";
    let apply = |operation_id: &str, intent| {
        let response = client.workspace_apply(Some(project_id), ModuleApplyRequest {
            contract_version: <nodex_core_contracts::workspace::ProjectWorkspaceContract as VersionedModuleContract>::VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
            intent,
        }).unwrap();
        assert!(
            matches!(response.0, ResponseEnvelope::Ok(_)),
            "{response:?}"
        );
    };
    apply(
        "native-thread-assets:create",
        ProjectWorkspaceIntent::UpsertThread {
            thread_id: thread_id.to_owned(),
            patch: Box::new(ProjectWorkspaceThreadPatch {
                project_id: Some(Some(project_id.to_owned())),
                thread_name: Some(Some("Attachment stream".to_owned())),
                created_at: Some(1),
                updated_at: Some(1),
                ..ProjectWorkspaceThreadPatch::default()
            }),
        },
    );
    let bytes = b"immutable conversation input";
    let prepared = client
        .prepare_blob(
            Some(project_id),
            "native-thread-assets:retain",
            &client.handshake.store_epoch,
            None,
            &mut Cursor::new(bytes),
            bytes.len() as u64,
        )
        .unwrap();
    assert!(
        client
            .read_thread_asset_blob(Some(project_id), thread_id, &prepared.blob_etag)
            .is_err()
    );
    apply(
        "native-thread-assets:retain",
        ProjectWorkspaceIntent::RetainThreadAssets {
            thread_id: thread_id.to_owned(),
            prepared_blob_receipt_ids: vec![prepared.receipt_id],
        },
    );
    let read = client
        .read_thread_asset_blob(Some(project_id), thread_id, &prepared.blob_etag)
        .unwrap();
    assert_eq!(read.bytes, bytes);
    assert_eq!(read.mime_type, "application/octet-stream");
    apply(
        "native-thread-assets:delete",
        ProjectWorkspaceIntent::DeleteThread {
            thread_id: thread_id.to_owned(),
        },
    );
    assert!(
        client
            .read_thread_asset_blob(Some(project_id), thread_id, &prepared.blob_etag)
            .is_err()
    );
}

fn wait_for_runtime_cleanup(home: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if !home.join("run/core/core.json").exists() {
            return;
        }
        assert!(Instant::now() < deadline, "Core runtime did not clean up");
        thread::sleep(Duration::from_millis(20));
    }
}

fn verify_native_recovery_bundle(client: &CoreClient, document_id: &str) {
    use nodex_core_contracts::document::*;
    let bytes: Vec<u8> = (0..70_020).map(|index| index as u8).collect();
    let capture = RecoveryDraftCapture {
        draft_id: "draft:native-bytes".into(),
        document_id: document_id.into(),
        source_store_epoch: client.handshake.store_epoch.clone(),
        generation: 1,
        base_head_seq: 0,
        created_at: "2026-09-12T00:00:00Z".into(),
        schema_key: "nodex.page".into(),
        schema_version: 1,
        content: RecoveryDraftContent::Yjs {
            state: bytes.clone(),
            unintegrated_updates: vec![],
        },
        source: serde_json::json!({ "state": bytes, "originalUpdateId": "native:original" }),
    };
    let frozen = recovery_bundle::encode(&capture, &capture.draft_id).unwrap();
    let command = ModuleApplyRequest {
        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
        operation_id: "capture:native-bytes".into(),
        store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
        intent: OwnedDocumentIntent::CaptureRecovery {
            capture: Box::new(capture),
        },
    };
    let result = client.document_apply(None, command.clone()).unwrap();
    let ResponseEnvelope::Ok(result) = result.0 else {
        panic!("native capture failed")
    };
    assert_eq!(
        result
            .outcome()
            .recovery_capture
            .as_ref()
            .unwrap()
            .stored_payload_hash,
        recovery_bundle::payload_hash(&frozen)
    );
    assert!(matches!(
        client.document_apply(None, command).unwrap().0,
        ResponseEnvelope::Ok(_)
    ));
    let exported = client
        .document_export_recovery(None, "draft:native-bytes")
        .unwrap();
    assert_eq!(&exported[..4], b"NDRE");
    let size = u32::from_le_bytes(exported[8..12].try_into().unwrap()) as usize;
    assert_eq!(
        &exported[12 + size..12 + size + frozen.len()],
        frozen.as_slice()
    );
    // The native byte dispatcher must preserve the same subscription admission as Desktop.
    let response = client
        .document_read(
            None,
            OwnedDocumentRead::SyncYjs {
                document_id: document_id.into(),
                state_vector: vec![],
                history_after_head_seq: None,
            },
        )
        .unwrap();
    assert!(
        matches!(response.0, ResponseEnvelope::Error(error) if error.code == nodex_core_contracts::CoreErrorCode::Unauthorized)
    );
}

#[test]
#[cfg(unix)]
fn native_core_survives_launcher_exit_and_process_group_cleanup() {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    const FIXTURE_HOME: &str = "NODEX_TEST_LAUNCHER_GROUP_HOME";
    const FIXTURE_MODE: &str = "NODEX_TEST_LAUNCHER_GROUP_MODE";
    if let Some(home) = std::env::var_os(FIXTURE_HOME) {
        let home = Path::new(&home);
        let client = connect_or_launch(
            home,
            "native-launcher-lifetime-fixture",
            Some(Path::new(env!("CARGO_BIN_EXE_nodex-core"))),
        )
        .expect("native launcher starts Core");
        nodex_platform::private_fs::write(
            home.join("launcher-ready"),
            client.descriptor.pid.to_string(),
        )
        .expect("publish fixture readiness");
        if std::env::var(FIXTURE_MODE).as_deref() == Ok("cancel") {
            loop {
                thread::park();
            }
        }
        return;
    }

    for mode in ["exit", "cancel"] {
        let directory = tempdir().expect("Core home");
        let home = directory.path().canonicalize().expect("absolute home");
        let mut launcher = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "native_core_survives_launcher_exit_and_process_group_cleanup",
            ])
            .env(FIXTURE_HOME, &home)
            .env(FIXTURE_MODE, mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("owned native launcher group");
        let group = rustix::process::Pid::from_raw(launcher.id() as i32).expect("launcher group");
        let deadline = Instant::now() + Duration::from_secs(15);
        while !home.join("launcher-ready").exists() {
            assert!(
                Instant::now() < deadline,
                "native fixture did not become ready"
            );
            assert!(launcher.try_wait().expect("launcher status").is_none());
            thread::sleep(Duration::from_millis(10));
        }
        let client = CoreClient::connect(&home, "native-launcher-lifetime-test")
            .expect("connect before caller cleanup");
        let pid = client.descriptor.pid;
        let guard = ProcessGuard(pid);
        if mode == "exit" {
            assert!(launcher.wait().expect("launcher exit").success());
        }
        let cleanup = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        assert!(cleanup.is_ok() || cleanup == Err(rustix::io::Errno::SRCH));
        let _ = launcher.wait();

        assert_eq!(
            client.health().expect("Core survives group cleanup").pid,
            pid
        );
        let core = rustix::process::Pid::from_raw(pid as i32).expect("Core PID");
        assert_eq!(
            rustix::process::getsid(Some(core)).expect("Core session"),
            core
        );
        client.shutdown().expect("explicit authenticated shutdown");
        let deadline = Instant::now() + Duration::from_secs(5);
        while home.join("run/core/core.sock").exists() {
            assert!(
                Instant::now() < deadline,
                "Core did not drain after shutdown"
            );
            thread::sleep(Duration::from_millis(10));
        }
        std::mem::forget(guard);
    }
}

/// Opens a desktop Host connection the way Main does, returning its connection headers.
fn bind_electron_host(client: &CoreClient, home: &Path) -> Vec<(String, String)> {
    let connection_id = "agent-attribution-host";
    let handshake = serde_json::to_string(&nodex_core_protocol::HandshakeRequest {
        requirements: nodex_core_protocol::core_client_requirements(),
        client: nodex_core_protocol::ClientIdentity {
            kind: nodex_core_protocol::ClientKind::ElectronHost,
            build_id: "agent-attribution-test".to_owned(),
        },
        connection_id: connection_id.to_owned(),
        expected_generation: nodex_core_protocol::RuntimeGenerationIdentity::from(
            &client.descriptor,
        ),
    })
    .unwrap();
    let response = raw_post(home, "/core/v1/handshake", &handshake, &[]);
    assert!(response.0 == 200, "{response:?}");
    let binding = response.1["connection_binding"]
        .as_str()
        .unwrap()
        .to_owned();
    vec![
        ("x-nodex-connection-id".to_owned(), connection_id.to_owned()),
        ("x-nodex-connection-binding".to_owned(), binding),
    ]
}

fn raw_post(
    home: &Path,
    path: &str,
    body: &str,
    headers: &[(String, String)],
) -> (u16, serde_json::Value) {
    use std::io::{Read, Write};
    let directory = home.join("run/core");
    let auth = fs::read_to_string(directory.join("core.auth")).unwrap();
    let descriptor: nodex_core_protocol::RuntimeDescriptor =
        serde_json::from_slice(&fs::read(directory.join("core.json")).unwrap()).unwrap();
    let mut stream = nodex_platform::local_endpoint::connect(
        Path::new(&descriptor.endpoint),
        Some(descriptor.pid),
    )
    .unwrap();
    let headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        auth.trim(),
        body.len(),
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let status = response[9..12].parse().unwrap();
    let json = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| serde_json::from_str(body).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    (status, json)
}

#[test]
fn agent_attribution_credentials_name_the_attaching_session() {
    use nodex_core_contracts::library::{
        LibraryPageFileAttachmentActor, LibraryPageFileCollisionPolicy, LibraryPageFileSelector,
    };
    let directory = tempdir().expect("Core home");
    let home = directory.path().canonicalize().expect("absolute home");
    let executable = Path::new(env!("CARGO_BIN_EXE_nodex-core"));
    let mut client = connect_or_launch(&home, "agent-attribution-test", Some(executable))
        .expect("native client launch");
    let guard = ProcessGuard(client.handshake.generation.pid);
    let store_epoch = StoreEpoch(client.handshake.store_epoch.clone());
    let project_id = "019b1000-1000-7000-8000-0000000000a1";
    let page_id = "019b1000-1000-7000-8000-0000000000a2";
    let session_id = "019b1000-1000-7000-8000-0000000000a3";
    let source = home.join("source");
    nodex_platform::private_fs::create_dir(&source).unwrap();
    let workspace = |operation: &str, intent| {
        let response = client
            .workspace_apply(
                None,
                ModuleApplyRequest {
                    contract_version: <nodex_core_contracts::workspace::ProjectWorkspaceContract as VersionedModuleContract>::VERSION,
                    operation_id: operation.to_owned(),
                    store_epoch: store_epoch.clone(),
                    intent,
                },
            )
            .unwrap();
        assert!(
            matches!(response.0, ResponseEnvelope::Ok(_)),
            "{response:?}"
        );
    };
    workspace(
        "attribution:create-project",
        ProjectWorkspaceIntent::CreateInitialProject {
            project_id: project_id.to_owned(),
            name: "Attribution".to_owned(),
            description: String::new(),
            appearance: None,
            source_roots: vec![source.to_string_lossy().into_owned()],
            page_key_prefix: None,
            starter_page: ProjectWorkspaceStarterPage {
                page_id: "019b1000-1000-7000-8000-0000000000a4".to_owned(),
                document_id: "019b1000-1000-7000-8000-0000000000a5".to_owned(),
                title_markdown: "Welcome".to_owned(),
                markdown: "Welcome.".to_owned(),
            },
        },
    );
    workspace(
        "attribution:create-session",
        ProjectWorkspaceIntent::CreateSession {
            session_id: session_id.to_owned(),
            project_id: Some(project_id.to_owned()),
            title: "Dashboard cold start".to_owned(),
            initial_page_ids: Vec::new(),
        },
    );
    let created_page = client
        .library_apply(
            Some(project_id),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                operation_id: "attribution:create-page".to_owned(),
                store_epoch: store_epoch.clone(),
                intent: LibraryIntent::CreatePage {
                    page_id: page_id.to_owned(),
                    document_id: "019b1000-1000-7000-8000-0000000000a6".to_owned(),
                    title: "Dashboard cold start".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    assert!(matches!(created_page.0, ResponseEnvelope::Ok(_)));

    let request = |session: &str| {
        serde_json::json!({ "session_id": session, "backend": "opencode" }).to_string()
    };
    // Only the desktop Host can vouch for an Agent, and only for a Session that exists.
    let native_headers = vec![];
    assert_eq!(
        raw_post(
            &home,
            "/core/v1/agent-attributions",
            &request(session_id),
            &native_headers
        )
        .0,
        401
    );
    let host = bind_electron_host(&client, &home);
    assert_eq!(
        raw_post(
            &home,
            "/core/v1/agent-attributions",
            &request("019b1000-1000-7000-8000-0000000000ff"),
            &host
        )
        .0,
        404
    );
    let (status, issued) = raw_post(
        &home,
        "/core/v1/agent-attributions",
        &request(session_id),
        &host,
    );
    assert_eq!(status, 200, "{issued}");
    let credential = issued["credential"].as_str().unwrap().to_owned();

    let attach = |client: &CoreClient, index: u64, path: &str| {
        let bytes = format!("attributed {path}");
        let operation_id = format!("attribution:attach:{index}");
        let prepared = client
            .prepare_file_blob(
                Some(project_id),
                &operation_id,
                &client.handshake.store_epoch,
                Some(path),
                &mut Cursor::new(bytes.as_bytes()),
                bytes.len() as u64,
            )
            .unwrap();
        let response = client
            .library_apply(
                Some(project_id),
                ModuleApplyRequest {
                    contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                    operation_id,
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: LibraryIntent::ApplyPageFileEntries {
                        page_id: page_id.to_owned(),
                        expected_manifest_revision: index as i64,
                        changes: vec![LibraryPageFileEntryChange::Import {
                            file_id: format!("attributed-file-{index}"),
                            logical_path: path.to_owned(),
                            mime_type: "text/plain".to_owned(),
                            prepared_blob_receipt_id: prepared.receipt_id,
                            collision_policy: LibraryPageFileCollisionPolicy::Reject,
                        }],
                        turn_id: None,
                    },
                },
            )
            .unwrap();
        assert!(
            matches!(response.0, ResponseEnvelope::Ok(_)),
            "{response:?}"
        );
        let resolved = client
            .library_read(
                Some(project_id),
                LibraryRead::ResolvePageFile {
                    page_id: page_id.to_owned(),
                    selector: LibraryPageFileSelector::Path {
                        logical_path: path.to_owned(),
                    },
                },
            )
            .unwrap();
        let ResponseEnvelope::Ok(snapshot) = resolved.0 else {
            panic!("resolved Page File")
        };
        let LibraryReadValue::ResolvedPageFile { value } = snapshot.value else {
            panic!("resolved Page File value")
        };
        value.attachment.unwrap().attached_by
    };

    assert_eq!(
        attach(&client, 0, "profile/unverified.txt"),
        LibraryPageFileAttachmentActor::External
    );
    client.attribute_to_agent(credential.clone()).unwrap();
    assert_eq!(
        attach(&client, 1, "profile/report.html"),
        LibraryPageFileAttachmentActor::Agent {
            session_id: session_id.to_owned(),
            backend: nodex_core_contracts::agent::AgentBackendKind::OpenCode,
        }
    );
    // An altered credential proves nothing; the change is still made, as external.
    let (prefix, rest) = credential.split_once('.').unwrap();
    client
        .attribute_to_agent(format!("{prefix}.{}x", rest))
        .unwrap();
    assert_eq!(
        attach(&client, 2, "profile/trace.json"),
        LibraryPageFileAttachmentActor::External
    );

    client.shutdown().expect("authenticated cleanup");
    drop(client);
    wait_for_runtime_cleanup(&home);
    drop(guard);
}

#[cfg(windows)]
#[test]
fn shared_core_survives_the_windows_bootstrap_process() {
    use std::io::BufRead;
    use std::process::Stdio;
    let directory = tempdir().unwrap();
    let home = directory.path().canonicalize().unwrap();
    let mut selector = Command::new(env!("CARGO_BIN_EXE_nodex-core"))
        .args(["--home", home.to_str().unwrap()])
        .env("NODEX_LOG_CONSOLE", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(selector.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let selection: nodex_core_protocol::CoreSelectionResult = serde_json::from_str(&line).unwrap();
    let _guard = ProcessGuard(selection.descriptor.pid);
    assert_ne!(selector.id(), selection.descriptor.pid);
    selector.kill().unwrap();
    selector.wait().unwrap();
    let client = CoreClient::connect(&home, "bootstrap-survival").unwrap();
    assert_eq!(client.descriptor.pid, selection.descriptor.pid);
    client.health().unwrap();
    client.shutdown().unwrap();
    drop(client);
    wait_for_runtime_cleanup(&home);
}
