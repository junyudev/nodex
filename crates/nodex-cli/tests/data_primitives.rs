//! Run after `cargo build -p nodex-core-server`; the workspace test gate builds both binaries.

mod support;

use support::cli_command;

use std::fs;
use std::path::Path;
use std::process::Command;

use nodex_core_contracts::library::{LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryWriteParent};
use nodex_core_contracts::workspace::{
    PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspacePageCreationTarget,
};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use serde_json::Value;

const PROJECT: &str = "019b1000-1000-7000-8000-000000000001";
const PAGE_A: &str = "019b1000-1000-7000-8000-000000000002";
const PAGE_A_DOCUMENT: &str = "019b1000-1000-7000-8000-0000000000a2";
const PAGE_B: &str = "019b1000-1000-7000-8000-000000000003";

#[test]
fn automations_preserve_revisions_and_manual_dispatch_identity() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client =
        connect_or_launch(&home, "automations-cli-integration", Some(&core_binary)).unwrap();
    let _core = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let path = directory.path().join("automation.json");
    let mut definition = serde_json::json!({
        "kind": "cron",
        "name": "Review releases",
        "condition_text": "Every day",
        "prompt": "Review the latest releases",
        "rrule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        "timezone": "Asia/Singapore",
        "mode": "dry_run",
        "project_id": null,
        "execution_environment": "local",
        "backend_binding": {"kind": "codex"},
        "model": "gpt-6"
    });
    fs::write(&path, serde_json::to_vec(&definition).unwrap()).unwrap();
    let create = [
        "automations",
        "create",
        "--file",
        path.to_str().unwrap(),
        "--idempotency-key",
        "create-automation",
    ];
    let created = success(&home, &create);
    let id = created["item"]["automation_id"].as_str().unwrap();
    assert_eq!(created["item"]["mode"], "dry_run");
    assert_eq!(
        created["item"]["typed_condition"]["timezone"],
        "Asia/Singapore"
    );
    let replay = success(&home, &create);
    assert_eq!(replay["item"], created["item"]);
    assert_eq!(replay["duplicate"], true);
    let listed = success(
        &home,
        &["automations", "list", "--query", "Review releases"],
    );
    assert_eq!(listed["items"][0]["automation_id"], id);
    assert_eq!(
        success(&home, &["automations", "show", id]),
        created["item"]
    );

    let revision = created["item"]["automation_revision"]
        .as_i64()
        .unwrap()
        .to_string();
    definition["prompt"] = serde_json::json!("Review releases and record breaking changes");
    fs::write(&path, serde_json::to_vec(&definition).unwrap()).unwrap();
    let updated = success(
        &home,
        &[
            "automations",
            "update",
            id,
            "--if-revision",
            &revision,
            "--status",
            "active",
            "--file",
            path.to_str().unwrap(),
        ],
    );
    assert_eq!(updated["item"]["prompt"], definition["prompt"]);
    assert_eq!(
        run(
            &home,
            &["automations", "pause", id, "--if-revision", &revision]
        )["ok"],
        false
    );
    let revision = updated["item"]["automation_revision"]
        .as_i64()
        .unwrap()
        .to_string();
    let paused = success(
        &home,
        &["automations", "pause", id, "--if-revision", &revision],
    );
    assert_eq!(paused["item"]["status"], "PAUSED");
    let revision = paused["item"]["automation_revision"]
        .as_i64()
        .unwrap()
        .to_string();
    let resumed = success(
        &home,
        &["automations", "resume", id, "--if-revision", &revision],
    );
    assert_eq!(resumed["item"]["status"], "ACTIVE");

    let dispatch = [
        "automations",
        "run",
        id,
        "--idempotency-key",
        "manual-automation-run",
    ];
    let dispatched = success(&home, &dispatch);
    let replay = success(&home, &dispatch);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(replay["item"], dispatched["item"]);
    let revision = dispatched["item"]["automation_revision"]
        .as_i64()
        .unwrap()
        .to_string();
    success(
        &home,
        &["automations", "delete", id, "--if-revision", &revision],
    );
    assert_eq!(
        success(&home, &["automations", "show", id])["status"],
        "DELETED"
    );
    assert!(
        success(&home, &["automations", "list"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn members_and_page_assignments_use_typed_identity_and_revision_fences() {
    use nodex_core_contracts::library::{LibraryRead, LibraryReadValue};
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "members-cli-integration", Some(&core_binary)).unwrap();
    let _core = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let me = success(&home, &["members", "me"]);
    assert_eq!(
        success(&home, &["members", "list"]),
        serde_json::json!([me.clone()])
    );
    let work = || {
        let ResponseEnvelope::Ok(result) = client
            .library_read(
                Some(PROJECT),
                LibraryRead::PageDetail {
                    page_id: PAGE_A.into(),
                },
            )
            .unwrap()
            .0
        else {
            panic!("Page detail");
        };
        let LibraryReadValue::PageDetail { value } = result.value else {
            panic!("Page detail");
        };
        value
            .intrinsic_properties
            .into_iter()
            .find(|property| property.key == "work")
            .unwrap()
    };
    assert_eq!(work().value["owner"], me["id"]);
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            "--owner",
            "me",
            "--assignee",
            "me",
            "--if-revision",
            "1",
        ],
    );
    assert_eq!(
        work().value["assignee"],
        serde_json::json!({"kind":"member","member_id":me["id"]})
    );
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            "--assignee",
            "agent:codex/model/high",
            "--if-revision",
            "2",
        ],
    );
    assert_eq!(
        work().value["assignee"],
        serde_json::json!({"kind":"agent","instance_id":"codex","model":"model","effort":"high"})
    );
    assert_eq!(work().value["auto_start"], false);
    assert_eq!(
        run(
            &home,
            &[
                "page",
                "properties",
                "set",
                PAGE_A,
                "--assignee",
                "none",
                "--if-revision",
                "2"
            ]
        )["ok"],
        false
    );
    assert_eq!(work().revision, 3);
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            "--assignee",
            "none",
            "--if-revision",
            "3",
        ],
    );
    assert!(work().value["assignee"].is_null());
}

#[test]
fn execution_holds_round_trip_by_scope_and_replay_the_persons_operation() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "holds-cli-integration", Some(&core_binary)).unwrap();
    let _core = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let first = success(
        &home,
        &[
            "work",
            "pause",
            "--page",
            PAGE_A,
            "--idempotency-key",
            "pause-page",
        ],
    );
    assert_eq!(first["paused"], true);
    assert_eq!(first["duplicate"], false);
    assert_eq!(
        success(
            &home,
            &[
                "work",
                "pause",
                "--page",
                PAGE_A,
                "--idempotency-key",
                "pause-page"
            ]
        )["duplicate"],
        true
    );
    success(&home, &["work", "pause", "--project", PROJECT]);
    success(&home, &["work", "pause", "--space"]);
    assert_eq!(
        success(&home, &["work", "holds"]).as_array().unwrap().len(),
        3
    );
    success(&home, &["work", "resume", "--page", PAGE_A]);
    let holds = success(&home, &["work", "holds"]);
    assert_eq!(holds.as_array().unwrap().len(), 2);
    assert!(
        holds
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["scope"]["kind"] != "page")
    );
    success(&home, &["work", "resume", "--project", PROJECT]);
    success(&home, &["work", "resume", "--space"]);
    assert!(
        success(&home, &["work", "holds"])
            .as_array()
            .unwrap()
            .is_empty()
    );
}

struct CoreGuard(u32);
impl Drop for CoreGuard {
    fn drop(&mut self) {
        let _ = nodex_platform::process::terminate_process(self.0);
    }
}

