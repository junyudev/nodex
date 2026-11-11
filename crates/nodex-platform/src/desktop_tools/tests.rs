use super::authenticode::Authenticode;
use super::processes::open_process;
use super::registry::{Browser, RegistryView};
use super::*;
use crate::windows::{PrivateSecurity, handle, wide};
use std::fs;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, GENERIC_READ, GENERIC_WRITE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::{ImpersonateAnonymousToken, RevertToSelf};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
use windows_sys::Win32::System::Threading::{GetCurrentThread, WaitForSingleObject};

#[test]
fn embedded_system_signature_verifies_and_tampering_fails() {
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    // Windows releases differ in which inbox binaries have embedded signatures.
    let candidates = [
        "ntoskrnl.exe",
        "winload.efi",
        "curl.exe",
        r"WindowsPowerShell\v1.0\powershell.exe",
    ];
    let signed = candidates
        .into_iter()
        .map(|name| system.join(name))
        .find(|path| match verify_authenticode(path) {
            Ok(Authenticode::Verified {
                chain,
                code_signing_eku: true,
                ..
            }) => {
                assert!(!chain.is_empty());
                true
            }
            result => {
                eprintln!(
                    "{}: {:?}",
                    path.display(),
                    result.map(|value| serde_json::to_value(value).unwrap())
                );
                false
            }
        })
        .expect("an inbox PE with a verified embedded code-signing certificate");
    let temp = tempfile::tempdir().unwrap();
    let mut bytes = fs::read(signed).unwrap();
    let offset = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
    bytes[offset + 8] ^= 1; // COFF timestamp is hashed by Authenticode.
    let tampered = temp.path().join("tampered.exe");
    fs::write(&tampered, bytes).unwrap();
    assert!(matches!(
        verify_authenticode(&tampered).unwrap(),
        Authenticode::Rejected {
            signature: "embedded",
            ..
        }
    ));
    assert!(matches!(
        verify_authenticode(&std::env::current_exe().unwrap()).unwrap(),
        Authenticode::Rejected {
            signature: "none",
            ..
        }
    ));
}

#[test]
fn path_inspection_stops_at_reparse_points_and_detects_foreign_write() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    fs::create_dir(&target).unwrap();
    let file = target.join("file.txt");
    crate::private_fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&file)
        .unwrap();
    let checked = inspect_path(&file).unwrap();
    assert_eq!(checked.owner_sid, checked.current_user_sid);
    assert!(!checked.grants_foreign_write);
    let public = target.join("public.txt");
    let security = PrivateSecurity::from_sddl("D:P(A;;FR;;;WD)(A;;FW;;;WD)").unwrap();
    let public_handle = handle(unsafe {
        CreateFileW(
            wide(&public).unwrap().as_ptr(),
            GENERIC_WRITE,
            0,
            &security.attributes(),
            windows_sys::Win32::Storage::FileSystem::CREATE_NEW,
            0,
            null_mut(),
        )
    })
    .unwrap();
    drop(public_handle);
    assert!(inspect_path(&public).unwrap().grants_foreign_write);
    let junction = temp.path().join("junction");
    crate::private_fs::directory_link(&target, &junction).unwrap();
    assert!(inspect_path(&junction).unwrap().reparse_point);
    assert!(inspect_path(&junction.join("file.txt")).is_err());
}

