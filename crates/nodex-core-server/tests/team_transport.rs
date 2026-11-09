//! Exercise the real HTTPS listener, private administration and durable identity boundary.
use nodex_core_contracts::{library::MemberRole, team::*};
use nodex_core_protocol::{
    ClientIdentity, ClientKind, CoreSelectionResult, HandshakeRequest, HandshakeResponse,
    RuntimeGenerationIdentity, client::CoreClient, core_client_requirements,
};
use nodex_core_server::DEVICE_REQUESTS_PER_MINUTE;
use nodex_platform::test_support::tempdir;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_rustls::rustls::{self, pki_types::ServerName};

struct Core {
    child: Child,
    home: nodex_platform::test_support::TempDir,
    local: CoreClient,
    info: ListenerInfo,
}
impl Core {
    fn start() -> Self {
        let home = tempdir().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_nodex-core"))
            .args(["--home", home.path().to_str().unwrap()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        if line.is_empty() {
            let mut errors = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut errors)
                .unwrap();
            panic!("Core failed: {errors}");
        }
        let _: CoreSelectionResult = serde_json::from_str(&line).unwrap();
        let local = CoreClient::connect(home.path(), "team-test").unwrap();
        let info = local
            .space_listen(ListenRequest {
                address: "127.0.0.1:0".into(),
                cert: None,
                key: None,
            })
            .unwrap();
        Self {
            child,
            home,
            local,
            info,
        }
    }
    fn tls(
        &self,
        pin: &str,
    ) -> io::Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>> {
        let pem = fs::read(self.home.path().join("team-transport/server-identity.pem"))?;
        let cert = rustls_pemfile::certs(&mut pem.as_slice()).next().unwrap()?;
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert).unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let mut connection = rustls::ClientConnection::new(
            Arc::new(config),
            ServerName::try_from("localhost").unwrap().to_owned(),
        )
        .unwrap();
        let mut socket = TcpStream::connect(self.info.url.trim_start_matches("https://"))?;
        socket.set_read_timeout(Some(Duration::from_secs(22)))?;
        socket.set_write_timeout(Some(Duration::from_secs(5)))?;
        while connection.is_handshaking() {
            connection.complete_io(&mut socket)?;
        }
        let cert = &connection.peer_certificates().unwrap()[0];
        if hex::encode(Sha256::digest(cert.as_ref())) != pin {
            return Err(io::Error::other("Certificate pin mismatch"));
        }
        Ok(rustls::StreamOwned::new(connection, socket))
    }
    fn request(
        &self,
        path: &str,
        token: &str,
        binding: Option<(&str, &str)>,
        body: Value,
    ) -> (u16, Value) {
        let mut tls = self.tls(&self.info.fingerprint).unwrap();
        let bytes = serde_json::to_vec(&body).unwrap();
        let (id, binding) = binding.unwrap_or(("", ""));
        tls.write_all(&bytes).unwrap();
        tls.flush().unwrap();
        let mut raw = Vec::new();
        let result = tls.read_to_end(&mut raw);
        if let Err(error) = result {
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        }
        decode_response(&raw)
    }
    fn local_request(
        &self,
        path: &str,
        binding: Option<(&str, &str)>,
        body: Value,
    ) -> (u16, Value) {
        let auth = fs::read_to_string(self.home.path().join("run/core/core.auth")).unwrap();
        let descriptor = &self.local.descriptor;
        let mut stream = nodex_platform::local_endpoint::connect(
            std::path::Path::new(&descriptor.endpoint),
            Some(descriptor.pid),
        )
        .unwrap();
        let body = serde_json::to_string(&body).unwrap();
        let (id, binding) = binding.unwrap_or(("", ""));
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        decode_response(&response)
    }
    fn enroll(&self) -> EnrollmentResponse {
        let invite = self
            .local
            .space_invite(InviteRequest {
                member_id: None,
            })
            .unwrap();
        let (status, response) = self.request(
            "/enroll",
            "",
            None,
        );
        assert_eq!(status, 200, "{response}");
        serde_json::from_value(response).unwrap()
    }
    fn session(&self, credential: &str) -> SessionResponse {
        let (status, response) = self.request(
            "/session",
            "",
            None,
            json!({"device_credential":credential}),
        );
        assert_eq!(status, 200, "{response}");
        serde_json::from_value(response).unwrap()
    }
    fn handshake(&self, token: &str, id: &str, kind: ClientKind) -> (u16, Value) {
        self.request(
            "/core/v1/handshake",
            token,
            None,
            serde_json::to_value(HandshakeRequest {
                requirements: core_client_requirements(),
                client: ClientIdentity {
                    kind,
                    build_id: "team-test".into(),
                },
                connection_id: id.into(),
                expected_generation: RuntimeGenerationIdentity::from(&self.local.descriptor),
            })
            .unwrap(),
        )
    }
    fn stream(
        &self,
        token: &str,
        id: &str,
        binding: &str,
        after: i64,
    ) -> BufReader<rustls::StreamOwned<rustls::ClientConnection, TcpStream>> {
        let mut tls = self.tls(&self.info.fingerprint).unwrap();
        write!(tls,"GET /core/v1/events?after={after} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nConnection: close\r\n\r\n").unwrap();
        tls.flush().unwrap();
        let mut reader = BufReader::new(tls);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("200"), "{line}");
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        reader
    }
}
// Persistent authenticated connections must survive another client's exhausted pre-auth IP window.
fn persistent_request(
    stream: &mut BufReader<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>,
    path: &str,
    token: &str,
    binding: Option<(&str, &str)>,
    body: Value,
) -> (u16, Value, String) {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(&body).unwrap()
    };
    let (id, binding) = binding.unwrap_or(("", ""));
    write!(stream.get_mut(), "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nx-nodex-request-id: request:{}\r\nContent-Length: {}\r\n\r\n", random_id(), bytes.len()).unwrap();
    stream.get_mut().write_all(&bytes).unwrap();
    stream.get_mut().flush().unwrap();
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert!(
            stream.read_line(&mut line).unwrap() > 0,
            "HTTP stream closed: {headers}"
        );
        headers.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut raw = headers.as_bytes().to_vec();
    if headers
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        loop {
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            raw.extend_from_slice(line.as_bytes());
            let size = usize::from_str_radix(line.trim(), 16).unwrap();
            let mut bytes = vec![0; size + 2];
            stream.read_exact(&mut bytes).unwrap();
            raw.extend_from_slice(&bytes);
            if size == 0 {
                break;
            }
        }
    } else {
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_owned)
            })
            .unwrap()
            .parse()
            .unwrap();
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).unwrap();
        raw.extend_from_slice(&bytes);
    }
    let (status, value) = decode_response(&raw);
    (status, value, headers)
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.local.shutdown();
        let until = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
