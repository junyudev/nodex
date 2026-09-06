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

#[allow(dead_code)]
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
                operation_id: "cli-data:project".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreateInitialProject {
                    project_id: PROJECT.to_owned(),
                    name: "Data primitives CLI".to_owned(),
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
                operation_id: "cli-data:page-b".to_owned(),
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

fn input(home: &Path, args: &[&str], payload: &Value) -> Value {
    input_text(home, args, &payload.to_string())
}

fn input_text(home: &Path, args: &[&str], payload: &str) -> Value {
    use std::io::Write;
    use std::process::Stdio;
    let mut process = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args(["--project", PROJECT])
        .args(args)
        .env("NODEX_HOME", home)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let result = process.wait_with_output().unwrap();
    let envelope: Value = serde_json::from_slice(if result.status.success() {
        &result.stdout
    } else {
        &result.stderr
    })
    .unwrap_or_else(|_| panic!("{args:?}: {}", String::from_utf8_lossy(&result.stderr)));
    assert_eq!(result.status.success(), envelope["ok"] == true);
    envelope
}

#[test]
fn discovered_identities_drive_queries_atomic_edits_and_direct_browsing() {
    use nodex_core_contracts::DATABASE_CONTRACT_VERSION;
    use nodex_core_contracts::database::{DatabaseIntent, DatabasePropertySchema};
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("profile");
    fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex")).with_file_name("nodex-core");
    let client = connect_or_launch(&home, "data-cli-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    verify_direct_body_and_title_edits(&home);
    let properties = success(&home, &["page", "properties", "get", &format!("@{PAGE_A}")]);
    let source_id = properties["data_source_id"].as_str().unwrap().to_owned();
    let descriptor = success(
        &home,
        &["data-source", "describe", &source_id, "--limit", "1"],
    );
    assert!(
        descriptor["properties"]["next_cursor"].is_string(),
        "schema window must indicate continuation"
    );
    let database_id = descriptor["data_source"]["data_source"]["home_database_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sources = success(&home, &["data-source", "list", "--database", &database_id]);
    assert_eq!(
        sources["value"]["data_sources"]["items"][0]["data_source_id"],
        source_id
    );
    for (id, schema) in [
        ("p_clinote0", DatabasePropertySchema::Text),
        (
            "p_clinum00",
            DatabasePropertySchema::Number {
                format: Default::default(),
            },
        ),
    ] {
        let descriptor = success(&home, &["data-source", "describe", &source_id]);
        let revision = descriptor["data_source"]["data_source"]["schema_revision"]
            .as_i64()
            .unwrap();
        let result = client
            .database_apply(
                Some(PROJECT),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: format!("schema-create-{revision}"),
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: source_id.clone(),
                        property_id: id.to_owned(),
                        expected_data_source_revision: revision,
                        expected_property_revision: 0,
                        name: id.to_owned(),
                        schema,
                        before_property_id: None,
                    }],
                },
            )
            .unwrap();
        assert!(matches!(result.0, ResponseEnvelope::Ok(_)), "{result:?}");
    }
    let schema = success(&home, &["data-source", "describe", &source_id]);
    let schema_revision = schema["data_source"]["data_source"]["schema_revision"]
        .as_i64()
        .unwrap();
    for index in 0..51 {
        let result = client
            .database_apply(
                Some(PROJECT),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: format!("schema-pressure-{index}"),
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: source_id.clone(),
                        property_id: format!("p_bulk{index:04}"),
                        expected_data_source_revision: schema_revision + index,
                        expected_property_revision: 0,
                        name: format!("Extra {index}"),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .unwrap();
        assert!(matches!(result.0, ResponseEnvelope::Ok(_)), "{result:?}");
    }
    let first_schema = success(&home, &["data-source", "describe", &source_id]);
    assert_eq!(
        first_schema["properties"]["items"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    let schema_cursor = first_schema["properties"]["next_cursor"].as_str().unwrap();
    let second_schema = success(
        &home,
        &[
            "data-source",
            "describe",
            &source_id,
            "--after",
            schema_cursor,
        ],
    );
    assert!(second_schema["properties"]["next_cursor"].is_null());
    let first_ids = first_schema["properties"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|property| property["property_id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    for property in second_schema["properties"]["items"].as_array().unwrap() {
        assert!(!first_ids.contains(property["property_id"].as_str().unwrap()));
    }
    let before = success(&home, &["page", "properties", "get", &format!("@{PAGE_A}")]);
    assert_eq!(before["value_revisions"]["p_clinote0"], 0);
    assert_eq!(before["values"]["p_clinote0"], Value::Null);
    for (property, flag, value) in [
        ("p_clinote0", "--text", "Readable text"),
        ("p_clinum00", "--number", "-12.5"),
    ] {
        success(
            &home,
            &[
                "page",
                "properties",
                "set",
                &format!("@{PAGE_A}"),
                "--property",
                property,
                flag,
                value,
                "--if-revision",
                "0",
            ],
        );
    }
    let options = success(
        &home,
        &["data-source", "options", &source_id, "--property", "status"],
    );
    let option = options["value"]["options"]["items"][0]["id"]
        .as_str()
        .unwrap();
    let revision = before["value_revisions"]["status"]
        .as_i64()
        .unwrap()
        .to_string();
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            &format!("@{PAGE_A}"),
            "--property",
            "status",
            "--option",
            option,
            "--if-revision",
            &revision,
        ],
    );
    let changed = success(&home, &["page", "properties", "get", &format!("@{PAGE_A}")]);
    assert_eq!(changed["values"]["p_clinote0"], "Readable text");
    assert_eq!(changed["values"]["p_clinum00"], -12.5);
    let mixed = serde_json::json!({ "edits": [
        { "address": { "page_id": PAGE_A, "data_source_id": source_id, "property_id": "p_clinote0" }, "edit": { "kind": "replace", "expected_value_revision": changed["value_revisions"]["p_clinote0"], "value": { "kind": "text", "value": "Must roll back" } } },
        { "address": { "page_id": PAGE_A, "data_source_id": source_id, "property_id": "p_clinum00" }, "edit": { "kind": "replace", "expected_value_revision": 0, "value": { "kind": "number", "value": 1 } } }
    ] });
    assert_eq!(
        input(&home, &["page", "properties", "apply"], &mixed)["ok"],
        false
    );
    let after = success(&home, &["page", "properties", "get", &format!("@{PAGE_A}")]);
    assert_eq!(after["values"], changed["values"]);
    let batch = serde_json::json!({ "destination": { "kind": "data_source", "data_source_id": source_id, "values": [] }, "pages": [ { "title_markdown": "Batch twin", "nested_markdown": "One" }, { "title_markdown": "Batch twin", "nested_markdown": "Two" } ] });
    let created = input(
        &home,
        &[
            "page",
            "create-batch",
            "--idempotency-key",
            "cli-batch",
            "--return",
            "commit",
        ],
        &batch,
    );
    assert_eq!(created["ok"], true, "{created}");
    assert!(created["result"]["commit"].is_object());
    assert_eq!(created["result"]["pages"].as_array().unwrap().len(), 2);
    for page in created["result"]["pages"].as_array().unwrap() {
        assert_eq!(page["block_ids"], serde_json::json!([]));
        assert_eq!(page["body_blocks_created"], 1);
    }
    let replay = input(
        &home,
        &[
            "page",
            "create-batch",
            "--idempotency-key",
            "cli-batch",
            "--return",
            "commit",
        ],
        &batch,
    );
    assert_eq!(replay["result"]["pages"], created["result"]["pages"]);
    assert_eq!(replay["result"]["duplicate"], true);
    let query = serde_json::json!({ "filter": { "kind": "group", "operator": "and", "children": [] }, "sort": [], "projection_property_ids": [], "limit": 50 });
    let result = input(
        &home,
        &["data-source", "query", &source_id, "--limit", "1"],
        &query,
    );
    assert_eq!(result["ok"], true, "{result}");
    let rows = &result["result"]["value"]["value"]["rows"];
    assert_eq!(rows["items"].as_array().unwrap().len(), 1);
    assert_eq!(rows["items"][0]["database_values"], serde_json::json!({}));
    let cursor = rows["next_cursor"].as_str().unwrap();
    let next = input(
        &home,
        &[
            "data-source",
            "query",
            &source_id,
            "--limit",
            "1",
            "--after",
            cursor,
        ],
        &query,
    );
    assert_eq!(next["ok"], true, "{next}");
    assert_ne!(
        rows["items"][0]["page_id"],
        next["result"]["value"]["value"]["rows"]["items"][0]["page_id"]
    );
    let listed = success(&home, &["ls", &format!("@{database_id}"), "--limit", "1"]);
    assert_eq!(listed["scope"], "direct_data_source_pages");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["has_more"], true);
    let search = success(&home, &["search", "Batch twin"]);
    assert_eq!(search["items"].as_array().unwrap().len(), 2);
    let forged = serde_json::json!({ "authorization": {}, "filter": { "kind": "group", "operator": "and", "children": [] }, "sort": [] });
    assert_eq!(
        input(&home, &["data-source", "query", &source_id], &forged)["ok"],
        false
    );
    let other_project = "019b1000-1000-7000-8000-000000000099";
    let created_project = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "cli-data:other-project".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreateProject {
                    project_id: other_project.to_owned(),
                    name: "Other scope".to_owned(),
                    description: String::new(),
                    appearance: None,
                    source_roots: Vec::new(),
                    page_key_prefix: None,
                },
            },
        )
        .unwrap();
    assert!(
        matches!(created_project.0, ResponseEnvelope::Ok(_)),
        "{created_project:?}"
    );
    let denied = client
        .database_read(
            Some(other_project),
            nodex_core_contracts::database::DatabaseRead::DataSourceQuery {
                data_source_id: source_id,
                query: serde_json::from_value(query).unwrap(),
            },
        )
        .unwrap();
    assert!(
        matches!(denied.0, ResponseEnvelope::Error(error) if error.code == nodex_core_contracts::CoreErrorCode::Unauthorized)
    );
}

