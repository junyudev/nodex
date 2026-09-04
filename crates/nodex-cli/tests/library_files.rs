//! Run after `cargo build -p nodex-core-server`; the workspace test gate builds both binaries.
use std::fs;
use std::path::Path;
use std::process::Command;

use nodex_core_contracts::library::{LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryWriteParent};
use nodex_core_contracts::workspace::{
    PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspaceStarterPage,
};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use serde_json::Value;

const PROJECT: &str = "019b1000-1000-7000-8000-000000000001";
const PAGE_A: &str = "019b1000-1000-7000-8000-000000000002";
const PAGE_B: &str = "019b1000-1000-7000-8000-000000000003";

struct CoreGuard(u32);
impl Drop for CoreGuard {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.to_string()])
            .status();
    }
}

fn run(home: &Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args(["--json", "--project", PROJECT])
        .args(args)
        .env("NODEX_HOME", home)
        .current_dir(home)
        .output()
        .unwrap();
    let bytes = if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    };
    let envelope: Value = serde_json::from_slice(bytes).unwrap_or_else(|error| {
        panic!(
            "{args:?}: {error}; stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(output.status.success(), envelope["ok"] == true);
    envelope
}

fn success(home: &Path, args: &[&str]) -> Value {
    let envelope = run(home, args);
    assert_eq!(envelope["ok"], true, "{args:?}: {envelope}");
    envelope["result"].clone()
}

fn read(home: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args(["--project", PROJECT])
        .args(args)
        .env("NODEX_HOME", home)
        .current_dir(home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn seed(client: &CoreClient, home: &Path) {
    let source = home.join("workspace");
    fs::create_dir(&source).unwrap();
    let created = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "cli-files:project".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreateInitialProject {
                    project_id: PROJECT.to_owned(),
                    name: "File CLI".to_owned(),
                    description: String::new(),
                    appearance: None,
                    source_roots: vec![source.to_string_lossy().into_owned()],
                    page_key_prefix: None,
                    starter_page: ProjectWorkspaceStarterPage {
                        page_id: PAGE_A.to_owned(),
                        document_id: "document:cli-a".to_owned(),
                        title_markdown: "Page A".to_owned(),
                        nfm: String::new(),
                    },
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)));
    let created = client
        .library_apply(
            Some(PROJECT),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "cli-files:page-b".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreatePage {
                    page_id: PAGE_B.to_owned(),
                    document_id: "document:cli-b".to_owned(),
                    title: "Page B".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)));
}

#[test]
fn native_cli_shares_files_replaces_only_one_relation_and_replays_exact_writes() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex")).with_file_name("nodex-core");
    assert!(
        core_binary.is_file(),
        "Run cargo build -p nodex-core-server before this test"
    );
    let client = connect_or_launch(&home, "file-cli-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    fs::write(home.join("alpha.txt"), b"alpha").unwrap();
    fs::write(home.join("beta.txt"), b"beta").unwrap();
    fs::write(home.join("local.txt"), b"local").unwrap();
    let a = format!("@{PAGE_A}");
    let b = format!("@{PAGE_B}");

    let imported = success(
        &home,
        &[
            "file",
            "import",
            "--from",
            "alpha.txt",
            "--idempotency-key",
            "import",
        ],
    );
    let file_id = imported["file_mutation"]["file_id"].as_str().unwrap();
    assert_eq!(imported["file_mutation"]["revision"], 1);
    let metadata = success(&home, &["file", "info", file_id]);
    assert_eq!(metadata["revision"], 1);
    assert_eq!(metadata["head_version"], 1);
    for (page, path, key) in [(&a, "original.txt", "add-a"), (&b, "other.txt", "add-b")] {
        success(
            &home,
            &[
                "page",
                "file",
                "add",
                page,
                "--file-id",
                file_id,
                "--path",
                path,
                "--if-manifest",
                "0",
                "--idempotency-key",
                key,
            ],
        );
    }
    let replace = [
        "file",
        "replace",
        file_id,
        "--from",
        "beta.txt",
        "--if-revision",
        "1",
        "--if-head",
        "1",
        "--idempotency-key",
        "replace",
    ];
    let updated = success(&home, &replace);
    assert_eq!(updated["file_mutation"]["file"]["head_version"], 2);
    assert_eq!(success(&home, &replace)["duplicate"], true);
    assert_eq!(
        read(&home, &["file", "read", file_id, "--version", "1"]),
        b"alpha"
    );
    assert_eq!(
        read(
            &home,
            &["page", "file", "read", &a, "--path", "original.txt"]
        ),
        b"beta"
    );
    assert_eq!(
        read(&home, &["page", "file", "read", &b, "--file-id", file_id]),
        b"beta"
    );

    let stale = run(
        &home,
        &[
            "file",
            "rename",
            file_id,
            "--name",
            "wrong.txt",
            "--if-revision",
            "1",
            "--idempotency-key",
            "stale",
        ],
    );
    assert_eq!(stale["error"]["code"], "ETAG_CONFLICT");
    let collision = run(
        &home,
        &[
            "page",
            "file",
            "put",
            &a,
            "--path",
            "original.txt",
            "--from",
            "local.txt",
            "--if-manifest",
            "1",
            "--idempotency-key",
            "collision",
        ],
    );
    assert_eq!(collision["ok"], false);
    let put = [
        "page",
        "file",
        "put",
        &a,
        "--path",
        "original.txt",
        "--from",
        "local.txt",
        "--if-manifest",
        "1",
        "--replace-entry",
        "--idempotency-key",
        "local",
    ];
    let local = success(&home, &put);
    let local_id = local["page_file_entries"][0]["created_file_ids"][0]
        .as_str()
        .unwrap();
    assert_ne!(local_id, file_id);
    success(
        &home,
        &[
            "page",
            "file",
            "rename-path",
            &a,
            "--file-id",
            local_id,
            "--path",
            "renamed.txt",
            "--if-manifest",
            "2",
            "--idempotency-key",
            "rename-path",
        ],
    );
    assert_eq!(success(&home, &put)["duplicate"], true);
    assert_eq!(
        read(
            &home,
            &["page", "file", "read", &a, "--path", "renamed.txt"]
        ),
        b"local"
    );
    assert_eq!(
        read(&home, &["page", "file", "read", &b, "--path", "other.txt"]),
        b"beta"
    );

    let restore = [
        "file",
        "restore",
        file_id,
        "--version",
        "1",
        "--if-revision",
        "2",
        "--if-head",
        "2",
        "--idempotency-key",
        "restore",
    ];
    assert_eq!(
        success(&home, &restore)["file_mutation"]["file"]["head_version"],
        3
    );
    assert_eq!(success(&home, &restore)["duplicate"], true);
    assert_eq!(
        read(&home, &["page", "file", "read", &b, "--path", "other.txt"]),
        b"alpha"
    );
    assert_eq!(
        run(
            &home,
            &[
                "file",
                "trash",
                file_id,
                "--if-revision",
                "3",
                "--idempotency-key",
                "in-use"
            ]
        )["ok"],
        false
    );
    success(
        &home,
        &[
            "page",
            "file",
            "remove",
            &b,
            "--file-id",
            file_id,
            "--if-manifest",
            "1",
            "--idempotency-key",
            "remove",
        ],
    );
    assert_eq!(read(&home, &["file", "read", file_id]), b"alpha");
    success(
        &home,
        &[
            "file",
            "trash",
            file_id,
            "--if-revision",
            "3",
            "--idempotency-key",
            "trash",
        ],
    );
    let purge = [
        "file",
        "purge",
        file_id,
        "--if-revision",
        "4",
        "--idempotency-key",
        "purge",
    ];
    success(&home, &purge);
    assert_eq!(success(&home, &purge)["duplicate"], true);
    assert_eq!(read(&home, &["file", "read", local_id]), b"local");
}