fn run(home: &Path, args: &[&str]) -> Value {
    let output = cli_command()
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
    let output = cli_command()
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
    nodex_platform::private_fs::create_dir(&source).unwrap();
    let created = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "cli-data:project".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreateProject {
                    project_id: PROJECT.to_owned(),
                    name: "Data primitives CLI".to_owned(),
                    description: String::new(),
                    appearance: None,
                    source_roots: vec![source.to_string_lossy().into_owned()],
                    page_key_prefix: None,
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)));
    let created = client
        .workspace_apply(
            None,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "cli-data:page-a".to_owned(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: ProjectWorkspaceIntent::CreatePageFor {
                    target: ProjectWorkspacePageCreationTarget::Project {
                        project_id: PROJECT.to_owned(),
                    },
                    page_id: PAGE_A.to_owned(),
                    document_id: PAGE_A_DOCUMENT.to_owned(),
                    title: "Page A".to_owned(),
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
    let mut process = cli_command()
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
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
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
    for assignment in ["p_clinote0=Readable text", "p_clinum00=-12.5"] {
        success(
            &home,
            &[
                "page",
                "properties",
                "set",
                PAGE_A,
                "--set",
                assignment,
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
        .find(|option| option["name"] == "In Review")
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
            "--set",
            &format!("status={option}"),
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
    let to = format!("data_source:{source_id}");
    let empty_group = run(
        &home,
        &[
            "page",
            "create",
            "--parent",
            &to,
            "--title",
            "No stage",
            "--empty",
            "--unassigned",
        ],
    );
    assert_eq!(empty_group["ok"], false, "{empty_group}");
    let message = empty_group["error"]["message"].as_str().unwrap();
    assert!(message.contains("Status (status)"), "{message}");
    assert!(message.contains("triage (Triage)"), "{message}");
    let moved = success(
        &home,
        &[
            "page",
            "move",
            PAGE_A,
            "--to",
            &to,
            "--if-match",
            prepared_move["validators"]["move_etag"].as_str().unwrap(),
        ],
    );
    assert_eq!(
        moved["status"],
        serde_json::json!({"option_id":"review","label":"In Review"})
    );
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
    let batch = serde_json::json!({ "destination": { "kind": "data_source", "data_source_id": source_id, "values": [] }, "pages": [ { "title_markdown": "Batch twin", "markdown": "One" }, { "title_markdown": "Batch twin", "markdown": "Two" } ] });
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
        assert_eq!(
            page["status"],
            serde_json::json!({"option_id":"triage","label":"Triage"})
        );
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
    let cross_project = client
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
    let ResponseEnvelope::Ok(snapshot) = cross_project.0 else {
        panic!("same Profile query: {cross_project:?}")
    };
    let nodex_core_contracts::query::QueryReadValue::Query { value } = snapshot.value else {
        panic!("SQL rows")
    };
    assert_eq!(value.returned_count, 3);
}

#[test]
fn malformed_structured_inputs_fail_before_resolving_or_launching_a_profile() {
    use std::io::Write;
    use std::process::Stdio;
    let directory = nodex_platform::test_support::tempdir().unwrap();
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
        let mut process = cli_command()
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
        "SELECT p.title_etag,d.markdown,d.body_etag FROM pages p JOIN page_documents d USING(page_id) WHERE p.page_id=:id",
        &[("id", page)],
        &[],
    );
    assert_eq!(observation[0]["markdown"], initial["content"]);
    assert_eq!(
        observation[0]["body_etag"],
        initial["validators"]["body_etag"]
    );
    let title_etag = observation[0]["title_etag"].as_str().unwrap();
    let swapped = run(
        home,
        &[
            "page",
            "rename",
            "Renamed Page",
            page,
            "--if-match",
            title_etag,
        ],
    );
    assert_eq!(swapped["error"]["code"], "SCOPE_NOT_FOUND");
    assert!(
        swapped["error"]["message"]
            .as_str()
            .unwrap()
            .contains("arguments look swapped")
    );
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
    let retry = cli_command()
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
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
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
            "pages":[{"title_markdown":"Arrived after selection","markdown":""}]
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
            "--set",
            &format!("{property_id}=5"),
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
fn one_markdown_language_covers_page_insert_and_batch_drafts() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "gfm-body-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);

    let inserted = input_text(
        &home,
        &["page", "insert", PAGE_A, "--at", "end"],
        "- Plan\n  - nested\n\n> [!NOTE]\n> Rollback is a flag flip.",
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    assert_eq!(
        success(&home, &["read", PAGE_A])["content"],
        "- Plan\n  - nested\n\n> [!NOTE]\n> Rollback is a flag flip.\n"
    );

    let batch = |page: Value| {
        serde_json::json!({
            "destination": { "kind": "page", "page_id": PAGE_A, "at": null },
            "pages": [page],
        })
    };
    let created = input(
        &home,
        &["page", "create-batch"],
        &batch(
            serde_json::json!({ "title_markdown": "Steps", "markdown": "## Steps\n\n1. Export\n2. Import" }),
        ),
    );
    assert_eq!(created["ok"], true, "{created}");
    let page_id = created["result"]["pages"][0]["page_id"].as_str().unwrap();
    assert_eq!(
        success(&home, &["read", page_id])["content"],
        "## Steps\n\n1. Export\n2. Import\n"
    );
    let ambiguous = input(
        &home,
        &["page", "create-batch"],
        &batch(serde_json::json!({ "title_markdown": "Both", "markdown": "One", "gfm": "One" })),
    );
    assert_eq!(ambiguous["ok"], false, "{ambiguous}");
}

#[test]
fn exact_patch_receipt_retains_block_references_and_retries_without_recreating_content() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
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

    let prepared = success(&home, &["page", "prepare", PAGE_A, "--operation", "delete"]);
    success(
        &home,
        &[
            "page",
            "delete",
            PAGE_A,
            "--if-match",
            prepared["validators"]["page_etag"].as_str().unwrap(),
        ],
    );
    let retry = input_text(&home, &args, &patch);
    assert_eq!(retry["ok"], true, "{retry}");
    assert_eq!(retry["result"]["duplicate"], true);
    assert_eq!(
        retry["result"]["operation_id"],
        committed["result"]["operation_id"]
    );
}

#[test]
fn explicit_alternate_profile_ignores_inherited_agent_markers() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "marker-isolation", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    for use_flag in [false, true] {
        let mut cmd = cli_command();
        cmd.args(["--json", "context"])
            .env("NODEX_AGENT_SHELL", "1")
            .env(
                "NODEX_AGENT_PROFILE_HOME",
                directory.path().join("outer-profile"),
            )
            .env("NODEX_AGENT_ENDPOINT", "unused")
            .env("NODEX_AGENT_CREDENTIAL", "unused");
        if use_flag {
            cmd.args(["--home"]).arg(&home);
        } else {
            cmd.env("NODEX_HOME", &home);
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let json: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(json["result"]["actor"]["type"], "member");
        assert_eq!(
            json["result"]["profile"]["source"],
            if use_flag { "flag" } else { "environment" }
        );
    }
    let output = cli_command()
        .args(["--json", "context", "--home"])
        .arg(&home)
        .env("NODEX_AGENT_PROFILE_HOME", &home)
        .env("NODEX_AGENT_SHELL", "1")
        .output()
        .unwrap();
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["error"]["code"], "AGENT_BINDING_MALFORMED");
}

#[test]
fn retry_key_requires_a_value_and_accepts_hyphens_with_equals() {
    use clap::Parser as _;
    use nodex_cli::cli::Cli;
    assert!(
        Cli::try_parse_from([
            "nodex",
            "inbox",
            "send",
            "hello",
            "--idempotency-key",
            "--json"
        ])
        .is_err()
    );
    let parsed = Cli::try_parse_from([
        "nodex",
        "inbox",
        "send",
        "hello",
        "--idempotency-key=--json",
    ])
    .unwrap();
    assert!(!parsed.json);
}

#[test]
fn opaque_retry_keys_bind_property_and_backup_arguments() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "opaque-retry-keys", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);

    let page = property_state(&home, PAGE_A);
    let source = page["data_source_id"].as_str().unwrap();
    let schema = source_description(&home, source);
    let configured = input(
        &home,
        &["data-source", "configure", source],
        &serde_json::json!({
            "if_schema_revision": schema["schema_revision"],
            "operations": [{"kind":"add_property","name":"Score","schema":{"kind":"number"}}]
        }),
    );
    assert_eq!(configured["ok"], true, "{configured}");

    for (index, key) in [
        "triage1111-done-first",
        "550e8400-e29b-41d4-a716-446655440000",
        "ppk-triage-2026-11-11-backup",
    ]
    .into_iter()
    .enumerate()
    {
        let selection = run(
            &home,
            &[
                "sql",
                "query",
                "SELECT page_id, data_source_id, membership_revision, value_revisions FROM tasks",
                "--bind",
                &format!("tasks={source}"),
            ],
        );
        let prepared = input(
            &home,
            &[
                "page",
                "properties",
                "prepare-batch",
                "--selection",
                "-",
                "--set",
                &format!(r#"Score={{"kind":"number","value":{index}}}"#),
            ],
            &selection,
        );
        assert_eq!(prepared["ok"], true, "{prepared}");
        let args = [
            "page",
            "properties",
            "apply",
            "--input",
            "-",
            "--idempotency-key",
            key,
        ];
        let applied = input(&home, &args, &prepared);
        assert_eq!(applied["ok"], true, "{applied}");
        let replay = input(&home, &args, &prepared);
        assert_eq!(replay["ok"], true, "{replay}");
        assert_eq!(replay["result"]["status"], "duplicate");
        assert_eq!(applied["result"]["pages"], replay["result"]["pages"]);
        let mut changed_input = prepared.clone();
        changed_input["result"]["edits"][0]["edit"]["value"]["value"] = serde_json::json!(99);
        let changed = input(&home, &args, &changed_input);
        assert_eq!(
            changed["error"]["code"], "IDEMPOTENCY_KEY_REUSED",
            "{changed}"
        );

        let backup = [
            "backup",
            "create",
            "--label",
            "fixture",
            "--idempotency-key",
            key,
        ];
        let created = success(&home, &backup);
        let retried = success(&home, &backup);
        assert_eq!(created["outcome"], retried["outcome"]);
        assert_eq!(retried["receipt"]["duplicate"], true);
        let changed = run(
            &home,
            &[
                "backup",
                "create",
                "--label",
                "other",
                "--idempotency-key",
                key,
            ],
        );
        assert_eq!(changed["error"]["code"], "IDEMPOTENCY_KEY_REUSED");
        assert_eq!(changed["error"]["retryable"], false);
        assert_eq!(
            changed["error"]["recovery"]["kind"],
            "use_new_idempotency_key"
        );
    }

    let help = cli_command()
        .args(["backup", "create", "--help-schema", "error"])
        .env("NODEX_HOME", &home)
        .output()
        .unwrap();
    assert!(help.status.success());
    let help: Value = serde_json::from_slice(&help.stdout).unwrap();
    assert!(
        help["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|code| code == "IDEMPOTENCY_WINDOW_EXPIRED")
    );
    assert!(
        help["errorSchema"]
            .to_string()
            .contains("IDEMPOTENCY_WINDOW_EXPIRED")
    );
}

#[test]
fn retry_replays_before_resolving_changed_page_state() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "retry-page-state", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let property = [
        "page",
        "properties",
        "set",
        PAGE_A,
        "--assignee",
        "me",
        "--idempotency-key",
        "assign",
    ];
    let first = success(&home, &property);
    let replay = success(&home, &property);
    assert_eq!(replay["receipt"]["duplicate"], true);
    assert_eq!(first["outcome"], replay["outcome"]);

    let read = success(&home, &["read", PAGE_A]);
    let title_etag = read["validators"]["title_etag"].as_str().unwrap();
    let rename = [
        "page",
        "rename",
        "Page A",
        "Renamed",
        "--if-match",
        title_etag,
        "--idempotency-key",
        "rename-by-title",
    ];
    let first = success(&home, &rename);
    let old_pid = client.handshake.generation.pid;
    client.shutdown().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while home.join("run/core/core.json").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "Core runtime descriptor was not removed"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let reopened =
        connect_or_launch(&home, "retry-page-state-reopened", Some(&core_binary)).unwrap();
    let _reopened_guard = CoreGuard(reopened.handshake.generation.pid);
    assert_ne!(reopened.handshake.generation.pid, old_pid);
    let replay = success(&home, &rename);
    assert_eq!(replay["duplicate"], true);
    assert_eq!(first["page_id"], replay["page_id"]);
    assert_eq!(first["head_seq"], replay["head_seq"]);
}

#[test]
fn machine_help_examples_use_admissible_retry_keys() {
    use nodex_cli::agent_interface::{MachineHelpDocument, machine_help};
    use nodex_core_contracts::workspace::AppToolOperationRequest;

    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "help-retry-keys", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    let mut commands = vec!["nodex".to_owned()];
    let mut tested = 0;
    while let Some(command) = commands.pop() {
        let args = command
            .split_whitespace()
            .chain(["--help"])
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        match machine_help(&args).unwrap() {
            MachineHelpDocument::Index(index) => {
                commands.extend(index.commands.into_iter().map(|item| item.command));
            }
            MachineHelpDocument::Command(help) => {
                for example in help.examples {
                    let words = example.split_whitespace().collect::<Vec<_>>();
                    for pair in words
                        .windows(2)
                        .filter(|pair| pair[0] == "--idempotency-key")
                    {
                        let identity = client
                            .admit_app_tool_operation(
                                None,
                                AppToolOperationRequest {
                                    provenance: None,
                                    replay_module: None,
                                    tool_name: command.trim_start_matches("nodex ").into(),
                                    idempotency_key: pair[1].into(),
                                    request_hash: "a".repeat(64),
                                },
                            )
                            .unwrap_or_else(|error| {
                                panic!("{command} example key {:?}: {error}", pair[1])
                            });
                        assert!(identity.operation_id.starts_with("nodexop:v1:"));
                        tested += 1;
                    }
                }
            }
            MachineHelpDocument::PayloadNames(_) | MachineHelpDocument::Payload(_) => {
                panic!("{command} --help returned a payload schema");
            }
        }
    }
    assert!(tested > 0);
}

#[cfg(unix)]
/// Execute the published POSIX shell example, substituting only fixture observations.
fn help_example(home: &Path, path: &[&str], index: usize, substitutions: &[(&str, &str)]) -> Value {
    let args = std::iter::once("nodex")
        .chain(path.iter().copied())
        .chain(["--help"])
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    let nodex_cli::agent_interface::MachineHelpDocument::Command(help) =
        nodex_cli::agent_interface::machine_help(&args).unwrap()
    else {
        panic!("expected command guide");
    };
    let mut script = help.examples[index].to_owned();
    for (from, to) in substitutions {
        script = script.replace(from, to);
    }
    let executable = env!("CARGO_BIN_EXE_nodex").replace('\'', "'\\''");
    script = script.replace("nodex ", &format!("'{executable}' --project {PROJECT} "));
    let output = Command::new("/bin/sh")
        .args(["-eu", "-c", &script])
        .env("NODEX_HOME", home)
        .current_dir(home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{script}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true, "{value}");
    value["result"].clone()
}

#[cfg(unix)]
#[test]
fn published_write_examples_preserve_existing_content_and_definitions() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "help-examples", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let before_page = success(&home, &["read", PAGE_A]);
    let source = property_state(&home, PAGE_A)["data_source_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let definitions = sql_rows(
        &home,
        "SELECT * FROM properties WHERE data_source_id=:id ORDER BY property_id",
        &[("id", &source)],
        &[],
    );
    let views = sql_rows(
        &home,
        "SELECT * FROM views WHERE data_source_id=:id ORDER BY view_id",
        &[("id", &source)],
        &[],
    );
    let revision = source_description(&home, &source)["schema_revision"].to_string();
    let observed_revision = format!("\"if_schema_revision\":{revision}");
    let bindings = [
        ("source-id", source.as_str()),
        ("\"if_schema_revision\":1", observed_revision.as_str()),
    ];
    help_example(&home, &["data-source", "configure"], 1, &bindings);
    let after_definitions = sql_rows(
        &home,
        "SELECT * FROM properties WHERE data_source_id=:id ORDER BY property_id",
        &[("id", &source)],
        &[],
    );
    assert_eq!(after_definitions.len(), definitions.len() + 1);
    for definition in &definitions {
        assert!(after_definitions.contains(definition));
    }
    let risk = after_definitions
        .iter()
        .find(|row| row["name"] == "Risk note")
        .unwrap();
    let property = risk["property_id"].as_str().unwrap();
    assert_eq!(
        sql_rows(
            &home,
            "SELECT * FROM views WHERE data_source_id=:id ORDER BY view_id",
            &[("id", &source)],
            &[]
        ),
        views
    );
    assert_eq!(
        success(&home, &["read", PAGE_A])["content"],
        before_page["content"]
    );
    help_example(
        &home,
        &["page", "properties", "apply"],
        1,
        &[
            ("source-id", &source),
            ("page-id", PAGE_A),
            ("property-id", property),
        ],
    );
    assert_eq!(
        property_state(&home, PAGE_A)["values"][property],
        "Needs review"
    );

    let member = success(
        &home,
        &[
            "page",
            "create",
            "--parent",
            &format!("data_source:{source}"),
            "--title",
            "Release plan",
            "--empty",
        ],
    );
    let member_id = member["page_id"].as_str().unwrap();
    help_example(
        &home,
        &["page", "properties", "prepare-batch"],
        1,
        &[("source-id", &source)],
    );
    assert_eq!(
        property_state(&home, member_id)["values"][property],
        "Needs review"
    );
    assert_eq!(
        property_state(&home, PAGE_A)["values"][property],
        "Needs review"
    );

    let revision = source_description(&home, &source)["schema_revision"].to_string();
    let observed_revision = format!("\"if_schema_revision\":{revision}");
    help_example(
        &home,
        &["data-source", "configure"],
        2,
        &[
            ("source-id", &source),
            ("\"if_schema_revision\":1", &observed_revision),
        ],
    );
    let after_views = sql_rows(
        &home,
        "SELECT * FROM views WHERE data_source_id=:id ORDER BY view_id",
        &[("id", &source)],
        &[],
    );
    assert_eq!(after_views.len(), views.len() + 1);
    for view in views {
        assert!(after_views.contains(&view));
    }
    assert!(
        after_views
            .iter()
            .any(|view| view["name"] == "Task list" && view["layout"] == "list")
    );

    let batch = help_example(&home, &["page", "create-batch"], 1, &[]);
    let pages = batch["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    let page = pages[0]["page_id"].as_str().unwrap();
    assert_eq!(
        success(&home, &["read", page])["content"],
        "Release date: Friday.\n"
    );
    help_example(&home, &["patch"], 1, &[("page-id", page)]);
    assert_eq!(
        success(&home, &["read", page])["content"],
        "Release date: Monday.\n"
    );
    help_example(&home, &["page", "insert"], 1, &[("page-id", page)]);
    let after_insert = success(&home, &["read", page]);
    assert_eq!(
        after_insert["content"],
        "Release date: Monday.\n\n## Next steps\n\nFinish the release checks.\n"
    );
    let block = help_example(&home, &["block", "insert"], 1, &[("page-id", page)]);
    let block_id = block["affected"]["created_block_ids"][0].as_str().unwrap();
    let etag = block["etags"]["blocks"][block_id]["update"]
        .as_str()
        .unwrap();
    help_example(
        &home,
        &["block", "update"],
        1,
        &[
            ("page-id", page),
            ("block-id", block_id),
            ("block-etag", etag),
        ],
    );
    assert_eq!(
        success(&home, &["read", page])["content"],
        "Release date: Monday.\n\n## Next steps\n\nFinish the release checks.\n\nReview complete.\n"
    );
    let created = help_example(&home, &["page", "create"], 0, &[("source-id", &source)]);
    let created_id = created["page_id"].as_str().unwrap();
    help_example(
        &home,
        &["page", "properties", "set"],
        0,
        &[("NODEX-4", PAGE_A), ("NODEX-8", created_id)],
    );
    assert_eq!(
        property_state(&home, created_id)["values"]["status"],
        "done"
    );
    let observed = success(&home, &["read", created_id]);
    help_example(
        &home,
        &["page", "replace"],
        0,
        &[
            ("page-id", created_id),
            (
                "body-etag",
                observed["validators"]["body_etag"].as_str().unwrap(),
            ),
        ],
    );
    let move_etag = help_example(&home, &["page", "prepare"], 0, &[("page-id", created_id)]);
    success(
        &home,
        &[
            "page",
            "move",
            created_id,
            "--to",
            "library",
            "--if-match",
            move_etag["validators"]["move_etag"].as_str().unwrap(),
        ],
    );
    let moved = help_example(
        &home,
        &["page", "move"],
        0,
        &[("parent-page-id", PAGE_B), ("page-id", created_id)],
    );
    assert_eq!(
        moved["affected"]["location"]["document_id"],
        "document:cli-b"
    );
    let copy = help_example(&home, &["page", "duplicate"], 0, &[("page-id", created_id)]);
    assert_eq!(
        success(&home, &["read", copy["page_id"].as_str().unwrap()])["content"],
        "## Updated plan\n\nReview the proposal.\n"
    );
    assert_eq!(
        success(&home, &["read", PAGE_A])["content"],
        before_page["content"]
    );
}

#[cfg(unix)]
#[test]
fn saved_filter_example_and_updates_return_exact_rows_and_preserve_unrelated_state() {
    use serde_json::json;
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "cli-view-filter", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let properties = property_state(&home, PAGE_A);
    let source = properties["data_source_id"].as_str().unwrap();
    success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            "--set",
            "status=review",
            "--if-revision",
            &properties["value_revisions"]["status"].to_string(),
        ],
    );
    let control = success(
        &home,
        &[
            "page",
            "create",
            "--parent",
            &format!("data_source:{source}"),
            "--title",
            "Not in review",
            "--empty",
        ],
    );
    let control_id = control["page_id"].as_str().unwrap();
    let before_values = property_state(&home, PAGE_A);
    let before_body = success(&home, &["read", PAGE_A]);
    let original_views = sql_rows(&home, "SELECT * FROM views ORDER BY view_id", &[], &[]);
    let revision = source_description(&home, source)["schema_revision"].to_string();
    help_example(
        &home,
        &["data-source", "configure"],
        3,
        &[
            ("source-id", source),
            (
                "\"if_schema_revision\":1",
                &format!("\"if_schema_revision\":{revision}"),
            ),
        ],
    );
    let get_view = || {
        sql_rows(
            &home,
            "SELECT * FROM views WHERE name='Review queue'",
            &[],
            &[],
        )
        .remove(0)
    };
    let view = get_view();
    let view_id = view["view_id"].as_str().unwrap();
    let rows = || {
        sql_rows(
            &home,
            "SELECT DISTINCT page_id FROM view_rows(:view) ORDER BY page_id",
            &[("view", view_id)],
            &[],
        )
    };
    assert_eq!(rows(), vec![json!({"page_id":PAGE_A})]);
    let configure = |operations: Value, schema_revision: Value| {
        input(
            &home,
            &["data-source", "configure", source],
            &json!({"if_schema_revision":schema_revision,"operations":operations}),
        )
    };
    let revision = || source_description(&home, source)["schema_revision"].clone();
    // An omitted filter retains both its definition and results while changing another field.
    let update = configure(
        json!([{"kind":"update_view","view":view_id,"if_revision":view["revision"],"sorts":[{"property":"title","direction":"desc"}]}]),
        revision(),
    );
    assert_eq!(update["ok"], true, "{update}");
    let sorted = get_view();
    let old_config: Value = serde_json::from_str(view["config_json"].as_str().unwrap()).unwrap();
    let sorted_config: Value =
        serde_json::from_str(sorted["config_json"].as_str().unwrap()).unwrap();
    assert_eq!(
        old_config["rules"]["advancedFilter"],
        sorted_config["rules"]["advancedFilter"]
    );
    assert_eq!(rows(), vec![json!({"page_id":PAGE_A})]);
    // Boolean groups use the same saved View query execution as the desktop.
    let alternatives = configure(
        json!([{"kind":"update_view","view":view_id,"if_revision":sorted["revision"],"filter":{
            "kind":"group","operator":"or","children":[
                {"kind":"group","operator":"and","children":[
                    {"kind":"clause","propertyId":"status","operator":"select_is","value":"review"},
                    {"kind":"clause","propertyId":"Status","operator":"select_is_not","value":"done"}
                ]},
                {"kind":"clause","propertyId":"status","operator":"select_is","value":"triage"}
            ]
        }}]),
        revision(),
    );
    assert_eq!(alternatives["ok"], true, "{alternatives}");
    let mut expected = vec![json!({"page_id":PAGE_A}), json!({"page_id":control_id})];
    expected.sort_by_key(|row| row["page_id"].as_str().unwrap().to_owned());
    assert_eq!(rows(), expected);
    let before_conflicts = get_view();
    for (case, schema_revision, view_revision) in [
        ("view", revision(), view["revision"].clone()),
        (
            "schema",
            json!(revision().as_i64().unwrap() + 1),
            before_conflicts["revision"].clone(),
        ),
    ] {
        let rejected = configure(
            json!([{"kind":"update_view","view":view_id,"if_revision":view_revision,"filter":null}]),
            schema_revision,
        );
        assert_eq!(rejected["ok"], false, "{case}: {rejected}");
        assert_eq!(get_view(), before_conflicts);
    }
    let cleared = configure(
        json!([{"kind":"update_view","view":view_id,"if_revision":before_conflicts["revision"],"filter":null}]),
        revision(),
    );
    assert_eq!(cleared["ok"], true, "{cleared}");
    let after = get_view();
    let config: Value = serde_json::from_str(after["config_json"].as_str().unwrap()).unwrap();
    assert!(config["rules"]["advancedFilter"].is_null());
    assert_eq!(config["rules"]["propertyFilters"], json!([]));
    assert_eq!(config["rules"]["sorts"], sorted_config["rules"]["sorts"]);
    assert_eq!(rows(), expected);
    let final_views = sql_rows(&home, "SELECT * FROM views ORDER BY view_id", &[], &[]);
    assert_eq!(final_views.len(), original_views.len() + 1);
    assert!(original_views.iter().all(|view| final_views.contains(view)));
    assert_eq!(property_state(&home, PAGE_A), before_values);
    let after_body = success(&home, &["read", PAGE_A]);
    for field in [
        "content",
        "validators",
        "document_id",
        "document_head_seq",
        "document_generation",
        "metadata_revision",
    ] {
        assert_eq!(after_body[field], before_body[field], "{field}");
    }
}