// Canonical bounded operations keep random entropy out of legacy UUID timestamp inference.
fn team_operation_id() -> String {
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!(
        "nodexop:v1:{issued}:{}:attention:{}",
        issued + 7 * 24 * 60 * 60 * 1000,
        random_id()
    )
}
fn random_id() -> String {
    let mut b = [0; 16];
    getrandom::fill(&mut b).unwrap();
    hex::encode(b)
}
fn decode_response(raw: &[u8]) -> (u16, Value) {
    let raw = String::from_utf8_lossy(raw);
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("Invalid HTTP response: {raw}"));
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut rest = body;
        let mut decoded = String::new();
        loop {
            let (len, tail) = rest.split_once("\r\n").unwrap();
            let len = usize::from_str_radix(len, 16).unwrap();
            if len == 0 {
                break;
            }
            decoded.push_str(&tail[..len]);
            rest = &tail[len + 2..];
        }
        decoded
    } else {
        body.to_owned()
    };
    (
        status,
        serde_json::from_str(&body).unwrap_or_else(|_| panic!("HTTP {status}: {body}")),
    )
}
fn until(reader: &mut impl BufRead, needle: &str) -> String {
    let mut read = String::new();
    loop {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "Stream closed: {read}"
        );
        read.push_str(&line);
        if line.contains(needle) {
            return read;
        }
    }
}