#[tokio::test]
async fn pipe_rejects_anonymous_token_and_binds_child_identity() {
    let mut listener = PipeListener::bind("nodex-test").unwrap();
    let endpoint = listener.endpoint.clone();
    std::thread::spawn(move || {
        assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
        let result = handle(unsafe {
            CreateFileW(
                wide(&endpoint).unwrap().as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        });
        assert_ne!(unsafe { RevertToSelf() }, 0);
        assert_eq!(
            result.unwrap_err().raw_os_error(),
            Some(ERROR_ACCESS_DENIED as i32)
        );
    })
    .join()
    .unwrap();
    assert!(crate::local_endpoint::desktop_instance(&listener.endpoint, true).is_err());
    let server = process_identity(std::process::id()).unwrap();
    let mut child = fixture("pipe", &listener.endpoint, &server.pid.to_string());
    let connection = tokio::time::timeout(Duration::from_secs(15), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(connection.identity, process_identity(child.0.id()).unwrap());
    assert!(Path::new(&connection.identity.image_path).is_absolute());
    let mut bytes = [0; 4];
    tokio::time::timeout(Duration::from_secs(10), async {
        connection
            .reader
            .lock()
            .await
            .read_exact(&mut bytes)
            .await
            .unwrap();
        assert_eq!(&bytes, b"ping");
        connection
            .writer
            .lock()
            .await
            .write_all(b"pong")
            .await
            .unwrap();
    })
    .await
    .unwrap();
    assert!(child.0.wait().unwrap().success());
}

#[test]
fn snapshot_terminates_verified_tree_and_job_drop_ends_all_children() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("snapshot");
    let mut child = fixture("parent", marker.to_str().unwrap(), "");
    let root = process_identity(child.0.id()).unwrap();
    let descendant = wait_marker(&marker);
    assert_eq!(descendants(&root).unwrap()[0].pid, descendant);
    let mut stale = root.clone();
    stale.creation_time = "0".into();
    assert!(terminate_subtree(&stale).is_err());
    assert_eq!(terminate_subtree(&root).unwrap(), [descendant, root.pid]);
    assert!(!child.0.wait().unwrap().success());

    let marker = temp.path().join("job");
    let job = spawn_in_job(
        std::env::current_exe().unwrap().to_str().unwrap(),
        &fixture_args(),
        temp.path(),
        BTreeMap::from([
            ("SystemRoot".into(), std::env::var("SystemRoot").unwrap()),
            ("NODEX_DTW_TEST_ROLE".into(), "parent".into()),
            (
                "NODEX_DTW_TEST_ARG".into(),
                marker.to_string_lossy().into_owned(),
            ),
        ]),
    )
    .unwrap();
    let leaf = open_process(wait_marker(&marker), 0).unwrap();
    let root = open_process(job.identity.pid, 0).unwrap();
    drop(job);
    for process in [leaf, root] {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 10_000) },
            WAIT_OBJECT_0
        );
    }
}

#[test]
fn registry_round_trip_and_compare_before_restore() {
    let temp = tempfile::tempdir().unwrap();
    let host = format!(
        "nodex.test_{}",
        crate::local_endpoint::random_endpoint("test")
            .unwrap()
            .rsplit('-')
            .next()
            .unwrap()
    );
    for (browser, view) in [
        (Browser::Chrome, RegistryView::X86),
        (Browser::Edge, RegistryView::X64),
    ] {
        let key = HostKey {
            browser,
            view,
            host: host.clone(),
        };
        let initial = write_registration(&key, None, &temp.path().join("initial.json")).unwrap();
        let replacement = write_registration(
            &key,
            Some(initial.installed.clone()),
            &temp.path().join("new.json"),
        )
        .unwrap();
        assert!(!restore_registration(&key, &initial).unwrap());
        assert!(restore_registration(&key, &replacement).unwrap());
        assert_eq!(
            read_registration(&key).unwrap(),
            Some(initial.installed.clone())
        );
        assert!(restore_registration(&key, &initial).unwrap());
        assert_eq!(read_registration(&key).unwrap(), None);
    }
}

fn fixture_args() -> Vec<String> {
    ["--exact", "desktop_tools::tests::child_fixture"]
        .map(str::to_owned)
        .into()
}
struct TestChild(Child);
impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn fixture(role: &str, argument: &str, second: &str) -> TestChild {
    TestChild(
        Command::new(std::env::current_exe().unwrap())
            .args(fixture_args())
            .env("NODEX_DTW_TEST_ROLE", role)
            .env("NODEX_DTW_TEST_ARG", argument)
            .env("NODEX_DTW_TEST_SECOND", second)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    )
}
fn wait_marker(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(text) = fs::read_to_string(path)
            && let Ok(pid) = text.parse()
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not publish its descendant PID"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn child_fixture() {
    let Ok(role) = std::env::var("NODEX_DTW_TEST_ROLE") else {
        return;
    };
    let argument = std::env::var("NODEX_DTW_TEST_ARG").unwrap();
    match role.as_str() {
        "pipe" => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let connection = connect_pipe(&argument).unwrap();
                let server = std::env::var("NODEX_DTW_TEST_SECOND")
                    .unwrap()
                    .parse()
                    .unwrap();
                assert_eq!(connection.identity, process_identity(server).unwrap());
                connection
                    .writer
                    .lock()
                    .await
                    .write_all(b"ping")
                    .await
                    .unwrap();
                let mut bytes = [0; 4];
                connection
                    .reader
                    .lock()
                    .await
                    .read_exact(&mut bytes)
                    .await
                    .unwrap();
                assert_eq!(&bytes, b"pong");
            }),
        "parent" => {
            let child = fixture("leaf", "", "");
            fs::write(argument, child.0.id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(30));
        }
        "leaf" => std::thread::sleep(Duration::from_secs(30)),
        _ => panic!("unknown fixture role"),
    }
}