/// Exercise the file workflow with real Core authority, including the same-text ABA case.
#[test]
fn python_drafts_preserve_identity_merge_and_retry_but_reject_recreated_targets() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client =
        connect_or_launch(&home, "draft-identity-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let body = "# First\n\nRelease date: Friday.\n\n- Keep backups\n  - Verify restore\n\n# Second\n\nRelease date: Friday.\nOwner: Mina\n";
    assert_eq!(
        input_text(&home, &["page", "insert", PAGE_A], body)["ok"],
        true
    );
    let properties = property_state(&home, PAGE_A);
    let draft = home.join("edit");
    success(
        &home,
        &[
            "draft",
            "create",
            PAGE_A,
            "--output",
            draft.to_str().unwrap(),
        ],
    );
    let before: Value =
        serde_json::from_slice(&fs::read(draft.join("base/identity.json")).unwrap()).unwrap();
    let date_id = before["blocks"][1]["block_id"].clone();
    let python = Command::new("python3").args(["-c",
        "from pathlib import Path; import sys; p=Path(sys.argv[1]); s=p.read_text(); assert s.count('Release date: Friday.')==2; p.write_bytes(s.replace('Release date: Friday.', 'Release date: Monday.', 1).encode('utf-8'))",
        draft.join("work/body.md").to_str().unwrap(),
    ]).output().unwrap();
    assert!(
        python.status.success(),
        "{}",
        String::from_utf8_lossy(&python.stderr)
    );
    let remote = format!(
        "*** Begin Patch\n*** Update Page: {PAGE_A}\n@@\n-Owner: Mina\n+Owner: Kai\n*** End Patch\n"
    );
    assert_eq!(input_text(&home, &["patch"], &remote)["ok"], true);
    let applied = success(&home, &["draft", "apply", draft.to_str().unwrap()]);
    assert_eq!(
        applied["affected"],
        serde_json::json!({
            "created_block_ids":[], "deleted_block_ids":[], "moved_block_ids":[],
            "updated_block_ids":[date_id], "title_changed":false,
        })
    );
    assert_eq!(
        success(&home, &["read", PAGE_A])["content"],
        body.replacen("Friday", "Monday", 1).replace("Mina", "Kai")
    );
    assert_eq!(property_state(&home, PAGE_A), properties);
    let observed = home.join("observed");
    success(
        &home,
        &[
            "draft",
            "create",
            PAGE_A,
            "--output",
            observed.to_str().unwrap(),
        ],
    );
    let after: Value =
        serde_json::from_slice(&fs::read(observed.join("base/identity.json")).unwrap()).unwrap();
    let identities = |map: &Value| {
        map["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| (block["block_id"].clone(), block["parent_block_id"].clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(identities(&after), identities(&before));

    // Model a lost response: durable Core commit exists, local marker is still pending.
    let marker = draft.join("apply.json");
    let mut pending: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    pending["status"] = "pending".into();
    pending["result"] = Value::Null;
    nodex_platform::private_fs::set_mode(&marker, 0o600).unwrap();
    nodex_platform::private_fs::write(&marker, serde_json::to_vec(&pending).unwrap()).unwrap();
    nodex_platform::private_fs::set_mode(&marker, 0o400).unwrap();
    let retried = success(&home, &["draft", "apply", draft.to_str().unwrap()]);
    assert_eq!(retried["duplicate"], true);
    assert_eq!(retried["head_seq"], applied["head_seq"]);
    assert_eq!(retried["affected"], applied["affected"]);

    // Delete/reinsert changes Block identity without changing the text ETag.
    let work_file = observed.join("work/body.md");
    let saved = fs::read_to_string(&work_file).unwrap();
    nodex_platform::private_fs::write(&work_file, saved.replace("Monday", "Tuesday")).unwrap();
    let metadata = observed.join("work/meta.yaml");
    let saved_meta = fs::read_to_string(&metadata).unwrap();
    nodex_platform::private_fs::write(&metadata, saved_meta.replace("Page A", "Draft title"))
        .unwrap();
    let read_before = success(&home, &["read", PAGE_A]);
    let removal = format!(
        "*** Begin Patch\n*** Update Page: {PAGE_A}\n@@\n-Release date: Monday.\n*** End Patch\n"
    );
    assert_eq!(input_text(&home, &["patch"], &removal)["ok"], true);
    let anchor = format!(
        "after:{}",
        before["blocks"][0]["block_id"].as_str().unwrap()
    );
    assert_eq!(
        input_text(
            &home,
            &["page", "insert", PAGE_A, "--at", &anchor],
            "Release date: Monday."
        )["ok"],
        true
    );
    let read_replaced = success(&home, &["read", PAGE_A]);
    assert_eq!(
        read_replaced["validators"]["body_etag"],
        read_before["validators"]["body_etag"]
    );
    let rejected = run(&home, &["draft", "apply", observed.to_str().unwrap()]);
    assert_eq!(rejected["error"]["code"], "DRAFT_CONFLICT", "{rejected}");
    let read_after = success(&home, &["read", PAGE_A]);
    assert_eq!(
        read_after, read_replaced,
        "failed draft cannot partially commit its title or body"
    );
    assert_eq!(
        fs::read_to_string(&work_file).unwrap(),
        saved.replace("Monday", "Tuesday")
    );
    assert!(!observed.join("apply.json").exists());
}

#[test]
fn profile_sql_and_schema_work_without_project_routing_from_an_unrelated_directory() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    let cwd = directory.path().join("unrelated");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    nodex_platform::private_fs::create_dir(&cwd).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client =
        connect_or_launch(&home, "profile-sql-cli-integration", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    let invoke = |args: &[&str]| {
        let output = cli_command()
            .arg("--json")
            .args(args)
            .env("NODEX_HOME", &home)
            .current_dir(&cwd)
            .output()
            .unwrap();
        let encoded = if output.status.success() {
            &output.stdout
        } else {
            &output.stderr
        };
        let envelope: Value = serde_json::from_slice(encoded).unwrap();
        assert_eq!(
            output.status.success(),
            envelope["ok"] == true,
            "{args:?}: {envelope}"
        );
        envelope
    };
    let empty = invoke(&["sql", "query", "SELECT COUNT(*) FROM pages"]);
    assert_eq!(empty["result"]["rows"], serde_json::json!([[0]]));
    assert_eq!(invoke(&["sql", "schema", "pages"])["ok"], true);
    let database_id = "019b1000-1000-7000-8000-000000000080";
    let source_id = "019b1000-1000-7000-8000-000000000081";
    let created = client
        .library_apply(
            None,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "profile-sql:create-database".into(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreateDatabase {
                    database_id: database_id.into(),
                    data_source_id: source_id.into(),
                    view_id: "019b1000-1000-7000-8000-000000000082".into(),
                    name: "Library data".into(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    assert!(matches!(created.0, ResponseEnvelope::Ok(_)), "{created:?}");
    let binding = format!("tasks={source_id}");
    let count = invoke(&[
        "sql",
        "query",
        "SELECT COUNT(*) FROM tasks",
        "--bind",
        &binding,
    ]);
    assert_eq!(count["result"]["rows"], serde_json::json!([[0]]));
    for database in [database_id, "Library data"] {
        let described = invoke(&[
            "--database",
            database,
            "sql",
            "schema",
            "tasks",
            "--bind",
            &binding,
        ]);
        assert_eq!(
            described["result"]["tables"][0]["data_source_id"],
            source_id
        );
    }
    seed(&client, &home);
    let explicit_project = invoke(&[
        "--project",
        PROJECT,
        "sql",
        "query",
        "SELECT COUNT(*) FROM tasks",
        "--bind",
        &binding,
    ]);
    assert_eq!(explicit_project["result"]["rows"], serde_json::json!([[0]]));
    let named_project = invoke(&["--project", "Data primitives CLI", "sql", "schema", "pages"]);
    assert_eq!(named_project["ok"], true);
    let missing_project = invoke(&["--project", "missing", "sql", "query", "SELECT 1"]);
    assert_eq!(missing_project["error"]["code"], "PROJECT_NOT_FOUND");
    let stale_identity = invoke(&[
        "--expect-profile",
        "foreign-profile",
        "sql",
        "schema",
        "pages",
    ]);
    assert_eq!(stale_identity["error"]["code"], "PROFILE_MISMATCH");
}

#[test]
fn explicit_body_replacement_accepts_large_unrelated_markdown() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "large-replacement", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    nodex_platform::private_fs::write(home.join("brief.txt"), b"Replacement brief").unwrap();
    success(
        &home,
        &[
            "page",
            "file",
            "put",
            PAGE_B,
            "--path",
            "brief.txt",
            "--from",
            "brief.txt",
            "--if-manifest",
            "0",
        ],
    );
    let files = success(&home, &["page", "file", "list", PAGE_B]);
    assert_eq!(files["files"].as_array().unwrap().len(), 1);
    assert!(files["files"][0]["attachment"].is_object());

    let body = |prefix| {
        format!(
            "Keep this paragraph about <nodex://pages/{PAGE_A}>.\n\n{}",
            (0..600)
                .map(|index| format!("{prefix} paragraph {index}"))
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };
    let original = body("Old");
    let replacement = body("New");
    let empty = success(&home, &["read", PAGE_B]);
    let inserted = input_text(
        &home,
        &[
            "page",
            "replace",
            PAGE_B,
            "--if-match",
            empty["validators"]["body_etag"].as_str().unwrap(),
        ],
        &original,
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    let child = success(
        &home,
        &[
            "page",
            "create",
            "--parent",
            &format!("page:{PAGE_B}"),
            "--title",
            "Retained child",
            "--empty",
        ],
    );
    let child_id = child["page_id"].as_str().unwrap();
    let directive = format!("::page{{id=\"{child_id}\"}}");
    let replacement = format!("{replacement}\n\n{directive}");
    let before = success(&home, &["read", PAGE_B]);
    let replaced = input_text(
        &home,
        &[
            "page",
            "replace",
            PAGE_B,
            "--if-match",
            before["validators"]["body_etag"].as_str().unwrap(),
        ],
        &replacement,
    );
    assert_eq!(replaced["ok"], true, "{replaced}");
    let unchanged_id = &inserted["result"]["affected"]["created_block_ids"][0];
    assert!(unchanged_id.is_string());
    let retired = replaced["result"]["affected"]["deleted_block_ids"]
        .as_array()
        .unwrap();
    assert!(
        !retired.contains(unchanged_id),
        "Unchanged Block {unchanged_id} was retired"
    );

    assert_eq!(
        replaced["result"]["replacement"],
        serde_json::json!({"preserved": 2, "recreated": 600})
    );
    assert_eq!(success(&home, &["read", child_id])["page_id"], child_id);
    let retained_files = success(&home, &["page", "file", "list", PAGE_B]);
    assert_eq!(retained_files["files"], files["files"]);
    assert_eq!(
        success(&home, &["read", PAGE_B])["content"],
        format!("{replacement}\n")
    );
    let after = success(&home, &["read", PAGE_B]);
    let with_toggle = format!(
        "A summary.\n\n:::toggle[Original]\n  ## Heading\n\n  Keep this paragraph next to the heading.\n:::\n\n{directive}"
    );
    let nested = input_text(
        &home,
        &[
            "page",
            "replace",
            PAGE_B,
            "--if-match",
            after["validators"]["body_etag"].as_str().unwrap(),
        ],
        &with_toggle,
    );
    assert_eq!(nested["ok"], true, "{nested}");
    let actual = success(&home, &["read", PAGE_B]);
    assert!(
        actual["content"]
            .as_str()
            .unwrap()
            .contains("Keep this paragraph next to the heading.")
    );
}

#[test]
fn property_apply_rejects_relation_payload_with_the_field_and_recovery_command() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let payload = serde_json::json!({"edits": [{
        "address": {"page_id": PAGE_A, "data_source_id": "source", "property_id": "task_parent"},
        "edit": {"kind": "replace", "expected_value_revision": 1, "value": {
            "kind": "relation", "page_ids": [PAGE_B]
        }}
    }]});
    let error = input(directory.path(), &["page", "properties", "apply"], &payload);
    let message = error["error"]["message"].as_str().unwrap();
    assert!(message.contains("edits[0].edit.value"), "{message}");
    assert!(message.contains("replace_one_relation"), "{message}");
    assert!(
        message.contains("nodex page properties apply --help-schema input"),
        "{message}"
    );
}

#[test]
fn property_apply_reports_the_inner_kind_and_its_own_variants() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let payload = serde_json::json!({"edits": [{
        "address": {"page_id": PAGE_A, "data_source_id": "source", "property_id": "status"},
        "edit": {"kind": "replace", "expected_value_revision": 1, "value": {
            "kind": "typo"
        }}
    }]});
    let response = input(directory.path(), &["page", "properties", "apply"], &payload);
    let error = &response["error"];
    assert_eq!(error["path"], "edits[0].edit.value.kind", "{error}");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("select"), "{message}");
    assert!(!message.contains("patch_set"), "{message}");
}

#[test]
fn set_and_create_use_property_selectors_and_return_small_semantic_receipts() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "property-set", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let source = property_state(&home, PAGE_A);
    let destination = format!("data_source:{}", source["data_source_id"].as_str().unwrap());
    let created = success(
        &home,
        &[
            "page",
            "create",
            "--parent",
            &destination,
            "--title",
            "Another row",
            "--empty",
            "--set",
            "Priority=p1-high",
        ],
    );
    let page_id = created["page_id"].as_str().unwrap();
    let key = created["page_key"].as_str().unwrap();
    assert_eq!(
        property_state(&home, page_id)["values"]["priority"],
        "p1-high"
    );
    let selected = success(
        &home,
        &[
            "sql",
            "query",
            "SELECT page_id FROM pages WHERE title = 'Another row'",
        ],
    );
    let selected_update = input(
        &home,
        &[
            "page",
            "properties",
            "set",
            "--selection",
            "-",
            "--set",
            "Status=In Progress",
        ],
        &selected,
    );
    assert_eq!(selected_update["ok"], true, "{selected_update}");
    assert_eq!(
        selected_update["result"]["pages"][0]["values"][0]["after"],
        "doing"
    );
    let updated = success(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            key,
            "--set",
            "Priority=p1-high",
            "--set",
            "Status=Todo",
        ],
    );
    assert_eq!(updated["pages"][0]["page_id"], PAGE_A);
    assert_eq!(updated["pages"][1]["page_key"], key);
    assert_eq!(updated["pages"][1]["values"][1]["after"], "plan");
    let small = success(
        &home,
        &["page", "properties", "set", key, "--set", "Status=done"],
    );
    assert!(small.to_string().len() < 1200, "{small}");
    assert_eq!(small["pages"][0]["values"][0]["before"], "plan");
    assert_eq!(small["pages"][0]["values"][0]["after"], "done");
    let text = cli_command()
        .args([
            "--output-format",
            "text",
            "--project",
            PROJECT,
            "page",
            "properties",
            "set",
            key,
            "--set",
            "Priority=p1-high",
        ])
        .env("NODEX_HOME", &home)
        .current_dir(&home)
        .output()
        .unwrap();
    assert!(
        text.status.success(),
        "{}",
        String::from_utf8_lossy(&text.stderr)
    );
    assert!(
        text.stdout.len() < 1600,
        "{}",
        String::from_utf8_lossy(&text.stdout)
    );
    let receipt: Value = serde_json::from_slice(&text.stdout).unwrap();
    assert_eq!(receipt["pages"][0]["page_id"], page_id);
    assert_eq!(receipt["pages"][0]["page_key"], key);
    assert_eq!(receipt["pages"][0]["values"][0]["after"], "p1-high");
    let status_revision = property_state(&home, page_id)["value_revisions"]["status"]
        .as_i64()
        .unwrap();
    let intent = nodex_core_contracts::database::DatabaseIntent::SetPageProperties {
        updates: vec![nodex_core_contracts::database::DatabasePagePropertyUpdate {
            page_ids: vec![page_id.into()],
            values: vec![nodex_core_contracts::library::LibraryPageCopyValue {
                property_id: "Status".into(),
                value: serde_json::json!("plan"),
            }],
            expected_value_revisions: [
                ("Status".into(), status_revision - 1),
                ("status".into(), status_revision),
            ]
            .into(),
        }],
        authorization: None,
    };
    let response = client
        .database_apply(
            Some(PROJECT),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                operation_id: "test:duplicate-fence".into(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![intent],
            },
        )
        .unwrap();
    let ResponseEnvelope::Error(error) = response.0 else {
        panic!("Aliased stale fence was accepted");
    };
    assert_eq!(
        error.code,
        nodex_core_contracts::CoreErrorCode::InvalidInput
    );
    assert!(
        error.message.contains("\"Status\"") && error.message.contains("\"status\""),
        "{error:?}"
    );
    let conflicting = ["Status", "status"]
        .into_iter()
        .zip(["doing", "plan"])
        .map(
            |(selector, value)| nodex_core_contracts::database::DatabasePagePropertyUpdate {
                page_ids: vec![page_id.into()],
                values: vec![nodex_core_contracts::library::LibraryPageCopyValue {
                    property_id: selector.into(),
                    value: serde_json::json!(value),
                }],
                expected_value_revisions: Default::default(),
            },
        )
        .collect();
    let conflict = client
        .database_apply(
            Some(PROJECT),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                operation_id: "test:duplicate-edit".into(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![
                    nodex_core_contracts::database::DatabaseIntent::SetPageProperties {
                        updates: conflicting,
                        authorization: None,
                    },
                ],
            },
        )
        .unwrap();
    let ResponseEnvelope::Error(error) = conflict.0 else {
        panic!("Conflicting updates were accepted");
    };
    assert_eq!(
        error.code,
        nodex_core_contracts::CoreErrorCode::InvalidInput
    );
    assert!(error.message.contains(page_id), "{error:?}");
    assert_eq!(property_state(&home, page_id)["values"]["status"], "done");
    let unowned = run(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            PAGE_B,
            "--set",
            "Status=done",
        ],
    );
    assert_eq!(unowned["error"]["code"], "SCOPE_NOT_FOUND", "{unowned}");
    assert_eq!(property_state(&home, PAGE_A)["values"]["status"], "plan");

    let source_id = source["data_source_id"].as_str().unwrap();
    let revision = source_description(&home, source_id)["schema_revision"]
        .as_i64()
        .unwrap();
    let configured = input(
        &home,
        &["data-source", "configure", source_id, "--input", "-"],
        &serde_json::json!({"if_schema_revision":revision,"operations":[
            {"kind":"add_property","name":"Cost=USD","schema":{"kind":"number"}},
            {"kind":"add_property","name":"Note","schema":{"kind":"text"}},
            {"kind":"add_property","name":"Labels","schema":{"kind":"multi_select"},
                "options":["Risk=High"]}
        ]}),
    );
    assert_eq!(configured["ok"], true, "{configured}");
    let typed = success(
        &home,
        &[
            "page",
            "properties",
            "set",
            page_id,
            "--set",
            r#""Cost=USD"=25"#,
            "--set",
            r#"Note="true""#,
            "--set",
            r#"Labels=["Risk=High"]"#,
            "--set",
            "Due date=2026-12-03",
            "--clear",
            "Priority",
        ],
    );
    let values = typed["pages"][0]["values"].as_array().unwrap();
    assert_eq!(values[0]["after"], 25.0);
    assert_eq!(values[1]["after"], "true");
    assert_eq!(values[2]["after"].as_array().unwrap().len(), 1);
    assert_eq!(values[3]["after"], "2026-12-03");
    assert!(values[4]["after"].is_null());
    let repeated = run(
        &home,
        &[
            "page",
            "properties",
            "set",
            page_id,
            "--set",
            "Priority=p1-high",
            "--clear",
            "priority",
        ],
    );
    assert_eq!(repeated["error"]["code"], "INVALID_INPUT", "{repeated}");
    let message = repeated["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("\"Priority\"") && message.contains("\"priority\""),
        "{message}"
    );
    let rejected = run(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            key,
            "--set",
            "Priority=p0-critical",
            "--set",
            "Status=bogus",
        ],
    );
    let error = rejected["error"]["message"].as_str().unwrap();
    assert!(error.contains("Todo") && error.contains("plan"), "{error}");
    assert_eq!(
        property_state(&home, PAGE_A)["values"]["priority"],
        "p1-high"
    );
    assert_eq!(property_state(&home, page_id)["values"]["status"], "done");
}

