//! Run after `cargo build -p nodex-core-server`; the workspace test gate builds both binaries.
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::inbox::{
    ProjectWorkspaceInboxScope, ProjectWorkspaceInboxSource, ProjectWorkspaceInboxWindowFilter,
};
use nodex_core_contracts::workspace::{
    PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspaceRead,
    ProjectWorkspaceReadValue, ProjectWorkspaceStarterPage,
};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::connect_or_launch;
use serde_json::Value;

const PROJECT: &str = "019b1000-1000-7000-8000-000000000101";

struct CoreGuard(u32);
impl Drop for CoreGuard {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.0.to_string()])
            .status();
    }
}

fn nodex(home: &Path, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Value {
    let mut process = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .arg("--json")
        .args(args)
        .env("NODEX_HOME", home)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(text) = stdin {
        process
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
    let output = process.wait_with_output().unwrap();
    let envelope: Value = serde_json::from_slice(if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    })
    .unwrap_or_else(|error| {
        panic!(
            "{args:?}: {error}; stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(envelope["ok"], true, "{args:?}: {envelope}");
    envelope["result"].clone()
}

#[test]
fn command_line_sends_land_in_the_inbox_of_their_project() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("profile");
    let workspace = directory.path().join("workspace");
    let elsewhere = directory.path().join("elsewhere");
    for path in [&home, &workspace, &elsewhere] {
        fs::create_dir(path).unwrap();
    }
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex")).with_file_name("nodex-core");
    let client = connect_or_launch(&home, "inbox-cli-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    let created = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "inbox-cli:project".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreateInitialProject {
                    project_id: PROJECT.to_owned(),
                    name: "Search".to_owned(),
                    description: String::new(),
                    appearance: None,
                    source_roots: vec![workspace.to_string_lossy().into_owned()],
                    page_key_prefix: None,
                    starter_page: ProjectWorkspaceStarterPage {
                        page_id: "019b1000-1000-7000-8000-000000000102".to_owned(),
                        document_id: "document:inbox-cli".to_owned(),
                        title_markdown: "Notes".to_owned(),
                        nfm: String::new(),
                    },
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)));

    let args = [
        "inbox",
        "send",
        "Benchmark search on the large fixture",
        "--title",
        "Search benchmark",
        "--idempotency-key",
        "inbox-cli-1",
    ];
    let sent = nodex(&home, &workspace, &args, None);
    assert_eq!(sent["project_id"], PROJECT);
    assert_eq!(sent["duplicate"], false);
    let replay = nodex(&home, &workspace, &args, None);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(replay["page_id"], sent["page_id"]);

    let outside = nodex(
        &home,
        &elsewhere,
        &["inbox", "send"],
        Some("Try the new tokenizer\nOnly after the benchmark lands."),
    );
    assert_eq!(outside["project_id"], Value::Null);

    let read = |scope: ProjectWorkspaceInboxScope| {
        let window = client
            .workspace_read(
                None,
                ProjectWorkspaceRead::InboxWindow {
                    scope,
                    filter: ProjectWorkspaceInboxWindowFilter::Inbox,
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(10),
                    },
                },
            )
            .unwrap();
        let ResponseEnvelope::Ok(snapshot) = window.0 else {
            panic!("Inbox window")
        };
        let ProjectWorkspaceReadValue::InboxWindow { items } = snapshot.value else {
            panic!("Inbox window value")
        };
        items
            .items
            .into_iter()
            .map(|item| (item.title, item.body, item.source))
            .collect::<Vec<_>>()
    };
    // Sent from outside every Project, the message waits in the Library Inbox.
    assert_eq!(
        read(ProjectWorkspaceInboxScope::Library),
        vec![(
            "Try the new tokenizer".to_owned(),
            "Try the new tokenizer\nOnly after the benchmark lands.".to_owned(),
            ProjectWorkspaceInboxSource::CommandLine {
                project_id: None,
                label: "Command line".into(),
            },
        )]
    );
    // Sent from the Project's folder, it waits in that Project's own Inbox.
    assert_eq!(
        read(ProjectWorkspaceInboxScope::Project {
            project_id: PROJECT.into(),
        }),
        vec![(
            "Search benchmark".to_owned(),
            "Benchmark search on the large fixture".to_owned(),
            ProjectWorkspaceInboxSource::CommandLine {
                project_id: Some(PROJECT.into()),
                label: "Command line".into(),
            },
        )]
    );
}