#[test]
fn enroll_collaborate_renew_revoke_and_resume_over_pinned_https() {
    let core = Core::start();
    assert!(core.tls(&"0".repeat(64)).is_err());
    let invite = core
        .local
        .space_invite(InviteRequest {
            role: MemberRole::Member,
            member_id: None,
        })
        .unwrap();
    let enrollment = json!({"code":invite.code,"device_label":"Laptop","display_name":"Bob"});
    let (status, value) = core.request("/enroll", "", None, enrollment.clone());
    assert_eq!(status, 200, "{value}");
    let device: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(core.request("/enroll", "", None, enrollment).0, 401);
    let session = core.session(&device.device_credential);
    assert_eq!(session.principal.device_id, device.device_id);
    assert_eq!(session.principal.role, MemberRole::Member);
    for kind in [
        ClientKind::ElectronHost,
        ClientKind::Test,
        ClientKind::NativeCli,
    ] {
        assert_eq!(
            core.handshake(&session.session_token, &random_id(), kind).0,
            403
        );
    }
    let id = random_id();
    let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
    assert_eq!(status, 200, "{value}");
    let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    let binding = Some((id.as_str(), handshake.connection_binding.as_str()));
    let metadata = json!({"contract_version":nodex_core_contracts::LIBRARY_CONTRACT_VERSION,"read":{"kind":"metadata"}});
    assert_eq!(
        core.request(
            "/core/v1/modules/library/read",
            &session.session_token,
            binding,
            metadata.clone()
        )
        .1["status"],
        "ok"
    );
    core.local.health().unwrap();
    assert_eq!(
        core.request(
            "/core/v1/modules/library/read",
            &session.session_token,
            binding,
            metadata.clone()
        )
        .1["status"],
        "ok",
        "Local health observation cannot reap a remote connection as a dead PID"
    );
    let page = random_id();
    let apply = json!({"contract_version":nodex_core_contracts::LIBRARY_CONTRACT_VERSION,"operation_id":team_operation_id(),"store_epoch":handshake.store_epoch,"intent":{"kind":"create_page","page_id":page,"document_id":random_id(),"title":"Shared","parent":{"kind":"library","before":null}}});
    let (status, value) = core.request(
        "/core/v1/modules/library/apply",
        &session.session_token,
        binding,
        apply.clone(),
    );
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "ok", "{value}");
    let cursor = value["payload"]["commit"]["commit_seq"]
        .as_i64()
        .expect("Committed cursor");
    let renewed = core.session(&device.device_credential);
    assert_eq!(
        core.request(
            "/core/v1/modules/library/apply",
            &renewed.session_token,
            binding,
            apply
        )
        .1["status"],
        "ok"
    );
    let denied=core.request("/core/v1/modules/administration/read",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::STORE_ADMINISTRATION_CONTRACT_VERSION,"read":{"kind":"status"}}));
    assert_eq!(denied.1["payload"]["code"], "unauthorized");
    assert_eq!(
        core.request(
            "/core/v1/admin/space/invite",
            &session.session_token,
            binding,
            json!({"role":"owner"})
        )
        .0,
        403
    );
    // Replay includes the commit made after the caller's acknowledged cursor.
    let mut replay = core.stream(
        &session.session_token,
        &id,
        &handshake.connection_binding,
        handshake.commit_head,
    );
    let event = until(&mut replay, "event: module");
    let _ = event;
    until(&mut replay, &format!("\"commit_seq\":{cursor}"));
    drop(replay);
    let mut live = core.stream(
        &session.session_token,
        &id,
        &handshake.connection_binding,
        cursor,
    );
    until(&mut live, ": heartbeat");
    core.local
        .space_revoke(RevokeDeviceRequest {
            device_id: device.device_id,
        })
        .unwrap();
    let start = Instant::now();
    let mut rest = String::new();
    let _ = live.read_to_string(&mut rest);
    assert!(start.elapsed() < Duration::from_secs(4));
    let (withdrawn_status, withdrawn) = core.request(
        "/session",
        "",
        None,
        json!({"device_credential":device.device_credential}),
    );
    assert_eq!(withdrawn_status, 401);
    assert_eq!(
        withdrawn["payload"]["recovery"]["kind"],
        "remote_access_withdrawn"
    );
    assert_eq!(
        core.request(
            "/session",
            "",
            None,
            json!({"device_credential":device.device_credential})
        )
        .0,
        401
    );
    assert_eq!(
        core.request(
            "/core/v1/modules/library/read",
            &session.session_token,
            binding,
            metadata
        )
        .0,
        401
    );
}

#[test]
fn receipt_resolution_stays_with_its_member_across_session_renewal() {
    let core = Core::start();
    let device = core.enroll();
    let session = core.session(&device.device_credential);
    let id = random_id();
    let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
    assert_eq!(status, 200);
    let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    let binding = Some((id.as_str(), handshake.connection_binding.as_str()));
    let operation = team_operation_id();
    let (status, value) = core.request(
        "/core/v1/modules/library/apply",
        &session.session_token,
        binding,
        json!({
            "contract_version": nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
            "operation_id": operation,
            "store_epoch": handshake.store_epoch,
            "intent": {
                "kind": "create_page", "page_id": random_id(), "document_id": random_id(),
                "title": "Shared", "parent": { "kind": "library", "before": null }
            }
        }),
    );
    assert_eq!(status, 200);
    assert_eq!(value["status"], "ok", "{value}");
    let mut resolve = json!({
        "module": "library", "operation_id": operation,
        "store_epoch": handshake.store_epoch, "intent_hash": "0".repeat(64)
    });
    let renewed = core.session(&device.device_credential);
    let (status, value) = core.request(
        "/core/v1/local-mutations/resolve",
        &renewed.session_token,
        binding,
        resolve.clone(),
    );
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "intent_conflict", "{value}");
    resolve["intent_hash"] = value["observed_hash"].clone();

    let other_device = core.enroll();
    let other = core.session(&other_device.device_credential);
    let other_id = random_id();
    let (_, value) = core.handshake(&other.session_token, &other_id, ClientKind::RemoteMember);
    let other_handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    assert_eq!(
        core.request(
            "/core/v1/local-mutations/resolve",
            &other.session_token,
            Some((&other_id, &other_handshake.connection_binding)),
            resolve.clone(),
        )
        .0,
        403
    );
    let (status, value) = core.request(
        "/core/v1/local-mutations/resolve",
        &renewed.session_token,
        binding,
        resolve,
    );
    assert_eq!(status, 200);
    assert_eq!(value["status"], "committed", "{value}");
}