#[test]
fn page_move_accepts_explicit_page_destinations_and_prepares_a_source_move() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "move-destinations", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let prepared_library = success(
        &home,
        &[
            "page",
            "prepare",
            PAGE_A,
            "--operation",
            "move",
            "--to",
            "library",
        ],
    );
    let wrong_target = input_text(
        &home,
        &[
            "page",
            "move",
            PAGE_A,
            "--to",
            &format!("page:{PAGE_B}"),
            "--if-match",
            prepared_library["validators"]["move_etag"]
                .as_str()
                .unwrap(),
        ],
        "",
    );
    assert_eq!(
        wrong_target["error"]["code"], "ETAG_CONFLICT",
        "{wrong_target}"
    );
    let message = wrong_target["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("library") && message.contains(PAGE_B),
        "{message}"
    );
    let source = property_state(&home, PAGE_A);
    let source_target = format!("data_source:{}", source["data_source_id"].as_str().unwrap());
    let page_target = format!("page:{PAGE_B}");
    success(&home, &["page", "move", PAGE_A, "--to", &page_target]);
    let prepared = success(
        &home,
        &[
            "page",
            "prepare",
            PAGE_A,
            "--operation",
            "move",
            "--to",
            &source_target,
        ],
    );
    let moved = success(
        &home,
        &[
            "page",
            "move",
            PAGE_A,
            "--to",
            &source_target,
            "--if-match",
            prepared["validators"]["move_etag"].as_str().unwrap(),
        ],
    );
    assert_eq!(moved["page_id"], PAGE_A);
    assert!(moved["page_key"].is_string());
    let parent = success(
        &home,
        &[
            "page",
            "create",
            "--parent",
            "library",
            "--title",
            "Batch move parent",
            "--empty",
        ],
    );
    let parent_id = parent["page_id"].as_str().unwrap();
    let batch = success(
        &home,
        &[
            "page",
            "move",
            PAGE_A,
            PAGE_B,
            "--to",
            &format!("page:{parent_id}"),
        ],
    );
    assert_eq!(batch["pages"][0]["page_id"], PAGE_A);
    assert_eq!(batch["pages"][1]["page_id"], PAGE_B);
    assert_eq!(batch["pages"][0]["location"]["page_id"], parent_id);
    assert_eq!(batch["pages"][1]["location"]["page_id"], parent_id);
}

