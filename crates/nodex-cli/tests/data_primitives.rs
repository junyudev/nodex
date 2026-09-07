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
    validate_result(args, &envelope["result"]);
    envelope["result"].clone()
}

fn sql_rows(
    home: &Path,
    statement: &str,
    params: &[(&str, &str)],
    bindings: &[String],
) -> Vec<Value> {
    let mut args = vec!["sql".to_owned(), "query".to_owned(), statement.to_owned()];
    for (name, value) in params {
        args.extend([
            "--param".into(),
            format!("{name}={}", serde_json::to_string(value).unwrap()),
        ]);
    }
    for binding in bindings {
        args.extend(["--bind".into(), binding.clone()]);
    }
    let result = success(home, &args.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(
        result["returned_count"].as_u64().unwrap() as usize,
        result["rows"].as_array().unwrap().len()
    );
    assert!(result["snapshot"].is_string());
    result["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            Value::Object(
                result["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(row.as_array().unwrap())
                    .map(|(key, value)| (key.as_str().unwrap().to_owned(), value.clone()))
                    .collect(),
            )
        })
        .collect()
}
fn source_description(home: &Path, source: &str) -> Value {
    sql_rows(
        home,
        "SELECT * FROM data_sources WHERE data_source_id=:id",
        &[("id", source)],
        &[],
    )
    .remove(0)
}
fn property_state(home: &Path, page: &str) -> Value {
    let rows = sql_rows(
        home,
        "SELECT data_source_id, property_id, value_json, value_revision FROM property_values WHERE page_id=:id",
        &[("id", page)],
        &[],
    );
    let source = rows.first().expect("member Page")["data_source_id"].clone();
    let mut values = serde_json::Map::new();
    let mut revisions = serde_json::Map::new();
    for row in rows {
        let id = row["property_id"].as_str().unwrap().to_owned();
        values.insert(
            id.clone(),
            serde_json::from_str(row["value_json"].as_str().unwrap()).unwrap(),
        );
        revisions.insert(id, row["value_revision"].clone());
    }
    serde_json::json!({"data_source_id":source,"values":values,"value_revisions":revisions})
}