#[test]
fn member_device_and_pre_auth_budgets_fail_closed() {
    let core = Core::start();
    let device = core.enroll();
    let session = core.session(&device.device_credential);
    let id = random_id();
    let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
    assert_eq!(status, 200);
    let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    let binding = Some((id.as_str(), handshake.connection_binding.as_str()));
    let request = json!({"contract_version":nodex_core_contracts::LIBRARY_CONTRACT_VERSION,"read":{"kind":"metadata"}});
    let mut stream = BufReader::new(core.tls(&core.info.fingerprint).unwrap());
    let mut unauthenticated = BufReader::new(core.tls(&core.info.fingerprint).unwrap());
    // Drain the IP's unauthenticated window without charging Bob's authenticated identity.
    let mut preauth_limited = false;
    for _ in 0..240 {
        let (status, value, headers) = persistent_request(
            &mut unauthenticated,
            "/core/v1/modules/library/read",
            "invalid",
            None,
            Value::Null,
        );
        if status == 429 {
            assert_eq!(value["payload"]["recovery"]["budget"], "pre_auth_ip");
            assert!(headers.to_ascii_lowercase().contains("retry-after:"));
            preauth_limited = true;
            break;
        }
        assert_eq!(status, 401);
    }
    assert!(preauth_limited);
    let mut limited = false;
    for index in 0..DEVICE_REQUESTS_PER_MINUTE + 10 {
        let path = if index % 2 == 0 {
            "/core/v1/modules/library/read"
        } else {
            "/core/v1/admin/space/invite"
        };
        let (status, value, headers) = persistent_request(
            &mut stream,
            path,
            &session.session_token,
            binding,
            if index % 2 == 0 {
                request.clone()
            } else {
            },
        );
        if status == 429 {
            assert_eq!(value["payload"]["recovery"]["budget"], "device_requests");
            assert!(headers.to_ascii_lowercase().contains("retry-after:"));
            limited = true;
            break;
        }
        assert_eq!(status, if index % 2 == 0 { 200 } else { 403 });
    }
    assert!(
        limited,
        "Device request budget must reject within {} requests",
        DEVICE_REQUESTS_PER_MINUTE + 10
    );
    let admin = core.local.space_devices().unwrap();
    assert_eq!(
        admin.len(),
        1,
        "Remote saturation preserves local administration"
    );
}

#[test]
fn enroll_more_devices_without_granting_remote_owners_host_authority() {
    let core = Core::start();
    let first = core.enroll();
    let invite = core
        .local
        .space_invite(InviteRequest {
            role: MemberRole::Member,
            member_id: Some(first.member_id.clone()),
        })
        .unwrap();
    let (status, value) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":invite.code,"device_label":"Phone","display_name":"Bob"}),
    );
    assert_eq!(status, 200);
    let second: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(first.member_id, second.member_id);
    assert_ne!(first.device_id, second.device_id);
    let session = core.session(&second.device_credential);
    core.local
        .space_remove_member(RemoveMemberRequest {
            member_id: first.member_id,
        })
        .unwrap();
    assert_eq!(
        core.handshake(
            &session.session_token,
            "removed-client",
            ClientKind::RemoteMember
        )
        .0,
        401
    );
    assert_eq!(
        core.request(
            "/session",
            "",
            None,
            json!({"device_credential":first.device_credential})
        )
        .0,
        401
    );
    let invite = core
        .local
        .space_invite(InviteRequest {
            role: MemberRole::Owner,
            member_id: None,
        })
        .unwrap();
    let (status, value) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":invite.code,"device_label":"Owner device","display_name":"Alice"}),
    );
    assert_eq!(status, 200);
    let owner: EnrollmentResponse = serde_json::from_value(value).unwrap();
    let session = core.session(&owner.device_credential);
    assert_eq!(session.principal.role, MemberRole::Owner);
    assert_eq!(
            "/core/v1/admin/space/devices",
            &session.session_token,
            None,
            json!({})
        )
        .0,
    );
}

