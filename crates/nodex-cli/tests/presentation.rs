use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn invoke(arguments: &[&str]) -> Output {
    let home = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_nodex"))
        .args(arguments)
        .env("NODEX_HOME", home.path().join("unavailable"))
        .current_dir(home.path())
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn captured_results_default_to_json_and_explicit_text_overrides_them() {
    let automatic = invoke(&["capabilities"]);
    assert!(automatic.status.success());
    let automatic: Value = serde_json::from_slice(&automatic.stdout).unwrap();
    assert_eq!(automatic["ok"], true);
    let explicit = invoke(&["--output-format", "json", "capabilities"]);
    let explicit: Value = serde_json::from_slice(&explicit.stdout).unwrap();
    assert_eq!(
        automatic["result"]["agentApi"],
        explicit["result"]["agentApi"]
    );
    let human = invoke(&["--output-format", "text", "capabilities"]);
    assert!(human.status.success());
    let human: Value = serde_json::from_slice(&human.stdout).unwrap();
    assert_eq!(human["agentApi"], automatic["result"]["agentApi"]);
    assert!(human.get("ok").is_none());
}

#[test]
fn content_documentation_stays_raw_in_a_pipe_and_can_be_explicitly_wrapped() {
    let raw = invoke(&["docs", "nested-markdown"]);
    assert!(raw.status.success());
    assert_eq!(
        raw.stdout,
        include_bytes!("../../../agent-skills/nodex/references/nested-markdown.md")
    );
    let structured = invoke(&["--json", "docs", "nested-markdown"]);
    assert!(structured.status.success());
    let structured: Value = serde_json::from_slice(&structured.stdout).unwrap();
    assert_eq!(
        structured["result"].as_str().unwrap().as_bytes(),
        raw.stdout
    );
}

#[test]
fn parse_failures_are_one_error_envelope_with_empty_success_stdout() {
    for arguments in [
        vec!["--unknown"],
        vec!["page", "rename", "@page"],
        vec!["--json", "--output-format", "text", "capabilities"],
        vec!["--output-format=json", "not-a-command"],
    ] {
        let output = invoke(&arguments);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["ok"], false);
    }
}

#[test]
fn explicit_text_does_not_prompt_when_input_and_output_are_redirected() {
    let output = invoke(&["--output-format", "text", "setup", "--agent", "codex"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty(), "no prompt may appear in stdout");
    assert!(String::from_utf8(output.stderr).unwrap().contains("--yes"));
}

#[cfg(target_os = "macos")]
#[test]
fn real_terminal_defaults_to_text_and_json_can_override_it() {
    for explicit_json in [false, true] {
        let mut command = Command::new("/usr/bin/script");
        command.args(["-q", "/dev/null", env!("CARGO_BIN_EXE_nodex")]);
        if explicit_json {
            command.arg("--json");
        }
        let output = command
            .arg("capabilities")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        // macOS script echoes its injected EOF before the child output.
        let start = output.stdout.iter().position(|byte| *byte == b'{').unwrap();
        let value: Value = serde_json::from_slice(&output.stdout[start..]).unwrap();
        if explicit_json {
            assert_eq!(value["ok"], true);
        } else {
            assert!(value.get("ok").is_none());
            assert!(value.get("agentApi").is_some());
        }
    }
}