fn validate_result(args: &[&str], result: &Value) {
    let arguments = std::iter::once("nodex")
        .chain(args.iter().copied())
        .chain(["--help-schema", "all"])
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    let nodex_cli::agent_interface::MachineHelpDocument::Command(help) =
        nodex_cli::agent_interface::machine_help(&arguments).expect("command help")
    else {
        panic!("leaf help")
    };
    jsonschema::validator_for(&help.result_schema)
        .expect("valid result schema")
        .validate(result)
        .unwrap_or_else(|error| panic!("{args:?} result violates its schema: {error}"));
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
    let properties = property_state(&home, PAGE_A);
    let source_id = properties["data_source_id"].as_str().unwrap().to_owned();
    let descriptor = source_description(&home, &source_id);
    let database_id = descriptor["database_id"].as_str().unwrap().to_owned();
    let sources = sql_rows(
        &home,
        "SELECT data_source_id FROM data_sources WHERE database_id=:id",
        &[("id", &database_id)],
        &[],
    );
    assert_eq!(sources[0]["data_source_id"], source_id);
    for (id, schema) in [
        ("p_clinote0", DatabasePropertySchema::Text),
        (
            "p_clinum00",
            DatabasePropertySchema::Number {
                format: Default::default(),
            },
        ),
    ] {
        let descriptor = source_description(&home, &source_id);
        let revision = descriptor["schema_revision"].as_i64().unwrap();
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
    let schema = source_description(&home, &source_id);
    let schema_revision = schema["schema_revision"].as_i64().unwrap();
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
    let properties = sql_rows(
        &home,
        "SELECT property_id FROM properties WHERE data_source_id=:id ORDER BY property_id",
        &[("id", &source_id)],
        &[],
    );
    assert!(
        properties.len() > 50,
        "SQL catalog must not inherit the old default schema window"
    );
    let identities = properties
        .iter()
        .map(|property| property["property_id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), properties.len());
    let before = property_state(&home, PAGE_A);
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
                PAGE_A,
                "--property",
                property,
                flag,
                value,
                "--if-revision",
                "0",
            ],
        );
    }
    let options = sql_rows(
        &home,
        "SELECT option_id,name FROM property_options WHERE data_source_id=:id AND property_id='status'",
        &[("id", &source_id)],
        &[],
    );
    let option = options
        .iter()
        .find(|option| option["name"] == "Review")
        .unwrap()["option_id"]
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
            PAGE_A,
            "--property",
            "status",
            "--option",
            option,
            "--if-revision",
            &revision,
        ],
    );
    let changed = property_state(&home, PAGE_A);
    assert_eq!(changed["values"]["p_clinote0"], "Readable text");
    assert_eq!(changed["values"]["p_clinum00"], -12.5);
    let views = sql_rows(
        &home,
        "SELECT v.* FROM views v JOIN databases d ON d.default_view_id=v.view_id WHERE d.database_id=:id",
        &[("id", &database_id)],
        &[],
    );
    let view_id = views[0]["view_id"].as_str().unwrap();
    let config: Value = serde_json::from_str(views[0]["config_json"].as_str().unwrap()).unwrap();
    assert!(config.is_object());
    let binding = vec![format!("tasks={source_id}")];
    let grouped = sql_rows(
        &home,
        "SELECT v.page_id,t.p_clinote0 FROM view_rows(:view) v JOIN tasks t USING(page_id) WHERE v.group_key=:group ORDER BY v.ordinal",
        &[("view", view_id), ("group", option)],
        &binding,
    );
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0]["page_id"], PAGE_A);
    assert_eq!(grouped[0]["p_clinote0"], "Readable text");
    let prepared_move = success(
        &home,
        &[
            "page",
            "prepare",
            PAGE_A,
            "--operation",
            "move",
            "--view",
            view_id,
        ],
    );
    assert!(prepared_move["validators"]["move_etag"].is_string());
    let projected = sql_rows(
        &home,
        "SELECT page_id,Status FROM tasks ORDER BY page_id LIMIT 1",
        &[],
        &binding,
    );
    assert_eq!(projected[0]["Status"], "review");

    let mixed = serde_json::json!({ "edits": [
        { "address": { "page_id": PAGE_A, "data_source_id": source_id, "property_id": "p_clinote0" }, "edit": { "kind": "replace", "expected_value_revision": changed["value_revisions"]["p_clinote0"], "value": { "kind": "text", "value": "Must roll back" } } },
        { "address": { "page_id": PAGE_A, "data_source_id": source_id, "property_id": "p_clinum00" }, "edit": { "kind": "replace", "expected_value_revision": 0, "value": { "kind": "number", "value": 1 } } }
    ] });
    assert_eq!(
        input(&home, &["page", "properties", "apply"], &mixed)["ok"],
        false
    );
    let after = property_state(&home, PAGE_A);
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
    let selected = sql_rows(
        &home,
        "SELECT page_id FROM tasks ORDER BY page_id LIMIT 1",
        &[],
        &binding,
    );
    let next = sql_rows(
        &home,
        "SELECT page_id FROM tasks WHERE page_id > :after ORDER BY page_id LIMIT 1",
        &[("after", selected[0]["page_id"].as_str().unwrap())],
        &binding,
    );
    assert_eq!(selected.len(), 1);
    assert_eq!(next.len(), 1);
    assert_ne!(selected[0]["page_id"], next[0]["page_id"]);
    let listed = success(&home, &["ls", &database_id, "--limit", "1"]);
    assert_eq!(listed["scope"], "direct_data_source_pages");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["has_more"], true);
    let search = success(&home, &["search", "Batch twin"]);
    assert_eq!(search["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        run(&home, &["sql", "query", "DELETE FROM pages"])["ok"],
        false
    );
    verify_database_override(&client, &home);
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
        .query_read(
            Some(other_project),
            nodex_core_contracts::query::QueryRead::Query {
                query: nodex_core_contracts::sql::SqlQuery {
                    scope: nodex_core_contracts::sql::SqlScope {
                        database_id: None,
                        bindings: vec![nodex_core_contracts::sql::SqlBinding {
                            table: "tasks".into(),
                            data_source_id: source_id,
                        }],
                    },
                    sql: "SELECT * FROM tasks".into(),
                    parameters: Default::default(),
                },
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
        vec!["sql", "query", "SELECT :value", "--param", "value={"],
        vec!["page", "properties", "apply"],
        vec!["page", "create-batch"],
        vec![
            "block",
            "insert",
            "page",
            "--at",
            "end",
            "--block-json",
            "-",
        ],
        vec![
            "block",
            "update",
            "page",
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
    let page = PAGE_B;
    let initial = success(home, &["read", page]);
    let observation = sql_rows(
        home,
        "SELECT p.title_etag,d.nested_markdown,d.body_etag FROM pages p JOIN page_documents d USING(page_id) WHERE p.page_id=:id",
        &[("id", page)],
        &[],
    );
    assert_eq!(observation[0]["nested_markdown"], initial["content"]);
    assert_eq!(
        observation[0]["body_etag"],
        initial["validators"]["body_etag"]
    );
    let title_etag = observation[0]["title_etag"].as_str().unwrap();
    success(
        home,
        &[
            "page",
            "rename",
            page,
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
            page,
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
            page,
            "Should not rename",
            "--if-match",
            title_etag,
        ],
    );
    assert_eq!(stale["ok"], false);
    let after_title = success(home, &["read", page]);
    assert_eq!(after_title["content"], initial["content"]);
    let block = serde_json::json!({ "local_id": "first", "block_type": "paragraph", "props": {}, "content": { "kind": "value", "value": [{ "type": "text", "text": "Inserted block", "styles": {} }] }, "children": [] });
    let inserted = input(
        home,
        &["block", "insert", page, "--at", "end", "--block-json", "-"],
        &block,
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    let search = success(home, &["search", "Inserted block"]);
    assert_eq!(search["items"].as_array().unwrap().len(), 1);
    let hit = &search["items"][0];
    assert_eq!(hit["page_id"], page);
    assert_eq!(hit["title"], "Renamed Page");
    assert_eq!(hit["matches"].as_array().unwrap().len(), 1);
    assert_eq!(hit["matches"][0]["source"], "body");
    assert_eq!(hit["matches"][0]["text"], "Inserted block");
    assert_eq!(
        hit["matches"][0]["block_id"],
        inserted["result"]["affected"]["created_block_ids"][0]
    );

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
            page,
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
    let read = success(home, &["read", page]);
    assert!(read["content"].as_str().unwrap().contains("Updated block"));
    let stale_body = input_text(
        home,
        &[
            "page",
            "replace",
            page,
            "--if-match",
            after_title["validators"]["body_etag"].as_str().unwrap(),
        ],
        "Should not replace",
    );
    assert_eq!(stale_body["ok"], false);
    assert_eq!(success(home, &["read", page])["content"], read["content"]);
}

#[test]
fn sql_success_envelopes_freeze_batch_targets_and_preserve_value_revision_fences() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("profile");
    fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex")).with_file_name("nodex-core");
    let client =
        connect_or_launch(&home, "batch-selection-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let page = property_state(&home, PAGE_A);
    let source = page["data_source_id"].as_str().unwrap();
    let schema = source_description(&home, source);
    let configured = input(
        &home,
        &["data-source", "configure", source],
        &serde_json::json!({
            "if_schema_revision":schema["schema_revision"],
            "operations":[{"kind":"add_property","name":"Score","schema":{"kind":"number"}}]
        }),
    );
    assert_eq!(configured["ok"], true, "{configured}");
    let selected = run(
        &home,
        &[
            "sql",
            "query",
            "SELECT page_id, data_source_id, membership_revision, value_revisions FROM tasks",
            "--bind",
            &format!("tasks={source}"),
        ],
    );
    assert_eq!(selected["ok"], true, "{selected}");
    let prepared = input(
        &home,
        &[
            "page",
            "properties",
            "prepare-batch",
            "--selection",
            "-",
            "--set",
            r#"Score={"kind":"number","value":3}"#,
        ],
        &selected,
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(prepared["result"]["edits"].as_array().unwrap().len(), 1);
    let property_id = prepared["result"]["edits"][0]["address"]["property_id"]
        .as_str()
        .unwrap();
    let added = input(
        &home,
        &["page", "create-batch"],
        &serde_json::json!({
            "destination":{"kind":"data_source","data_source_id":source,"values":[]},
            "pages":[{"title_markdown":"Arrived after selection","nested_markdown":""}]
        }),
    );
    assert_eq!(added["ok"], true, "{added}");
    let applied = input(&home, &["page", "properties", "apply"], &prepared);
    assert_eq!(applied["ok"], true, "{applied}");
    let property = property_state(&home, PAGE_A);
    assert_eq!(property["values"][property_id].as_f64(), Some(3.0));
    let selected_after = success(
        &home,
        &[
            "sql",
            "query",
            "SELECT page_id, data_source_id, membership_revision, value_revisions FROM tasks",
            "--bind",
            &format!("tasks={source}"),
        ],
    );
    assert_eq!(selected_after["rows"].as_array().unwrap().len(), 2);
    let new_id = selected_after["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|row| (row[0] != PAGE_A).then(|| row[0].as_str().unwrap()))
        .unwrap();
    assert_eq!(
        property_state(&home, new_id)["values"][property_id],
        Value::Null
    );
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            "--property",
            property_id,
            "--number",
            "5",
            "--if-revision",
            &property["value_revisions"][property_id].to_string(),
        ],
    );
    let stale = input(
        &home,
        &[
            "page",
            "properties",
            "prepare-batch",
            "--selection",
            "-",
            "--set",
            r#"Score={"kind":"number","value":4}"#,
        ],
        &selected,
    );
    assert_eq!(stale["ok"], true, "{stale}");
    assert_eq!(
        stale["result"]["edits"][0]["edit"]["expected_value_revision"],
        0
    );
    assert_eq!(
        stale["result"]["edits"][0]["expected_membership_revision"],
        1
    );
    let rejected = input(&home, &["page", "properties", "apply"], &stale);
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert_eq!(
        property_state(&home, PAGE_A)["values"][property_id].as_f64(),
        Some(5.0)
    );
}

fn verify_database_override(client: &CoreClient, home: &Path) {
    let database_id = "019b1000-1000-7000-8000-000000000004";
    let source_id = "019b1000-1000-7000-8000-000000000005";
    let view_id = "019b1000-1000-7000-8000-000000000006";
    let created = client
        .library_apply(
            Some(PROJECT),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "cli-data:alternate-database".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreateDatabase {
                    database_id: database_id.to_owned(),
                    data_source_id: source_id.to_owned(),
                    view_id: view_id.to_owned(),
                    name: "Alternate".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)), "{created:?}");
    let sources = sql_rows(
        home,
        "SELECT * FROM data_sources WHERE database_id=:id",
        &[("id", database_id)],
        &[],
    );
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["data_source_id"], source_id);
    let binding = format!("tasks={source_id}");
    let schema = success(
        home,
        &[
            "--database",
            "Alternate",
            "sql",
            "schema",
            "tasks",
            "--bind",
            &binding,
        ],
    );
    assert_eq!(schema["tables"][0]["data_source_id"], source_id);
    assert!(sql_rows(home, "SELECT page_id FROM tasks", &[], &[binding]).is_empty());
    let views = sql_rows(
        home,
        "SELECT view_id FROM views WHERE database_id=:id",
        &[("id", database_id)],
        &[],
    );
    assert_eq!(views[0]["view_id"], view_id);
    assert!(
        sql_rows(
            home,
            "SELECT page_id FROM view_rows(:id)",
            &[("id", view_id)],
            &[]
        )
        .is_empty()
    );
    // A discovery hint never narrows the global Pages relation.
    let pages = success(
        home,
        &[
            "--database",
            "Alternate",
            "sql",
            "query",
            "SELECT page_id FROM pages",
        ],
    );
    assert!(
        pages["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row[0] == PAGE_A)
    );
}

#[test]
fn exact_patch_receipt_retains_block_references_and_retries_without_recreating_content() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("profile");
    fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex")).with_file_name("nodex-core");
    let client =
        connect_or_launch(&home, "patch-identity-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let body = "# Release\nRelease date: Friday.\n- Keep backups\n\t- Verify restore\nTracking: HARBOR-42.\n";
    let seeded = input_text(&home, &["page", "insert", PAGE_A, "--at", "end"], body);
    assert_eq!(seeded["ok"], true, "{seeded}");
    let before = success(&home, &["read", PAGE_A]);
    let properties = property_state(&home, PAGE_A);
    let hit = success(&home, &["search", "Release date: Friday"]);
    let date_id = hit["items"][0]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item["source"] == "body"
                && item["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Friday"))
        })
        .unwrap()["block_id"]
        .clone();
    let patch = format!(
        "*** Begin Patch\n*** Update Page: {PAGE_A}\n@@\n-Release date: Friday.\n+Release date: Monday.\n*** End Patch\n"
    );
    let args = ["patch", "--idempotency-key", "release-date-change"];
    let committed = input_text(&home, &args, &patch);
    assert_eq!(committed["ok"], true, "{committed}");
    validate_result(&args, &committed["result"]);
    assert_eq!(
        committed["result"]["affected"],
        serde_json::json!({
            "created_block_ids": [], "deleted_block_ids": [], "moved_block_ids": [],
            "updated_block_ids": [date_id], "title_changed": false,
        })
    );
    let after = success(&home, &["read", PAGE_A]);
    assert_eq!(
        after["content"],
        before["content"]
            .as_str()
            .unwrap()
            .replace("Friday", "Monday")
    );
    assert_eq!(property_state(&home, PAGE_A), properties);
    let retry = input_text(&home, &args, &patch);
    assert_eq!(retry["ok"], true, "{retry}");
    assert_eq!(retry["result"]["duplicate"], true);
    assert_eq!(retry["result"]["affected"], committed["result"]["affected"]);
    assert_eq!(retry["result"]["head_seq"], committed["result"]["head_seq"]);
    let hit = success(&home, &["search", "Release date: Monday"]);
    assert_eq!(hit["items"][0]["matches"][0]["block_id"], date_id);
}