#[test]
fn enrollment_storage_retains_hashes_instead_of_bearer_secrets() {
    let core = Core::start();
    let invite = core
        .local
        .space_invite(InviteRequest {
            role: MemberRole::Member,
            member_id: None,
        })
        .unwrap();
    let (status, response) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":invite.code,"device_label":"Laptop","display_name":"Bob"}),
    );
    assert_eq!(status, 200);
    let device: EnrollmentResponse = serde_json::from_value(response).unwrap();
    let session = core.session(&device.device_credential);
    // Read-only inspection is the subject of this storage-security contract;
    // enrollment and session creation still use the public HTTPS boundary.
    let database = rusqlite::Connection::open_with_flags(
        core.home.path().join("nodex.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let stored_code: String = database
        .query_row("SELECT code_hash FROM space_invites", [], |r| r.get(0))
        .unwrap();
    let stored_device: String = database
        .query_row(
            "SELECT credential_hash FROM member_devices WHERE id=?1",
            [device.device_id],
            |r| r.get(0),
        )
        .unwrap();
    let stored_session: String = database
        .query_row(
            "SELECT token_hash FROM member_sessions WHERE id=?1",
            [session.principal.session_id],
            |r| r.get(0),
        )
        .unwrap();
    for (stored, secret) in [
        (stored_code, invite.code),
        (stored_device, device.device_credential),
        (stored_session, session.session_token),
    ] {
        assert_ne!(stored, secret);
        assert_eq!(stored, hex::encode(Sha256::digest(secret.as_bytes())));
    }
}

#[test]
fn remote_attention_belongs_to_the_requesting_member() {
    use nodex_core_contracts::workspace::ProjectWorkspaceRead;
    let core = Core::start();
    let bob = core.enroll();
    let session = core.session(&bob.device_credential);
    let id = random_id();
    let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
    assert_eq!(status, 200);
    let h: HandshakeResponse = serde_json::from_value(value).unwrap();
    let binding = Some((id.as_str(), h.connection_binding.as_str()));
    let invite = core
        .local
        .space_invite(InviteRequest {
            role: MemberRole::Member,
            member_id: Some(bob.member_id.clone()),
        })
        .unwrap();
    let (status, value) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":invite.code,"device_label":"Second laptop","display_name":"Bob"}),
    );
    assert_eq!(status, 200, "{value}");
    let second: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(second.member_id, bob.member_id);
    assert_ne!(second.device_id, bob.device_id);
    let second_session = core.session(&second.device_credential);
    let second_id = random_id();
    let (status, value) = core.handshake(
        &second_session.session_token,
        &second_id,
        ClientKind::RemoteMember,
    );
    assert_eq!(status, 200, "{value}");
    let second_handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    let second_binding = Some((
        second_id.as_str(),
        second_handshake.connection_binding.as_str(),
    ));
    let second_read = |read: Value| {
        let (status, value) = core.request("/core/v1/modules/workspace/read", &second_session.session_token, second_binding,
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"read":read}));
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
        value["payload"]["value"].clone()
    };
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "attention-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let local_apply = |intent: Value| {
        let (status,value)=core.local_request("/core/v1/modules/workspace/apply",Some((&host_id,&host.connection_binding)),json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":intent}));
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
        value
    };
    let remote_apply = |intent: Value| {
        let (status,value)=core.request("/core/v1/modules/workspace/apply",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":intent}));
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
        value
    };
    let remote_read = |read: Value| {
        let (status,value)=core.request("/core/v1/modules/workspace/read",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"read":read}));
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
        value["payload"]["value"].clone()
    };
    local_apply(
        json!({"kind":"create_project","project_id":"attention-project","name":"Attention","description":"","source_roots":["https://git.example/team/attention"]}),
    );
    local_apply(
        json!({"kind":"create_session","session_id":"shared-chat","project_id":null,"title":"Shared","initial_page_ids":[]}),
    );
    remote_apply(
        json!({"kind":"mutate_session","session_id":"shared-chat","intent":{"kind":"set_unread","unread":true}}),
    );
    let local = serde_json::to_value(
        core.local
            .workspace_read(
                None,
                ProjectWorkspaceRead::Session {
                    session_id: "shared-chat".into(),
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        local["payload"]["value"]["session"]["unread"], false,
        "{local}"
    );
    let remote = remote_read(json!({"kind":"session","session_id":"shared-chat"}));
    assert_eq!(remote["session"]["unread"], true, "{remote}");
    assert_eq!(
        second_read(json!({"kind":"session","session_id":"shared-chat"}))["session"]["unread"],
        true
    );
    let (status, value) = core.request("/core/v1/modules/workspace/apply", &second_session.session_token, second_binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":{"kind":"mutate_session","session_id":"shared-chat","intent":{"kind":"set_unread","unread":false}}}));
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "ok", "{value}");
    assert_eq!(
        remote_read(json!({"kind":"session","session_id":"shared-chat"}))["session"]["unread"],
        false
    );
    local_apply(
        json!({"kind":"set_inbox_routing_consent","start_my_requests":false,"initialize_only":false}),
    );
    remote_apply(
        json!({"kind":"set_inbox_routing_consent","start_my_requests":true,"initialize_only":false}),
    );
    assert_eq!(
        remote_read(json!({"kind":"inbox_routing_consent"}))["start_my_requests"],
        true
    );
    assert_eq!(
        second_read(json!({"kind":"inbox_routing_consent"}))["start_my_requests"],
        true
    );
    let local = serde_json::to_value(
        core.local
            .workspace_read(None, ProjectWorkspaceRead::InboxRoutingConsent)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(local["payload"]["value"]["start_my_requests"], false);
    let capture = "019d0000-0000-7000-8000-000000000288";
    remote_apply(
        json!({"kind":"send_inbox_message","page_id":capture,"document_id":"019d0000-0000-7000-8000-000000000289","body":"A shared request","project_id":"attention-project"}),
    );
    let shared = json!({"kind":"inbox_window","scope":{"kind":"project","project_id":"attention-project"},"filter":"inbox","window":{"first":20}});
    let bob_inbox = remote_read(shared.clone());
    assert!(
        bob_inbox["items"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["page_id"] == capture)
    );
    let owner_inbox = serde_json::to_value(
        core.local
            .workspace_read(None, serde_json::from_value(shared).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(
        owner_inbox["payload"]["value"]["items"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["page_id"] == capture)
    );
    let db = "019d0000-0000-7000-8000-000000000281";
    let source = "019d0000-0000-7000-8000-000000000282";
    let view = "019d0000-0000-7000-8000-000000000283";
    let result=core.local.library_apply(None,serde_json::from_value(json!({"contract_version":nodex_core_contracts::LIBRARY_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":{"kind":"create_database","database_id":db,"data_source_id":source,"view_id":view,"name":"Work","parent":{"kind":"library","before":null}}})).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap()["status"], "ok");
    let (status,result)=core.request("/core/v1/modules/database/apply",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":[{"kind":"put_view_personal_preferences","view_id":view,"expected_revision":0,"rules_override":{},"presentation_override":{"group_direction":"desc"}}]}));
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["status"], "ok", "{result}");
    let (status,value)=core.request("/core/v1/modules/database/read",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"read":{"kind":"view_personal_preferences","view_id":view}}));
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["payload"]["value"]["value"]["revision"], 1, "{value}");
    let (status, second_preferences) = core.request("/core/v1/modules/database/read", &second_session.session_token, second_binding,
        json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"read":{"kind":"view_personal_preferences","view_id":view}}));
    assert_eq!(status, 200, "{second_preferences}");
    assert_eq!(
        second_preferences["payload"]["value"],
        value["payload"]["value"]
    );
    let (status, changed) = core.request("/core/v1/modules/database/apply", &second_session.session_token, second_binding,
        json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":[{"kind":"put_view_personal_preferences","view_id":view,"expected_revision":1,"rules_override":{},"presentation_override":{"group_direction":"asc"}}]}));
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["status"], "ok", "{changed}");
    let (status, first_preferences) = core.request("/core/v1/modules/database/read", &session.session_token, binding,
        json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"read":{"kind":"view_personal_preferences","view_id":view}}));
    assert_eq!(status, 200, "{first_preferences}");
    assert_eq!(
        first_preferences["payload"]["value"]["value"]["revision"],
        2
    );
    assert_eq!(
        first_preferences["payload"]["value"]["value"]["presentation_override"]["group_direction"],
        "asc"
    );
    let local = serde_json::to_value(
        core.local
            .database_read(
                None,
                serde_json::from_value(json!({"kind":"view_personal_preferences","view_id":view}))
                    .unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(local["payload"]["value"]["value"]["revision"], 0, "{local}");
    let (status,result)=core.request("/core/v1/modules/database/apply",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":[{"kind":"set_view_occurrence_disclosure","view_id":view,"target":{"kind":"group","occurrence_key":"GROUP_member"},"collapsed":true}]}));
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["status"], "ok", "{result}");
    let (_,collapsed)=core.request("/core/v1/modules/database/read",&session.session_token,binding,json!({"contract_version":nodex_core_contracts::DATABASE_CONTRACT_VERSION,"read":{"kind":"view_collapsed_occurrences","view_id":view}}));
    assert_eq!(
        collapsed["payload"]["value"]["value"]["targets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let local = serde_json::to_value(
        core.local
            .database_read(
                None,
                serde_json::from_value(json!({"kind":"view_collapsed_occurrences","view_id":view}))
                    .unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(
        local["payload"]["value"]["value"]["targets"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let page = "019d0000-0000-7000-8000-000000000284";
    local_apply(
        json!({"kind":"create_page_for","for":{"kind":"project","project_id":"attention-project"},"page_id":page,"document_id":"019d0000-0000-7000-8000-000000000285","title":"Bob's work"}),
    );
    remote_apply(
        json!({"kind":"start_page_work","page_id":page,"selection":{"instanceId":"codex","model":"model","effort":null},"session_id":"bob-work","launch_id":"bob-launch","message_id":"bob-message","brief":"Work","again":false,"expected_readiness_epoch":null,"expected_turn_episode":null}),
    );
    let activity_read = json!({"kind":"activity_window","scope":{"kind":"all"},"filter":"all","window":{"first":100}});
    let activity = remote_read(activity_read.clone());
    let launch = activity["rows"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "launch:bob-launch")
        .expect("Bob's work launch");
    assert_eq!(
        launch["actor"],
        json!({"type":"member","member_id":session.principal.member_id})
    );
    assert_eq!(launch["actor_label"], "by You");
    let owner_activity = serde_json::to_value(
        core.local
            .workspace_read(None, serde_json::from_value(activity_read).unwrap())
            .unwrap(),
    )
    .unwrap();
    let launch = owner_activity["payload"]["value"]["rows"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "launch:bob-launch")
        .unwrap();
    assert_eq!(launch["actor_label"], "by Bob");
    local_apply(
        json!({"kind":"record_session_execution","session_id":"bob-work","expected_revision":0,"observation":{"state":"waiting","runId":"bob-run","runStartedAt":0,"pendingRequestIds":["question"],"pendingRequests":[{"id":"question","kind":"question","question":"Continue?","options":["Yes","No"]}],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"question","progressSince":0},"events":[],"resolved_request_ids":[]}),
    );
    let inbox = remote_read(
        json!({"kind":"inbox_window","scope":{"kind":"all"},"filter":"inbox","window":{"first":20}}),
    );
    let turn = inbox["items"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["page_id"] == page)
        .expect("Bob's Turn");
    let episode = turn["turn"]["turn"]["episode"].as_str().unwrap();
    let owner=serde_json::to_value(core.local.workspace_read(None,serde_json::from_value(json!({"kind":"inbox_window","scope":{"kind":"all"},"filter":"inbox","window":{"first":20}})).unwrap()).unwrap()).unwrap();
    assert!(
        !owner["payload"]["value"]["items"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["page_id"] == page),
        "{owner}"
    );
    let intents = remote_read(json!({"kind":"inbox_turn_notifications"}));
    assert!(
        intents["intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|intent| intent["page_id"] == page)
    );
    assert_eq!(
        second_read(json!({"kind":"inbox_turn_notifications"})),
        intents
    );
    let local = serde_json::to_value(
        core.local
            .workspace_read(None, ProjectWorkspaceRead::InboxTurnNotifications)
            .unwrap(),
    )
    .unwrap();
    assert!(
        !local["payload"]["value"]["intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|intent| intent["page_id"] == page)
    );
    let refused=core.local.workspace_apply(None,serde_json::from_value(json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":h.store_epoch,"operation_id":team_operation_id(),"intent":{"kind":"claim_turn_notification","page_id":page,"episode":episode}})).unwrap()).unwrap();
    assert!(
        matches!(refused.0,nodex_core_protocol::ResponseEnvelope::Error(error) if error.code==nodex_core_contracts::CoreErrorCode::Unauthorized)
    );
    remote_apply(json!({"kind":"claim_turn_notification","page_id":page,"episode":episode}));
    assert!(
        !second_read(json!({"kind":"inbox_turn_notifications"}))["intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|intent| intent["page_id"] == page)
    );
}
        "intent":{"kind":"create_project","project_id":"push-project","name":"Push","description":"","source_roots":["/tmp/nodex-push-test"]}}));
        "intent":{"kind":"create_project","project_id":"phone-project","name":"Phone","description":"","source_roots":["https://git.example/team/phone"]}}));
    for attempt in 0..DEVICE_REQUESTS_PER_MINUTE + 10 {
        envelope(json!({"kind":"create_project","project_id":"inbox-project","name":"Inbox","description":"","source_roots":[]})));

}

#[test]
fn each_member_keeps_their_own_pins_and_reminders_on_a_shared_chat() {
    use nodex_core_contracts::workspace::ProjectWorkspaceRead;
    let core = Core::start();
    let bob = core.enroll_as(MemberRole::Member, "Bob");
    let carol = core.enroll_as(MemberRole::Member, "Carol");
    let bob_member = bob.member_id.clone();
    let (bob, carol) = (Remote::connect(&core, &bob), Remote::connect(&core, &carol));
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "attention-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let local_apply = |intent: Value| {
        let (status, value) = core.local_request(
            "/core/v1/modules/workspace/apply",
            Some((&host_id, &host.connection_binding)),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                "store_epoch":host.store_epoch,"operation_id":team_operation_id(),"intent":intent}),
        );
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
    };
    let next_reminder = || {
        serde_json::to_value(
            core.local
                .workspace_read(None, ProjectWorkspaceRead::NextSessionReminder)
                .unwrap(),
        )
        .unwrap()["payload"]["value"]
            .clone()
    };
    local_apply(
        json!({"kind":"create_session","session_id":"shared-chat","project_id":null,
        "title":"Shared","initial_page_ids":[]}),
    );
    let chat = || json!({"kind":"session","session_id":"shared-chat"});
    let attention =
        |intent: Value| json!({"kind":"mutate_session","session_id":"shared-chat","intent":intent});

    // Pins and their order are each Member's own.
    assert_eq!(
        bob.apply(attention(json!({"kind":"set_pinned","pinned":true})))["status"],
        "ok"
    );
    let pinned = bob.read(chat())["session"].clone();
    assert_eq!(
        (pinned["pinned"].clone(), pinned["pinned_order"].clone()),
        (json!(true), json!(0))
    );
    assert_eq!(carol.read(chat())["session"]["pinned"], false);
    assert_eq!(
        carol.apply(attention(json!({"kind":"set_pinned","pinned":true})))["status"],
        "ok"
    );
    assert_eq!(
        carol.apply(attention(json!({"kind":"set_pinned","pinned":false})))["status"],
        "ok"
    );
    assert_eq!(bob.read(chat())["session"]["pinned"], true);
    assert_eq!(carol.read(chat())["session"]["pinned"], false);

    // So are reminders, which the host delivers to the Member who set one.
    assert_eq!(
        bob.apply(attention(
            json!({"kind":"set_reminder","remind_at":"2020-01-01T00:00:00Z"})
        ))["status"],
        "ok"
    );
    assert_eq!(
        bob.read(chat())["session"]["remind_at"],
        "2020-01-01T00:00:00.000Z"
    );
    assert_eq!(carol.read(chat())["session"]["remind_at"], Value::Null);
    let due = next_reminder();
    assert_eq!(due["member_id"], json!(bob_member));
    assert_eq!(due["session"]["remind_at"], "2020-01-01T00:00:00.000Z");
    // Delivery is host bookkeeping, never a Member command.
    let claim = attention(json!({"kind":"consume_reminder","member_id":bob_member,
        "remind_at":"2020-01-01T00:00:00.000Z","deliver":true}));
    assert_eq!(bob.apply(claim.clone())["payload"]["code"], "unauthorized");
    local_apply(claim);
    let delivery = next_reminder()["delivery"]["delivery_id"].clone();
    assert!(delivery.is_string(), "{delivery}");
    local_apply(attention(
        json!({"kind":"complete_reminder_delivery","delivery_id":delivery,"unread":true}),
    ));
    let reminded = bob.read(chat())["session"].clone();
    assert_eq!(
        (reminded["unread"].clone(), reminded["remind_at"].clone()),
        (json!(true), Value::Null)
    );
    assert_eq!(carol.read(chat())["session"]["unread"], false);
    // Each Member's Dock counts their own unread chats in this Space.
    let unread =
        |member: &Remote| member.read(json!({"kind":"unread_chat_count"}))["count"].clone();
    assert_eq!((unread(&bob), unread(&carol)), (json!(1), json!(0)));
    assert_eq!(next_reminder()["session"], Value::Null);
    let (remote_connection_id, remote_connection_binding) =
#[test]
fn a_space_rename_reaches_each_members_live_event_stream() {
    let core = Core::start();
    let bob = core.enroll();
    let session = core.session(&bob.device_credential);
    let id = random_id();
    let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
    assert_eq!(status, 200, "{value}");
    let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
    let mut live = core.stream(
        &session.session_token,
        &id,
        &handshake.connection_binding,
        handshake.commit_head,
    );
    until(&mut live, "event: stream-checkpoint");
    let renamed = Instant::now();
    core.local.space_rename("Platform".into()).unwrap();
    // A connected desktop learns of the new name at once, before the stream's heartbeat.
    loop {
        let mut line = String::new();
        assert!(live.read_line(&mut line).unwrap() > 0, "Stream closed");
        if line.contains("\"operation\":\"rename_space\"") {
            break;
        }
        assert!(
            renamed.elapsed() < Duration::from_secs(5),
            "The rename waited for another commit"
        );
    }
}

#[test]
fn members_name_themselves_and_the_local_owner_starts_with_a_real_name() {
    let core = Core::start();
    let owner = || {
        core.local
            .space_members()
            .unwrap()
            .into_iter()
            .find(|member| member.role == MemberRole::Owner)
            .unwrap()
    };
    // Others read the local Owner by the name its OS account gives its person, never "You".
    assert_eq!(
        owner().display_name,
        nodex_core::library::default_owner_name()
    );
    assert_eq!(
        core.local
            .space_rename_member("Jun Yu".into())
            .unwrap()
            .display_name,
        "Jun Yu"
    );
    assert_eq!(owner().display_name, "Jun Yu");
    let bob = core.enroll();
    let session = core.session(&bob.device_credential);
    let rename = |name: &str| {
        core.request(
            "/core/v1/admin/space/member-name",
            &session.session_token,
            None,
            json!({ "name": name }),
        )
    };
    let (status, renamed) = rename("Robert");
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(
        (renamed["id"].as_str(), renamed["display_name"].as_str()),
        (Some(bob.member_id.as_str()), Some("Robert"))
    );
    assert_eq!(rename(" you ").0, 400);
    assert_eq!(owner().display_name, "Jun Yu");
}

