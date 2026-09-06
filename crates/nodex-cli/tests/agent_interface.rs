use std::fs;
use std::process::Command;

use serde_json::Value;

#[test]
fn capabilities_succeeds_without_resolving_a_profile_or_starting_core() {
    let temp = tempfile::tempdir().expect("temporary HOME");
    let unavailable_home = temp.path().join("must-not-be-created");
    let output = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args([
            "--profile",
            "missing-profile",
            "--project",
            "missing-project",
            "--json",
            "capabilities",
        ])
        .current_dir(temp.path())
        .env("HOME", temp.path())
        .env("NODEX_HOME", &unavailable_home)
        .output()
        .expect("run nodex capabilities");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("JSON envelope");
    assert_eq!(envelope["version"], 1);
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["result"]["schemaVersion"], 1);
    assert_eq!(envelope["result"]["agentApi"]["minimumRevision"], 1);
    assert_eq!(envelope["result"]["agentApi"]["maximumRevision"], 1);
    assert_eq!(
        envelope["result"]["bundle"]["status"],
        Value::String("unavailable".into())
    );
    assert!(
        !unavailable_home.exists(),
        "capabilities must not resolve or create NODEX_HOME"
    );
    assert!(
        fs::read_dir(temp.path())
            .expect("temporary HOME")
            .all(|entry| entry.expect("entry").path() != unavailable_home)
    );
}

#[test]
fn every_leaf_exposes_machine_readable_help_without_core() {
    let output = Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args(["--json", "page", "move", "--help"])
        .output()
        .expect("run machine help");

    assert!(output.status.success());
    let document: Value = serde_json::from_slice(&output.stdout).expect("machine help JSON");
    assert_eq!(document["schemaVersion"], 2);
    assert_eq!(document["command"], "nodex page move");
    assert_eq!(document["capability"], "pageWrite");
    assert_eq!(document["effect"], "write");
    assert_eq!(document["resultSchemaRevision"], 1);
}

#[test]
fn actual_offline_results_and_errors_obey_the_published_schemas() {
    let directory = tempfile::tempdir().expect("isolated directory");
    let nonexistent_home = directory.path().join("must-not-exist");
    let invoke = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_nodex"))
            .args(args)
            .env("HOME", directory.path())
            .env("NODEX_HOME", &nonexistent_home)
            .current_dir(directory.path())
            .output()
            .expect("invoke CLI")
    };
    for command in ["capabilities", "docs"] {
        let path = if command == "docs" {
            vec!["docs", "nested-markdown"]
        } else {
            vec![command]
        };
        let mut help_args = vec!["--json"];
        help_args.extend_from_slice(&path);
        help_args.push("--help");
        let help_output = invoke(&help_args);
        assert!(
            help_output.status.success(),
            "{}",
            String::from_utf8_lossy(&help_output.stderr)
        );
        let help: Value = serde_json::from_slice(&help_output.stdout).expect("help document");
        let validator = jsonschema::validator_for(&help["resultSchema"]).expect("result schema");
        let mut args = vec!["--json"];
        args.extend_from_slice(&path);
        let output = invoke(&args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let envelope: Value = serde_json::from_slice(&output.stdout).expect("output envelope");
        validator
            .validate(&envelope["result"])
            .expect("actual output matches schema");
        assert!(!validator.is_valid(&serde_json::json!(42)));
        let mut invalid_args = args;
        invalid_args.push("--unknown-option");
        let failed = invoke(&invalid_args);
        assert_eq!(failed.status.code(), Some(2));
        assert!(failed.stdout.is_empty());
        let error: Value = serde_json::from_slice(&failed.stderr).expect("error envelope");
        jsonschema::validator_for(&help["errorSchema"])
            .expect("error schema")
            .validate(&error)
            .expect("actual error matches schema");
    }
    assert!(
        !nonexistent_home.exists(),
        "help, docs, and invalid inputs must not start Core"
    );
}
