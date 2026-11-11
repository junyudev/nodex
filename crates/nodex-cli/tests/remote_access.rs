//! CLI and Desktop share Core-owned listener intent and startup restoration.

mod support;

use support::cli_command;

use nodex_core_protocol::client::{CoreClient, connect_or_launch};
use nodex_platform::{private_fs, test_support::tempdir};
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

struct CoreGuard(u32);
impl Drop for CoreGuard {
    fn drop(&mut self) {
        let _ = nodex_platform::process::terminate_process(self.0);
    }
}
fn command(home: &Path, args: &[&str]) -> Value {
    let output = cli_command()
        .arg("--json")
        .args(args)
        .env("NODEX_HOME", home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["ok"], true, "{envelope}");
    envelope["result"].clone()
}

#[test]
fn cli_remote_access_intent_survives_core_restart_and_off_retains_the_selected_port() {
    let directory = tempdir().unwrap();
    let home = directory.path().join("profile");
    private_fs::create_dir(&home).unwrap();
    let binary = Path::new(env!("CARGO_BIN_EXE_nodex"))
        .with_file_name(nodex_platform::process::executable_name("nodex-core"));
    let client = connect_or_launch(&home, "remote-access-cli", Some(&binary)).unwrap();
    let _old = CoreGuard(client.handshake.generation.pid);
    let initial = command(&home, &["space", "remote-access", "status"]);
    assert_eq!(initial["intent"]["enabled"], false);
    assert!(initial["listener"].is_null());
    let enabled = command(
        &home,
        &["space", "remote-access", "on", "--address", "127.0.0.1:0"],
    );
    let address = enabled["url"]
        .as_str()
        .unwrap()
        .trim_start_matches("https://");
    let state = command(&home, &["space", "remote-access", "status"]);
    assert_eq!(
        state["intent"],
        serde_json::json!({"enabled":true,"address":address})
    );
    client.shutdown().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while CoreClient::connect(&home, "wait-remote-access-shutdown").is_ok() {
        assert!(Instant::now() < until, "Core did not stop");
        std::thread::sleep(Duration::from_millis(20));
    }
    let reopened = connect_or_launch(&home, "remote-access-cli-restart", Some(&binary)).unwrap();
    let _reopened = CoreGuard(reopened.handshake.generation.pid);
    let stopped = command(&home, &["space", "remote-access", "status"]);
    assert_eq!(
        stopped["listener"]["url"], enabled["url"],
        "Core restores the listener before the CLI connects"
    );
    assert_eq!(stopped["routes_changed"], false);
    assert_eq!(stopped["intent"], state["intent"]);
    let restored = command(&home, &["space", "remote-access", "on"]);
    assert_eq!(
        restored["url"], enabled["url"],
        "on reuses the saved address unless explicitly overridden"
    );
    let disabled = command(&home, &["space", "remote-access", "off"]);
    assert_eq!(
        disabled["intent"],
        serde_json::json!({"enabled":false,"address":address})
    );
    assert!(disabled["listener"].is_null());
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_address = occupied.local_addr().unwrap().to_string();
    let fallback = command(
        &home,
        &[
            "space",
            "remote-access",
            "on",
            "--address",
            &occupied_address,
        ],
    );
    assert_ne!(fallback["url"], format!("https://{occupied_address}"));
    let changed = command(&home, &["space", "remote-access", "status"]);
    assert_eq!(changed["routes_changed"], true);
    assert_eq!(
        changed["intent"]["address"],
        fallback["url"]
            .as_str()
            .unwrap()
            .trim_start_matches("https://")
    );
    command(&home, &["space", "remote-access", "off"]);
}
