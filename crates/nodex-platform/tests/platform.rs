use nodex_platform::{local_endpoint, private_fs, process};
use std::io::{Read, Write};

#[test]
fn private_entries_are_owned_and_immutable_access_can_be_reversed() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    private_fs::create_dir(&directory).unwrap();
    let path = directory.join("secret");
    let mut file = private_fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    file.write_all(b"private bytes").unwrap();
    drop(file);
    private_fs::checked_metadata(&directory, private_fs::EntryKind::Directory, Some(0o700))
        .unwrap();
    private_fs::checked_metadata(&path, private_fs::EntryKind::File, Some(0o600)).unwrap();
    private_fs::set_mode(&path, 0o400).unwrap();
    private_fs::checked_metadata(&path, private_fs::EntryKind::File, Some(0o400)).unwrap();
    private_fs::set_mode(&path, 0o600).unwrap();
    let replacement = directory.join("replacement");
    let mut file = private_fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&replacement)
        .unwrap();
    file.write_all(b"replacement").unwrap();
    file.sync_all().unwrap();
    drop(file);
    private_fs::atomic_replace(&replacement, &path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    private_fs::sync_directory(&directory).unwrap();
}

#[test]
fn directory_aliases_are_refused_and_do_not_modify_the_target() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    private_fs::create_dir(&source).unwrap();
    let alias = root.path().join("alias");
    private_fs::directory_link(&source, &alias).unwrap();
    assert!(private_fs::checked_metadata(&alias, private_fs::EntryKind::Directory, None).is_err());
    assert!(private_fs::create_dir_all(alias.join("nested")).is_err());
    assert!(!source.join("nested").exists());
    private_fs::remove_directory_link(&alias).unwrap();
    assert!(source.is_dir());
}

#[test]
fn endpoint_names_accept_only_the_local_fixed_grammar() {
    let endpoint = local_endpoint::random_endpoint("nodex-core").unwrap();
    assert!(local_endpoint::valid_pipe_name(&endpoint, "nodex-core"));
    for invalid in [
        endpoint.replace(r"\\.\", r"\\remote\"),
        format!("{endpoint}suffix"),
        endpoint.to_uppercase(),
        endpoint.replace("nodex-core", "nodex-clone"),
        r"\\.\pipe\nodex-core-".into(),
    ] {
        assert!(
            !local_endpoint::valid_pipe_name(&invalid, "nodex-core"),
            "{invalid}"
        );
    }
}

#[tokio::test]
async fn local_http_authenticates_the_os_peer_and_keeps_accepting() {
    use axum::{Router, extract::ConnectInfo, routing::get};
    let root = tempfile::tempdir().unwrap();
    let endpoint = local_endpoint::new_core_endpoint(&root.path().join("core.sock")).unwrap();
    let listener = local_endpoint::LocalListener::bind(&endpoint).unwrap();
    let owner = process::current_user().unwrap();
    let router = Router::new().route(
        "/",
        get(
            move |ConnectInfo(peer): ConnectInfo<local_endpoint::PeerIdentity>| async move {
                assert!(peer.is_authenticated_owner(&owner));
                assert_eq!(peer.pid, Some(std::process::id()));
                "authenticated"
            },
        ),
    );
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<local_endpoint::PeerIdentity>(),
        )
        .await
        .unwrap();
    });
    for _ in 0..3 {
        let endpoint = endpoint.clone();
        tokio::task::spawn_blocking(move || {
            let mut stream =
                local_endpoint::connect(std::path::Path::new(&endpoint), Some(std::process::id()))
                    .unwrap();
            stream
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.ends_with("authenticated"));
        })
        .await
        .unwrap();
    }
    server.abort();
    let _ = server.await;
}

#[test]
fn filesystem_and_process_identity_are_available() {
    let directory = tempfile::tempdir().unwrap();
    assert!(process::free_space(directory.path()).unwrap() > 0);
    assert!(process::process_is_alive(std::process::id()));
    assert!(!process::process_is_alive(0));
    let first = directory.path().join("a");
    let second = directory.path().join("b");
    std::fs::write(&first, b"one").unwrap();
    std::fs::hard_link(&first, &second).unwrap();
    assert_eq!(
        private_fs::file_identity(&first).unwrap().inode,
        private_fs::file_identity(&second).unwrap().inode
    );
    assert_eq!(private_fs::link_count(&first).unwrap(), 2);
}