#[test]
fn malformed_structured_inputs_fail_before_resolving_or_launching_a_profile() {
    use std::io::Write;
    use std::process::Stdio;
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("must-not-exist");
    for args in [
        vec!["data-source", "query", "@source"],
        vec!["page", "properties", "apply"],
        vec!["page", "create-batch"],
        vec![
            "block",
            "insert",
            "@page",
            "--at",
            "end",
            "--block-json",
            "-",
        ],
        vec![
            "block",
            "update",
            "@page",
            "--block",
            "block",
            "--if-match",
            "etag",
            "--patch-json",
            "-",
        ],
    ] {
        let mut process = Command::new(env!("CARGO_BIN_EXE_nodex"))
            .args(&args)
            .env("NODEX_HOME", &home)
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process.stdin.take().unwrap().write_all(b"{").unwrap();
        let output = process.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"]["code"], "INVALID_INPUT", "{args:?}: {error}");
        assert!(
            !home.exists(),
            "{args:?} must reject input before Profile resolution"
        );
    }
}

fn verify_direct_body_and_title_edits(home: &Path) {
    let page = format!("@{PAGE_B}");
    let initial = success(home, &["read", &page]);
    let title_etag = initial["validators"]["title_etag"].as_str().unwrap();
    success(
        home,
        &[
            "page",
            "rename",
            &page,
            "Renamed Page",
            "--if-match",
            title_etag,
            "--idempotency-key",
            "rename-page",
        ],
    );
    let retry = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args([
            "--output-format",
            "text",
            "--project",
            PROJECT,
            "page",
            "rename",
            &page,
            "Renamed Page",
            "--if-match",
            title_etag,
            "--idempotency-key",
            "rename-page",
        ])
        .env("NODEX_HOME", home)
        .current_dir(home)
        .output()
        .unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let stale = run(
        home,
        &[
            "page",
            "rename",
            &page,
            "Should not rename",
            "--if-match",
            title_etag,
        ],
    );
    assert_eq!(stale["ok"], false);
    let after_title = success(home, &["read", &page]);
    assert_eq!(after_title["content"], initial["content"]);
    let block = serde_json::json!({ "local_id": "first", "block_type": "paragraph", "props": {}, "content": { "kind": "value", "value": [{ "type": "text", "text": "Inserted block", "styles": {} }] }, "children": [] });
    let inserted = input(
        home,
        &["block", "insert", &page, "--at", "end", "--block-json", "-"],
        &block,
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    let block_id = inserted["result"]["affected"]["created_block_ids"][0]
        .as_str()
        .unwrap();
    let block_etag = inserted["result"]["etags"]["blocks"][block_id]["update"]
        .as_str()
        .unwrap();
    let patch = serde_json::json!({ "content": { "kind": "value", "value": [{ "type": "text", "text": "Updated block", "styles": {} }] }, "unset_content": false });
    let updated = input(
        home,
        &[
            "block",
            "update",
            &page,
            "--block",
            block_id,
            "--if-match",
            block_etag,
            "--patch-json",
            "-",
        ],
        &patch,
    );
    assert_eq!(updated["ok"], true, "{updated}");
    let read = success(home, &["read", &page]);
    assert!(read["content"].as_str().unwrap().contains("Updated block"));
    let stale_body = input_text(
        home,
        &[
            "page",
            "replace",
            &page,
            "--if-match",
            after_title["validators"]["body_etag"].as_str().unwrap(),
        ],
        "Should not replace",
    );
    assert_eq!(stale_body["ok"], false);
    assert_eq!(success(home, &["read", &page])["content"], read["content"]);
}
