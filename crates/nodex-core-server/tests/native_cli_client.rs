use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use nodex_core::infrastructure::schema::CURRENT_STORE_REVISION;
use nodex_core_contracts::administration::{StoreAdministrationRead, StoreAdministrationReadValue};
use nodex_core_contracts::events::DeliveryAuthorizationScope;
use nodex_core_contracts::library::{
    LibraryAccess, LibraryIntent, LibraryPageFileEntryChange, LibraryPagePrepareKind,
    LibraryPageProjectionFileKind, LibraryRead, LibraryReadValue, LibraryResourceTarget,
    LibraryWriteParent,
};
use nodex_core_contracts::workspace::{ProjectWorkspaceIntent, ProjectWorkspaceStarterPage};
use nodex_core_contracts::{
    ApplyResponse, ModuleApplyRequest, StoreEpoch, VersionedModuleContract,
};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use tempfile::tempdir;

struct ProcessGuard(u32);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.to_string()])
            .status();
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
    fs::create_dir(&source).expect("Project source");
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
                        nfm: "Welcome to Nodex.".to_owned(),
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
        delivery.authorization_scope,
        DeliveryAuthorizationScope::Project {
            ref library_id,
            project_id: ref delivery_project_id,
        } if library_id == &client.handshake.library_id && delivery_project_id == project_id
    ));
    let granted = client
        .library_apply(
            None,
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::library::LIBRARY_CONTRACT_VERSION,
                operation_id: "native-client:grant-page".to_owned(),
                store_epoch,
                intent: LibraryIntent::GrantProjectAccess {
                    project_id: project_id.to_owned(),
                    target: LibraryResourceTarget::Page {
                        page_id: page_id.to_owned(),
                    },
                    access: LibraryAccess::ReadWrite,
                },
            },
        )
        .expect("grant Page through native client");
    assert!(matches!(granted.0, ResponseEnvelope::Ok(_)));
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
    assert!(
        value
            .content
            .contains(r#"title: "Native \\*\\*read\\*\\*""#)
    );
    assert!(value.validators.title_etag.is_some());
    assert!(value.validators.body_etag.is_none());

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
    drop(client);
    drop(guard);
    wait_for_runtime_cleanup(&home);
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
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceQueuedFollowUpEntry, ProjectWorkspaceQueuedFollowUpPayloadRef,
    };
    let queued_bytes = b"queued input";
    let queued_blob = client
        .prepare_blob(
            Some(project_id),
            "native-queue:commit",
            &client.handshake.store_epoch,
            Some("attachment"),
            &mut Cursor::new(queued_bytes),
            queued_bytes.len() as u64,
        )
        .unwrap();
    let source = format!("nodex://assets/{}.blob", queued_blob.blob_etag);
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schema_version": 2,
        "payload": { "prompt": "Review input", "prompt_input": { "items": [{ "source": source }] } },
        "asset_references": [{ "asset_uri": source, "sha256": queued_blob.blob_etag, "byte_length": queued_bytes.len(), "mime_type": "text/plain" }],
    })).unwrap();
    let payload = client
        .prepare_blob(
            Some(project_id),
            "native-queue:commit",
            &client.handshake.store_epoch,
            Some("manifest"),
            &mut Cursor::new(&manifest),
            manifest.len() as u64,
        )
        .unwrap();
    apply(
        "native-queue:commit",
        ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            thread_id: thread_id.to_owned(),
            expected_revision: 0,
            prepared_blob_receipt_ids: vec![queued_blob.receipt_id, payload.receipt_id],
            entries: vec![ProjectWorkspaceQueuedFollowUpEntry {
                follow_up_id: "native-follow-up".to_owned(),
                client_user_message_id: "native-message".to_owned(),
                created_at_ms: 1,
                pause: None,
                payload: ProjectWorkspaceQueuedFollowUpPayloadRef {
                    schema_version: 2,
                    asset_uri: format!("nodex://assets/{}.blob", payload.blob_etag),
                    sha256: payload.blob_etag,
                    byte_length: payload.byte_length,
                },
            }],
        },
    );
    assert_eq!(
        client
            .read_thread_asset_blob(Some(project_id), thread_id, &queued_blob.blob_etag)
            .unwrap()
            .bytes,
        queued_bytes
    );
    apply(
        "native-queue:clear",
        ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            thread_id: thread_id.to_owned(),
            expected_revision: 1,
            entries: Vec::new(),
            prepared_blob_receipt_ids: Vec::new(),
        },
    );
    assert!(
        client
            .read_thread_asset_blob(Some(project_id), thread_id, &queued_blob.blob_etag)
            .is_err()
    );
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