#[test]
fn page_destinations_reject_a_collision_between_exact_id_and_prefix() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "destination-collision", Some(&core_binary)).unwrap();
    let _guard = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    let source = property_state(&home, PAGE_A);
    for id in ["page:review-target", "review-target"] {
        let response = client
            .library_apply(
                Some(PROJECT),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: format!("test:create:{id}"),
                    store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                    intent: LibraryIntent::CreatePage {
                        page_id: id.into(),
                        document_id: format!("document:{id}"),
                        title: format!("Target {id}"),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .unwrap();
        assert!(
            matches!(response.0, ResponseEnvelope::Ok(_)),
            "{response:?}"
        );
    }
    let collision = run(
        &home,
        &["page", "move", PAGE_A, "--to", "page:review-target"],
    );
    assert_eq!(collision["error"]["code"], "INVALID_INPUT", "{collision}");
    let message = collision["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("@page:review-target") && message.contains("@review-target"),
        "{message}"
    );
    let moved = success(
        &home,
        &["page", "move", PAGE_A, "--to", "@page:review-target"],
    );
    assert_eq!(
        moved["affected"]["location"]["document_id"],
        "document:page:review-target"
    );
    let source_id = source["data_source_id"].as_str().unwrap();
    let prefixed_id = format!("data_source:{source_id}");
    let response = client
        .library_apply(
            Some(PROJECT),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "test:create:prefixed-source-page".into(),
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::CreatePage {
                    page_id: prefixed_id.clone(),
                    document_id: "document:prefixed-source-page".into(),
                    title: "Prefixed Source Page".into(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    assert!(
        matches!(response.0, ResponseEnvelope::Ok(_)),
        "{response:?}"
    );
    let args = [
        "page",
        "create",
        "--parent",
        &prefixed_id,
        "--title",
        "Choose a Source",
        "--empty",
    ];
    let ambiguous = run(&home, &args);
    assert_eq!(ambiguous["error"]["code"], "INVALID_INPUT", "{ambiguous}");
    let message = ambiguous["error"]["message"].as_str().unwrap();
    let explicit_source = format!("data_source:@{source_id}");
    assert!(
        message.contains(&format!("page:@{prefixed_id}")) && message.contains(&explicit_source),
        "{message}"
    );
    let mut explicit = args;
    explicit[3] = &explicit_source;
    let created = success(&home, &explicit);
    assert_eq!(
        property_state(&home, created["page_id"].as_str().unwrap())["data_source_id"],
        source_id
    );
}

#[test]
fn grouped_moves_preserve_status_and_batch_writes_replay_exact_receipts() {
    let directory = nodex_platform::test_support::tempdir().unwrap();
    let home = directory.path().join("profile");
    nodex_platform::private_fs::create_dir(&home).unwrap();
    let core_binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "grouped-move-retry", Some(&core_binary)).unwrap();
    let _core = CoreGuard(client.handshake.generation.pid);
    seed(&client, &home);
    verify_database_override(&client, &home);
    let alternate = "data_source:019b1000-1000-7000-8000-000000000005";
    let default_view = "019b1000-1000-7000-8000-000000000006";
    let source = property_state(&home, PAGE_A);
    let original = format!("data_source:{}", source["data_source_id"].as_str().unwrap());

    let create = [
        "page",
        "create",
        "--parent",
        &original,
        "--title",
        "Retry row",
        "--empty",
        "--set",
        "Status=plan",
        "--idempotency-key",
        "triage1111-create",
    ];
    let created = success(&home, &create);
    validate_result(&["page", "create"], &created);
    assert_eq!(
        created["status"],
        serde_json::json!({"option_id":"plan","label":"Todo"})
    );
    let page = created["page_id"].as_str().unwrap();
    let mut changed_create = create;
    changed_create[8] = "Status=done";
    assert_eq!(
        run(&home, &changed_create)["error"]["code"],
        "IDEMPOTENCY_KEY_REUSED"
    );

    success(
        &home,
        &["page", "properties", "set", PAGE_A, "--set", "Status=plan"],
    );
    let prepared = success(
        &home,
        &[
            "page",
            "prepare",
            PAGE_A,
            "--operation",
            "move",
            "--to",
            alternate,
        ],
    );
    let moved = success(
        &home,
        &[
            "page",
            "move",
            PAGE_A,
            "--to",
            alternate,
            "--if-match",
            prepared["validators"]["move_etag"].as_str().unwrap(),
        ],
    );
    assert_eq!(moved["status"], created["status"]);
    success(&home, &["page", "move", PAGE_A, "--to", &original]);
    let batch = [
        "page",
        "move",
        PAGE_A,
        page,
        "--to",
        alternate,
        "--idempotency-key",
        "triage1111-move",
    ];
    let moved = success(&home, &batch);
    validate_result(&["page", "move"], &moved);
    for row in moved["pages"].as_array().unwrap() {
        assert_eq!(row["status"], created["status"]);
    }
    let mut changed_batch = batch;
    changed_batch[5] = &original;
    assert_eq!(
        run(&home, &changed_batch)["error"]["code"],
        "IDEMPOTENCY_KEY_REUSED"
    );
    assert_eq!(
        sql_rows(
            &home,
            "SELECT page_id FROM view_rows(:view) WHERE group_key='plan' ORDER BY page_id",
            &[("view", default_view)],
            &[],
        )
        .len(),
        2
    );
    assert_eq!(success(&home, &create)["page_id"], created["page_id"]);

    let set = [
        "page",
        "properties",
        "set",
        PAGE_A,
        page,
        "--set",
        "Status=done",
        "--idempotency-key",
        "triage1111-done-first",
    ];
    let first = success(&home, &set);
    validate_result(&["page", "properties", "set"], &first);
    let replay = success(&home, &set);
    assert_eq!(replay["status"], "duplicate");
    for field in ["pages", "commit_seq", "operation_id"] {
        assert_eq!(replay[field], first[field]);
    }
    assert_eq!(first["pages"][0]["values"][0]["before"], "plan");
    assert_eq!(first["pages"][0]["values"][0]["after"], "done");
    let moved_replay = success(&home, &batch);
    assert_eq!(moved_replay["duplicate"], true);
    assert_eq!(moved_replay["pages"], moved["pages"]);
    let mut changed_set = set;
    changed_set[6] = "Status=plan";
    assert_eq!(
        run(&home, &changed_set)["error"]["code"],
        "IDEMPOTENCY_KEY_REUSED"
    );

    let refused = run(
        &home,
        &[
            "page",
            "properties",
            "set",
            PAGE_A,
            page,
            "--clear",
            "Status",
        ],
    );
    assert_eq!(refused["error"]["code"], "INVALID_INPUT");
    let message = refused["error"]["message"].as_str().unwrap();
    for stage in ["triage (Triage)", "plan (Todo)", "done (Done)"] {
        assert!(message.contains(stage), "{message}");
    }
    assert_eq!(property_state(&home, PAGE_A)["values"]["status"], "done");
}
