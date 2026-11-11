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
    path::Path,
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
        let child = Self::spawn(home.path(), None);
        let local = CoreClient::connect(home.path(), "team-test").unwrap();
        let info = local
            .space_listen(ListenRequest {
                peer_policy: Default::default(),
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
    fn restart(&mut self, operator_address: Option<&str>) {
        let _ = self.child.kill();
        self.child.wait().unwrap();
        self.child = Self::spawn(self.home.path(), operator_address);
        self.local = CoreClient::connect(self.home.path(), "transport-restart").unwrap();
    }

    fn spawn(home: &Path, operator_address: Option<&str>) -> Child {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nodex-core"));
        command.arg("--home").arg(home);
        if let Some(address) = operator_address {
            command.args(["--listen", address]);
        }
        // Restart and shutdown assertions own the Core process handle. On Windows
        // the regular launcher re-execs Core, which can outlive the launcher.
        #[cfg(windows)]
        command.env("NODEX_CORE_ISOLATED_LAUNCH", "1");
        let mut child = command
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
        let selection: CoreSelectionResult = serde_json::from_str(&line).unwrap();
        assert_eq!(
            selection.descriptor.pid,
            child.id(),
            "fixture must own Core"
        );
        child
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
        self.request_method("POST", path, token, binding, body)
    }
    fn request_method(
        &self,
        method: &str,
        path: &str,
        token: &str,
        binding: Option<(&str, &str)>,
        body: Value,
    ) -> (u16, Value) {
        let mut tls = self.tls(&self.info.fingerprint).unwrap();
        let bytes = serde_json::to_vec(&body).unwrap();
        let (id, binding) = binding.unwrap_or(("", ""));
        write!(tls,"{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nx-nodex-request-id: request:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",random_id(),bytes.len()).unwrap();
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
        self.local_request_proof(path, binding, body, None)
    }
    fn local_request_proof(
        &self,
        path: &str,
        binding: Option<(&str, &str)>,
        body: Value,
        proof: Option<&str>,
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
        let proof = proof
            .map(|p| format!("x-nodex-host-invocation: {p}\r\n"))
            .unwrap_or_default();
        write!(stream,"POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\n{proof}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",auth.trim(),body.len()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        decode_response(&response)
    }
    fn enroll(&self) -> EnrollmentResponse {
        self.enroll_as(MemberRole::Member, "Bob")
    }
    fn enroll_as(&self, role: MemberRole, name: &str) -> EnrollmentResponse {
        let invite = self
            .local
            .space_invite(InviteRequest {
                role,
                member_id: None,
            })
            .unwrap();
        let (status, response) = self.request(
            "/enroll",
            "",
            None,
            json!({"code":invite.code,"device_label":"Test device","display_name":name}),
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
    // Write a complete request in one TLS record so serial requests exercise the
    // rate window without spending most of it waiting for TCP acknowledgments.
    let mut request = format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nx-nodex-request-id: request:{}\r\nContent-Length: {}\r\n\r\n", random_id(), bytes.len()).into_bytes();
    request.extend_from_slice(&bytes);
    stream.get_mut().write_all(&request).unwrap();
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
                json!({"role":"owner"})
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
        core.request_method(
            "GET",
            "/core/v1/admin/space/devices",
            &session.session_token,
            None,
            json!({})
        )
        .0,
        200
    );
    for path in [
        "/core/v1/admin/space/listen",
        "/core/v1/admin/space/stop-listener",
        "/core/v1/admin/space/prepare",
        "/core/v1/shutdown",
        "/core/v1/admin/host/register",
    ] {
        assert_eq!(
            core.request(path, &session.session_token, None, json!({}))
                .0,
            403,
            "{path}"
        );
    }
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
    assert!(
        second_read(shared.clone())["items"]["items"]
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
        !owner_inbox["payload"]["value"]["items"]["items"]
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

#[test]
fn personal_device_link_and_remote_owner_administration_share_core_identity() {
    let core = Core::start();
    let offer = core.local.space_link_device().unwrap();
    let db = rusqlite::Connection::open(core.home.path().join("nodex.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT space_kind FROM libraries", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "personal"
    );
    let (status,value)=core.request("/enroll","",None,json!({"code":offer.code,"device_label":"Phone","display_name":"Ignored name","form_factor":"phone"}));
    assert_eq!(status, 200, "{value}");
    let device: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(device.member_id, offer.member_id);
    let session = core.session(&device.device_credential);
    let token = &session.session_token;
    let (_, devices) = core.request_method(
        "GET",
        "/core/v1/admin/space/devices",
        token,
        None,
        json!({}),
    );
    assert_eq!(devices[0]["form_factor"], "phone");
    assert_eq!(devices[0]["space_id"], device.space_id);
    let connection = nodex_core_protocol::client::RemoteConnection {
        url: core.info.url.clone(),
        fingerprint: core.info.fingerprint.clone(),
        space_id: device.space_id.clone(),
        device_credential: device.device_credential.clone(),
    };
    let native = CoreClient::connect_remote(&connection, "identity-test").unwrap();
    native.space_rename("Remote personal".into()).unwrap();
    assert_eq!(native.space_members().unwrap().len(), 1);
    assert_eq!(
        db.query_row("SELECT space_kind FROM libraries", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "personal"
    );
    let offer2 = native.space_link_device().unwrap();
    assert_eq!(offer2.member_id, device.member_id);
    let (status, value) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":offer2.code,"device_label":"Second Owner Device","display_name":"Ignored"}),
    );
    assert_eq!(status, 200, "{value}");
    let owner_second: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(owner_second.member_id, device.member_id);
    let owner_second_session = core.session(&owner_second.device_credential);
    let (status, invite) = core.request(
        "/core/v1/admin/space/invite",
        token,
        None,
        json!({"role":"member"}),
    );
    assert_eq!(status, 200, "{invite}");
    let (status, value) = core.request(
        "/enroll",
        "",
        None,
        json!({"code":invite["code"],"device_label":"Teammate","display_name":"Teammate"}),
    );
    assert_eq!(status, 200, "{value}");
    let teammate: EnrollmentResponse = serde_json::from_value(value).unwrap();
    let teammate_session = core.session(&teammate.device_credential);
    let (status, linked) = core.request(
        "/core/v1/admin/space/link-device",
        &teammate_session.session_token,
        None,
        json!({}),
    );
    assert_eq!(status, 200, "{linked}");
    assert_eq!(linked["member_id"], teammate.member_id);
    let (status, value) = core.request("/enroll", "", None,
        json!({"code":linked["code"],"device_label":"Second Member Device","display_name":"Ignored"}));
    assert_eq!(status, 200, "{value}");
    let teammate_second: EnrollmentResponse = serde_json::from_value(value).unwrap();
    assert_eq!(teammate_second.member_id, teammate.member_id);
    let teammate_second_session = core.session(&teammate_second.device_credential);
    for _ in 1..6 {
        let (status, value) = core.request(
            "/core/v1/admin/space/link-device",
            &teammate_session.session_token,
            None,
            json!({}),
        );
        assert_eq!(status, 200, "{value}");
    }
    let (status, limited) = core.request(
        "/core/v1/admin/space/link-device",
        &teammate_session.session_token,
        None,
        json!({}),
    );
    assert_eq!(status, 429, "{limited}");
    assert_eq!(limited["payload"]["recovery"]["kind"], "retry_after");
    assert_eq!(
        limited["payload"]["recovery"]["budget"],
        "member_device_links"
    );
    assert!(
        (1..=3_600_000).contains(
            &limited["payload"]["recovery"]["milliseconds"]
                .as_u64()
                .unwrap()
        )
    );
    for (path, body) in [
        ("invite", json!({"role":"owner"})),
        ("name", json!({"name":"Forbidden"})),
        ("remove-member", json!({"member_id":device.member_id})),
        ("revoke", json!({"device_id":device.device_id})),
    ] {
        let (status, value) = core.request(
            &format!("/core/v1/admin/space/{path}"),
            &teammate_session.session_token,
            None,
            body,
        );
        assert_eq!(status, 403, "{path}: {value}");
        assert_eq!(value["payload"]["recovery"]["kind"], "none", "{value}");
    }
    let (status, own) = core.request_method(
        "GET",
        "/core/v1/admin/space/devices",
        &teammate_session.session_token,
        None,
        json!({}),
    );
    assert_eq!(status, 200);
    assert_eq!(own.as_array().unwrap().len(), 2);
    assert!(
        own.as_array()
            .unwrap()
            .iter()
            .all(|item| item["member_id"] == teammate.member_id)
    );
    let (status, forbidden) = core.request_method(
        "GET",
        "/core/v1/admin/space/members",
        &teammate_session.session_token,
        None,
        json!({}),
    );
    assert_eq!(status, 403, "{forbidden}");
    assert_eq!(forbidden["payload"]["recovery"]["kind"], "none");
    assert_eq!(
        core.request(
            "/core/v1/admin/space/revoke",
            &teammate_session.session_token,
            None,
            json!({"device_id":teammate.device_id})
        )
        .0,
        200
    );
    assert_eq!(
        core.request_method(
            "GET",
            "/core/v1/admin/space/devices",
            &teammate_session.session_token,
            None,
            json!({})
        )
        .0,
        401
    );
    let (status, withdrawn) = core.request(
        "/session",
        "",
        None,
        json!({"device_credential":teammate.device_credential}),
    );
    assert_eq!(status, 401, "{withdrawn}");
    assert_eq!(
        withdrawn["payload"]["recovery"]["kind"],
        "remote_access_withdrawn"
    );
    assert_eq!(
        core.request_method(
            "GET",
            "/core/v1/admin/space/devices",
            &teammate_second_session.session_token,
            None,
            json!({})
        )
        .0,
        200
    );
    core.session(&teammate_second.device_credential);

    native
        .space_revoke(RevokeDeviceRequest {
            device_id: teammate_second.device_id,
        })
        .unwrap();
    let (status, withdrawn) = core.request(
        "/session",
        "",
        None,
        json!({"device_credential":teammate_second.device_credential}),
    );
    assert_eq!(status, 401, "{withdrawn}");
    assert_eq!(
        withdrawn["payload"]["recovery"]["kind"],
        "remote_access_withdrawn"
    );
    for session in [&session, &owner_second_session] {
        assert_eq!(
            core.request_method(
                "GET",
                "/core/v1/admin/space/devices",
                &session.session_token,
                None,
                json!({})
            )
            .0,
            200
        );
    }
    core.session(&device.device_credential);
    core.session(&owner_second.device_credential);
    native
        .space_remove_member(RemoveMemberRequest {
            member_id: teammate.member_id,
        })
        .unwrap();
    // Wrong pin fails before the session endpoint receives the Device credential.
    let mut wrong = connection;
    wrong.fingerprint = "0".repeat(64);
    assert!(CoreClient::connect_remote(&wrong, "identity-test").is_err());
    let db = rusqlite::Connection::open(core.home.path().join("nodex.db")).unwrap();
    let kind: String = db
        .query_row("SELECT space_kind FROM libraries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kind, "team");
}

#[test]
fn phone_hello_space_kind_tracks_membership_instead_of_remote_access() {
    use tungstenite::client::IntoClientRequest;
    let core = Core::start();
    let offer = core.local.space_link_device().unwrap();
    let (status, enrolled) = core.request(
        "/enroll", "", None,
        json!({"code":offer.code,"device_label":"Owner phone","display_name":"Owner","form_factor":"phone"}),
    );
    assert_eq!(status, 200, "{enrolled}");
    let device: EnrollmentResponse = serde_json::from_value(enrolled).unwrap();
    let session = core.session(&device.device_credential);
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let connect = || {
        let mut request = format!(
            "{}/core/v1/phone",
            core.info.url.replace("https://", "wss://")
        )
        .into_client_request()
        .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", session.session_token).parse().unwrap(),
        );
        tungstenite::client(request, core.tls(&core.info.fingerprint).unwrap())
            .unwrap()
            .0
    };
    let _personal = connect();
    let (status, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(status, 200, "{open}");
    assert_eq!(open["kind"], "open");
    assert_eq!(open["space_kind"], "personal");
    assert_eq!(open["member_id"], offer.member_id);

    let second = core.enroll();
    assert_ne!(second.member_id, device.member_id);
    let _team = connect();
    let (status, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(status, 200, "{open}");
    assert_eq!(open["kind"], "open");
    assert_eq!(open["space_kind"], "team");

    core.local
        .space_remove_member(RemoveMemberRequest {
            member_id: second.member_id,
        })
        .unwrap();
    let _after_removal = connect();
    let (status, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(status, 200, "{open}");
    assert_eq!(open["space_kind"], "team");
}

#[test]
fn a_phone_holding_only_its_channel_open_stays_seen() {
    use tungstenite::client::IntoClientRequest;
    let core = Core::start();
    let offer = core.local.space_link_device().unwrap();
    let (status, enrolled) = core.request(
        "/enroll", "", None,
        json!({"code":offer.code,"device_label":"Phone","display_name":"Owner","form_factor":"phone"}),
    );
    assert_eq!(status, 200, "{enrolled}");
    let device: EnrollmentResponse = serde_json::from_value(enrolled).unwrap();
    let session = core.session(&device.device_credential);
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let db = rusqlite::Connection::open(core.home.path().join("nodex.db")).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    let epoch = |at: SystemTime| at.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let last_seen = || -> i64 {
        db.query_row(
            "SELECT last_seen FROM member_devices WHERE id=?1",
            [&device.device_id],
            |row| row.get(0),
        )
        .unwrap()
    };
    // The phone was last seen 38 minutes ago, then opens its channel and sends nothing more.
    let stale = epoch(SystemTime::now()) - 38 * 60;
    db.execute(
        "UPDATE member_devices SET last_seen=?2 WHERE id=?1",
        rusqlite::params![device.device_id, stale],
    )
    .unwrap();
    let mut request = format!(
        "{}/core/v1/phone",
        core.info.url.replace("https://", "wss://")
    )
    .into_client_request()
    .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", session.session_token).parse().unwrap(),
    );
    let opened = epoch(SystemTime::now());
    let (_phone, _) = tungstenite::client(request, core.tls(&core.info.fingerprint).unwrap())
        .expect("phone channel");
    let deadline = Instant::now() + Duration::from_secs(5);
    while last_seen() == stale && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        last_seen() >= opened,
        "an open phone channel keeps its Device seen"
    );
}

#[test]
fn phone_push_registration_is_the_phones_own_request_and_recipients_follow_core() {
    use tungstenite::{Message, client::IntoClientRequest};
    let core = Core::start();
    let offer = core.local.space_link_device().unwrap();
    let (status, enrolled) = core.request(
        "/enroll", "", None,
        json!({"code":offer.code,"device_label":"Owner phone","display_name":"Owner","form_factor":"phone"}),
    );
    assert_eq!(status, 200, "{enrolled}");
    let device: EnrollmentResponse = serde_json::from_value(enrolled).unwrap();
    let session = core.session(&device.device_credential);
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let mut request = format!(
        "{}/core/v1/phone",
        core.info.url.replace("https://", "wss://")
    )
    .into_client_request()
    .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", session.session_token).parse().unwrap(),
    );
    let (mut phone, _) =
        tungstenite::client(request, core.tls(&core.info.fingerprint).unwrap()).unwrap();
    let (_, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(open["kind"], "open");
    let commit = |credential: &Value| {
        core.local_request(
            "/core/v1/host/phone/push",
            None,
            json!({"credential":credential}),
        )
    };
    assert_ne!(
        commit(&open["credential"]).0,
        200,
        "an observation proof is not the phone's registration"
    );
    let registration = json!({"handle":"relay-handle","key":"A".repeat(43),"preferences":{"needsYou":true,"finished":true}});
    phone
        .send(Message::text(
            json!({"t":"req","id":1,"m":"push.register","p":registration}).to_string(),
        ))
        .unwrap();
    let (_, registered) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(registered["method"], "push.register");
    let (status, committed) = commit(&registered["credential"]);
    assert_eq!(status, 200, "{committed}");
    let devices = core.local.space_devices().unwrap();
    let listed = serde_json::to_value(&devices).unwrap().to_string();
    assert!(
        devices
            .iter()
            .any(|d| d.id == device.device_id && d.notifications_enabled)
    );
    assert!(
        !listed.contains("relay-handle"),
        "listings never carry the handle or key"
    );

    let recipients = |audience: Value| {
        core.local_request(
            "/core/v1/host/phone/push-recipients",
            None,
            json!({"token":lease["token"],"session_id":"push-session","audience":audience}),
        )
    };
    let (status, _) = core.local_request(
        "/core/v1/host/phone/push-recipients",
        None,
        json!({"token":"0".repeat(64),"session_id":"push-session","audience":{"kind":"run_requester","run_id":"run"}}),
    );
    assert_ne!(status, 200, "recipients need the live Host lease");
    let (status, none) = recipients(json!({"kind":"run_requester","run_id":"run"}));
    assert_eq!((status, none.clone()), (200, json!([])), "{none}");
    let host_id = random_id();
    let (_, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "push-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let binding = Some((host_id.as_str(), host.connection_binding.as_str()));
    let source_root = nodex_platform::fixture_path!("/tmp/nodex-push-test");
    let (_, initialized) = core.local_request("/core/v1/modules/workspace/apply",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,"operation_id":team_operation_id(),
        "intent":{"kind":"create_project","project_id":"push-project","name":"Push","description":"","source_roots":[source_root]}}));
    assert_eq!(initialized["status"], "ok", "{initialized}");
    let (_, created) = core.local_request("/core/v1/modules/workspace/apply",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,
        "operation_id":team_operation_id(),"intent":{"kind":"create_agent_runtime_session","session_id":"push-session",
        "project_id":null,"title":"Push","initial_page_ids":[],"runtime_id":"runtime","runtime_thread_id":"thread",
        "launch_request_id":"launch","coordinator":false}}));
    assert_eq!(created["status"], "ok", "{created}");
    // A personal Space's only Member hears about its chats, on the Device that registered.
    let (status, found) = recipients(json!({"kind":"request","run_id":"run","request":"question"}));
    assert_eq!(status, 200, "{found}");
    assert_eq!(found[0]["device_id"], device.device_id.as_str());
    assert_eq!(found[0]["member_id"], device.member_id.as_str());
    assert_eq!(found[0]["registration"], registration);

    let forget = |handle: &str| {
        core.local_request(
            "/core/v1/host/phone/push-forget",
            None,
            json!({"token":lease["token"],"device_id":device.device_id,"handle":handle}),
        )
        .1
    };
    assert_eq!(forget("another-handle"), json!(false));
    assert_eq!(forget("relay-handle"), json!(true));
    assert_eq!(
        recipients(json!({"kind":"run_requester","run_id":"run"})).1,
        json!([])
    );
}

#[test]
fn phone_stream_authentication_invocation_proofs_budgets_and_revocation() {
    use tungstenite::{Message, client::IntoClientRequest};
    let core = Core::start();
    let device = core.enroll();
    let session = core.session(&device.device_credential);
    let connect = |token: &str| {
        let mut request = format!(
            "{}/core/v1/phone",
            core.info.url.replace("https://", "wss://")
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        // The refused handshake carries a whole HTTP response; box it so the closure stays small.
        tungstenite::client(request, core.tls(&core.info.fingerprint).unwrap()).map_err(Box::new)
    };
    assert!(
        matches!(connect("not-a-session"),Err(error) if matches!(&*error, tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)) if response.status().as_u16()==401))
    );
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "phone-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let binding = Some((host_id.as_str(), host.connection_binding.as_str()));
    let (_, initialized) = core.local_request("/core/v1/modules/workspace/apply",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,"operation_id":team_operation_id(),
        "intent":{"kind":"create_project","project_id":"phone-project","name":"Phone","description":"","source_roots":["https://git.example/team/phone"]}}));
    assert_eq!(initialized["status"], "ok", "{initialized}");
    let read = |proof: &str| {
        core.local_request_proof("/core/v1/modules/workspace/read",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"read":{"kind":"inbox_routing_consent"}}),Some(proof))
    };
    let (mut phone, _) = connect(&session.session_token).unwrap();
    let (status, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(status, 200, "{open}");
    assert_eq!(open["kind"], "open");
    assert_eq!(open["member_id"], device.member_id);
    let channel = open["channel_id"].clone();
    let publish = |envelope: Value| {
        core.local_request(
            "/core/v1/host/phone/publish",
            None,
            json!({"token":lease["token"],"channel_id":channel,"envelope":envelope}),
        )
    };
    assert_eq!(publish(json!({"t":"hello","d":{"test":true}})).1, true);
    assert!(phone.read().unwrap().into_text().unwrap().contains("hello"));
    phone
        .send(Message::text(
            json!({"t":"req","id":1,"m":"inbox.window","p":{}}).to_string(),
        ))
        .unwrap();
    let (_, request) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(request["kind"], "request");
    assert_ne!(open["credential"], request["credential"]);
    assert_eq!(read(open["credential"].as_str().unwrap()).1["status"], "ok");
    assert_eq!(
        read(request["credential"].as_str().unwrap()).1["status"],
        "ok"
    );
    let mutate = |proof: &str| {
        core.local_request_proof("/core/v1/modules/workspace/apply",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,
        "operation_id":team_operation_id(),"intent":{"kind":"set_inbox_routing_consent","start_my_requests":true,"initialize_only":false}}),Some(proof))
    };
    assert_eq!(
        mutate(open["credential"].as_str().unwrap()).0,
        403,
        "observation proof cannot write"
    );
    let mutation = mutate(request["credential"].as_str().unwrap()).1;
    assert_eq!(mutation["status"], "ok", "{mutation}");

    let (_, created) = core.local_request("/core/v1/modules/workspace/apply",binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,
        "operation_id":team_operation_id(),"intent":{"kind":"create_agent_runtime_session","session_id":"phone-delivery-session",
        "project_id":null,"title":"Delivery","initial_page_ids":[],"runtime_id":"runtime","runtime_thread_id":"thread",
        "launch_request_id":"launch","coordinator":false}}));
    assert_eq!(created["status"], "ok", "{created}");
    let delivery = |proof: &str, id: &str, author: Value| {
        core.local_request_proof("/core/v1/modules/workspace/apply",binding,
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,
            "operation_id":team_operation_id(),"intent":{"kind":"record_chat_delivery","session_id":"phone-delivery-session",
            "delivery_id":id,"body_hash":"0".repeat(64),"author":author,"attachment_count":0,"question_answer_run_id":null}}),Some(proof)).1
    };
    assert_eq!(
        delivery(
            request["credential"].as_str().unwrap(),
            "phone-message",
            json!({"kind":"user"})
        )["status"],
        "error",
        "An unrelated Member invocation cannot fabricate delivery evidence"
    );

    assert_eq!(publish(json!({"t":"res","id":1,"ok":true,"r":{}})).1, true);
    assert!(phone.read().unwrap().into_text().unwrap().contains("res"));
    assert_eq!(
        publish(json!({"t":"res","id":1,"ok":true,"r":{}})).1,
        false,
        "completed proof cannot replay"
    );
    assert_eq!(
        read(request["credential"].as_str().unwrap()).1["status"],
        "error",
        "completed proof must retire"
    );
    phone.send(Message::text(json!({"t":"req","id":2,"m":"chat.send","p":{
        "sessionId":"phone-delivery-session","messageId":"phone-message","text":"Hello","fileRefs":[],"delivery":"queue"
    }}).to_string())).unwrap();
    let (_, message) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    let proof = message["credential"].as_str().unwrap();
    assert_eq!(
        delivery(proof, "another-message", json!({"kind":"user"}))["status"],
        "error"
    );
    assert_eq!(
        delivery(
            proof,
            "phone-message",
            json!({"kind":"agent","session_id":null,"thread_id":null,"run_id":null,"project_id":null,"label":"Agent"})
        )["status"],
        "error"
    );
    let accepted = delivery(proof, "phone-message", json!({"kind":"user"}));
    assert_eq!(accepted["status"], "ok", "{accepted}");
    assert_eq!(publish(json!({"t":"res","id":2,"ok":true,"r":{}})).1, true);
    assert!(phone.read().unwrap().into_text().unwrap().contains("res"));
    assert_eq!(
        delivery(proof, "phone-message", json!({"kind":"user"}))["status"],
        "error"
    );
    // The network cannot use either a local lease or an invocation proof to impersonate a Host.
    assert_eq!(
        core.request(
            "/core/v1/host/phone/publish",
            &session.session_token,
            None,
            json!({"token":lease["token"],"channel_id":channel,"envelope":{}})
        )
        .0,
        403
    );
    core.local
        .space_revoke(RevokeDeviceRequest {
            device_id: device.device_id.clone(),
        })
        .unwrap();
    let started = Instant::now();
    let closed = phone.read();
    assert!(closed.is_err() || matches!(closed, Ok(Message::Close(_))));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(publish(json!({"t":"evt","k":"changed","d":{}})).1, false);
    assert!(connect(&session.session_token).is_err());

    // Fresh Device: every WebSocket frame spends the same Device/Member request budget as HTTPS.
    let second = core.enroll();
    let second_session = core.session(&second.device_credential);
    let (mut phone, _) = connect(&second_session.session_token).unwrap();
    let (_, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(open["kind"], "close");
    let (_, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(open["kind"], "open");
    let mut metered = false;
    for attempt in 0..DEVICE_REQUESTS_PER_MINUTE + 10 {
        if attempt % 100 == 0 {
            core.local_request("/core/v1/host/phone/publish",None,json!({"token":lease["token"],"channel_id":"lease-heartbeat","envelope":{"t":"pong"}}));
        }
        phone.send(Message::text("{\"t\":\"ping\"}")).unwrap();
        match phone.read() {
            Ok(Message::Text(_)) => {}
            Ok(Message::Close(Some(frame))) => {
                assert!(frame.reason.contains("budget"), "{frame:?}");
                metered = true;
                break;
            }
            value => panic!("unexpected frame {value:?}"),
        }
    }
    assert!(metered, "phone frames must exhaust the Device budget");
    let third = core.enroll();
    let third_session = core.session(&third.device_credential);
    let (mut phone, _) = connect(&third_session.session_token).unwrap();
    let channel = loop {
        let (_, event) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
        if event["kind"] == "open" && event["device_id"] == third.device_id {
            break event["channel_id"].clone();
        }
    };
    let large =
        json!({"t":"evt","k":"changed","d":{"topics":["inbox"],"padding":"x".repeat(900_000)}});
    let mut bytes_metered = false;
    for _ in 0..40 {
        let (_, accepted) = core.local_request(
            "/core/v1/host/phone/publish",
            None,
            json!({"token":lease["token"],"channel_id":channel,"envelope":large}),
        );
        assert_eq!(accepted, true);
        match phone.read() {
            Ok(Message::Text(_)) => {}
            Ok(Message::Close(Some(frame))) => {
                assert!(frame.reason.contains("byte budget"), "{frame:?}");
                bytes_metered = true;
                break;
            }
            value => panic!("unexpected byte-budget frame {value:?}"),
        }
    }
    assert!(
        bytes_metered,
        "upgraded outbound frames must exhaust the Device byte budget"
    );
    let fourth = core.enroll();
    let fourth_session = core.session(&fourth.device_credential);
    let mut streams = Vec::new();
    for _ in 0..8 {
        streams.push(connect(&fourth_session.session_token).unwrap().0);
    }
    assert!(
        matches!(connect(&fourth_session.session_token),Err(error) if matches!(&*error, tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)) if response.status().as_u16()==429))
    );
    drop(streams);
}

#[test]
fn member_inbox_decisions_start_work_only_through_the_space_host() {
    use tungstenite::{Message, client::IntoClientRequest};
    let core = Core::start();
    let device = core.enroll();
    let session = core.session(&device.device_credential);
    let remote_id = random_id();
    let (status, value) =
        core.handshake(&session.session_token, &remote_id, ClientKind::RemoteMember);
    assert_eq!(status, 200, "{value}");
    let remote: HandshakeResponse = serde_json::from_value(value).unwrap();
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "inbox-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let host_binding = Some((host_id.as_str(), host.connection_binding.as_str()));
    let mut request = format!(
        "{}/core/v1/phone",
        core.info.url.replace("https://", "wss://")
    )
    .into_client_request()
    .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", session.session_token).parse().unwrap(),
    );
    let (mut phone, _) =
        tungstenite::client(request, core.tls(&core.info.fingerprint).unwrap()).unwrap();
    let (_, open) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(open["kind"], "open");
    phone
        .send(Message::text(
            json!({"t":"req","id":1,"m":"inbox.decide","p":{}}).to_string(),
        ))
        .unwrap();
    let (_, decide) = core.local_request("/core/v1/host/phone/poll", None, lease.clone());
    assert_eq!(decide["kind"], "request");
    let proof = decide["credential"].as_str().unwrap();
    let envelope = |intent: Value| {
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            "store_epoch":host.store_epoch,"operation_id":team_operation_id(),"intent":intent})
    };
    let carried = |path: &str, body: Value| {
        let (status, value) = core.local_request_proof(path, host_binding, body, Some(proof));
        assert_eq!(status, 200, "{value}");
        value
    };
    let (_, initialized) = core.local_request("/core/v1/modules/workspace/apply",host_binding,
        envelope(json!({"kind":"create_project","project_id":"inbox-project","name":"Inbox","description":"","source_roots":[]})));
    assert_eq!(initialized["status"], "ok", "{initialized}");
    let captured = carried(
        "/core/v1/modules/workspace/apply",
        envelope(
            json!({"kind":"send_inbox_message","page_id":"019d0000-0000-7000-8000-000000000301",
            "document_id":"019d0000-0000-7000-8000-000000000302","body":"Draft the release notes"}),
        ),
    );
    assert_eq!(captured["status"], "ok", "{captured}");
    let context = carried(
        "/core/v1/modules/workspace/read",
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            "read":{"kind":"inbox_dispatch_context","page_ids":["019d0000-0000-7000-8000-000000000301"]}}),
    );
    let basis = context["payload"]["value"]["context"]["entries"][0]["basis"].clone();
    let start = json!({"kind":"dispatch_inbox_entries","expected_store_epoch":host.store_epoch,
        "proposal_id":"019d0000-0000-7000-8000-000000000303","page_ids":["019d0000-0000-7000-8000-000000000301"],
        "basis":[basis],"session_id":"019d0000-0000-7000-8000-000000000304",
        "execution_selection":{"model_selection":{"instanceId":"codex","model":"gpt"},"interaction_mode":"default"},
        "action":{"type":"new_chat","project_id":null,"prompt":"Draft the release notes"}});

    // The Member's own HTTPS connection cannot turn a decision into Agent work directly.
    let (status, direct) = core.request(
        "/core/v1/modules/workspace/apply",
        &session.session_token,
        Some((remote_id.as_str(), remote.connection_binding.as_str())),
        envelope(start.clone()),
    );
    assert_eq!(status, 200, "{direct}");
    assert_eq!(direct["status"], "error", "{direct}");
    assert_eq!(
        direct["payload"]["message"],
        "Inbox decisions are confirmed through the Space host"
    );
    // The Space host carries the same decision with the Member's live invocation proof.
    let started = carried("/core/v1/modules/workspace/apply", envelope(start));
    assert_eq!(started["status"], "ok", "{started}");
}

/// One enrolled Member's authenticated HTTPS connection to the Space.
struct Remote<'a> {
    core: &'a Core,
    token: String,
    id: String,
    binding: String,
    store_epoch: String,
}
impl<'a> Remote<'a> {
    fn connect(core: &'a Core, enrollment: &EnrollmentResponse) -> Self {
        let session = core.session(&enrollment.device_credential);
        let id = random_id();
        let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
        assert_eq!(status, 200, "{value}");
        let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
        Self {
            core,
            token: session.session_token,
            id,
            binding: handshake.connection_binding,
            store_epoch: handshake.store_epoch,
        }
    }
    fn apply(&self, intent: Value) -> Value {
        let (status, value) = self.core.request(
            "/core/v1/modules/workspace/apply",
            &self.token,
            Some((&self.id, &self.binding)),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                "store_epoch":self.store_epoch,"operation_id":team_operation_id(),"intent":intent}),
        );
        assert_eq!(status, 200, "{value}");
        value
    }
    fn read(&self, read: Value) -> Value {
        let (status, value) = self.core.request(
            "/core/v1/modules/workspace/read",
            &self.token,
            Some((&self.id, &self.binding)),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"read":read}),
        );
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
        value["payload"]["value"].clone()
    }
}

#[test]
fn a_chats_owner_and_space_owners_change_it_and_stop_its_work_while_other_members_cannot() {
    let core = Core::start();
    let bob = core.enroll_as(MemberRole::Member, "Bob");
    let carol = core.enroll_as(MemberRole::Member, "Carol");
    let dana = core.enroll_as(MemberRole::Owner, "Dana");
    let (bob, carol, dana) = (
        Remote::connect(&core, &bob),
        Remote::connect(&core, &carol),
        Remote::connect(&core, &dana),
    );
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "stewardship-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let host_binding = Some((host_id.as_str(), host.connection_binding.as_str()));
    let envelope = |intent: Value| {
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            "store_epoch":host.store_epoch,"operation_id":team_operation_id(),"intent":intent})
    };
    let local_apply = |intent: Value| {
        let (status, value) = core.local_request(
            "/core/v1/modules/workspace/apply",
            host_binding,
            envelope(intent),
        );
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "ok", "{value}");
    };
    for project in ["steward-project", "steward-other"] {
        local_apply(
            json!({"kind":"create_project","project_id":project,"name":project,
            "description":"","source_roots":[format!("https://git.example/team/{project}")]}),
        );
    }
    // Bob's Start makes him the chat's owner.
    let page = "019d0000-0000-7000-8000-000000000401";
    local_apply(
        json!({"kind":"create_page_for","for":{"kind":"project","project_id":"steward-project"},
        "page_id":page,"document_id":"019d0000-0000-7000-8000-000000000402","title":"Bob's work"}),
    );
    let started = bob.apply(json!({"kind":"start_page_work","page_id":page,
        "selection":{"instanceId":"codex","model":"model","effort":null},"session_id":"bob-chat",
        "launch_id":"bob-launch","message_id":"bob-message","brief":"Work","again":false,
        "expected_readiness_epoch":null,"expected_turn_episode":null}));
    assert_eq!(started["status"], "ok", "{started}");
    let chat = json!({"kind":"session","session_id":"bob-chat"});
    let rename = |title: &str| json!({"kind":"mutate_session","session_id":"bob-chat","intent":{"kind":"rename","title":title}});
    let archive = |archived: bool| json!({"kind":"mutate_session","session_id":"bob-chat","intent":{"kind":"set_archived","archived":archived}});
    let mv =
        |project: &str| json!({"kind":"move_session","session_id":"bob-chat","project_id":project});
    let refused = |value: Value| {
        assert_eq!(value["status"], "error", "{value}");
        assert_eq!(value["payload"]["code"], "unauthorized", "{value}");
        assert_eq!(
            value["payload"]["message"],
            "Only the person who started this chat or a Space Owner can do this"
        );
    };

    // Each reader learns from Core whether the chat is theirs to change and its work to stop.
    let capabilities = |member: &Remote| {
        let session = member.read(chat.clone())["session"].clone();
        (session["can_manage"].clone(), session["can_stop"].clone())
    };
    assert_eq!(capabilities(&bob), (json!(true), json!(true)));
    assert_eq!(capabilities(&carol), (json!(false), json!(false)));
    assert_eq!(capabilities(&dana), (json!(true), json!(true)));

    // Another Member cannot rename, move or archive it, directly or through the Space host.
    refused(carol.apply(rename("Carol's title")));
    refused(carol.apply(mv("steward-other")));
    refused(carol.apply(archive(true)));
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            core.request(
                "/core/v1/host/call",
                &carol.token,
                Some((&carol.id, &carol.binding)),
                json!({"operation":"session_rename","input":{}}),
            )
        });
        let (status, invocation) =
            core.local_request("/core/v1/admin/host/poll", None, lease.clone());
        assert_eq!(status, 200, "{invocation}");
        let proof = invocation["credential"].as_str().unwrap();
        let (status, carried) = core.local_request_proof(
            "/core/v1/modules/workspace/apply",
            host_binding,
            envelope(rename("Carried for Carol")),
            Some(proof),
        );
        assert_eq!(status, 200, "{carried}");
        refused(carried);
        core.local_request(
            "/core/v1/admin/host/complete",
            None,
            json!({"token":lease["token"],"id":invocation["id"],"result":{"status":"ok","value":null}}),
        );
        assert_eq!(call.join().unwrap().0, 200);
    });
    assert_eq!(
        bob.read(chat.clone())["session"]["display_title"],
        "Bob's work"
    );

    // The chat's owner and a Space Owner can.
    assert_eq!(bob.apply(rename("Release notes"))["status"], "ok");
    assert_eq!(bob.apply(mv("steward-other"))["status"], "ok");
    assert_eq!(dana.apply(archive(true))["status"], "ok");
    let archived = carol.read(chat.clone())["session"].clone();
    assert_eq!(archived["display_title"], "Release notes");
    assert_eq!(archived["project_id"], "steward-other");
    assert_eq!(archived["archived"], true);
    refused(carol.apply(archive(false)));
    assert_eq!(bob.apply(archive(false))["status"], "ok");
    assert_eq!(carol.read(chat)["session"]["archived"], false);

    // Stopping the chat's work follows the same rule, before the host ever sees the call.
    let target = json!({"sessionId":"bob-chat","threadId":"thread","requestId":"request"});
    let stops = [
        ("session_stop", json!({"runId":"run"})),
        ("session_stop_task", json!({"runId":"run","taskId":"task"})),
        ("session_cancel_task", json!({"taskId":"task"})),
        ("session_stop_background", json!({"taskIds":["task"]})),
    ];
    let host_call = |member: &Remote, operation: &str, extra: &Value| {
        let mut input = target.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        core.request(
            "/core/v1/host/call",
            &member.token,
            Some((&member.id, &member.binding)),
            json!({"operation":operation,"input":input}),
        )
    };
    for (operation, extra) in &stops {
        let (status, value) = host_call(&carol, operation, extra);
        assert_eq!(status, 403, "{operation}: {value}");
    }
    for member in [&bob, &dana] {
        for (operation, extra) in &stops {
            std::thread::scope(|scope| {
                let call = scope.spawn(|| host_call(member, operation, extra));
                let (status, invocation) =
                    core.local_request("/core/v1/admin/host/poll", None, lease.clone());
                assert_eq!(status, 200, "{invocation}");
                assert_eq!(invocation["call"]["operation"], *operation);
                core.local_request(
                    "/core/v1/admin/host/complete",
                    None,
                    json!({"token":lease["token"],"id":invocation["id"],"result":{"status":"ok","value":null}}),
                );
                assert_eq!(call.join().unwrap().0, 200, "{operation}");
            });
        }
    }
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
}

#[test]
fn hosted_chat_attachments_are_read_with_the_members_authority_until_withdrawal() {
    let core = Core::start();
    let bob = core.enroll();
    let session = core.session(&bob.device_credential);
    let remote_id = random_id();
    let (status, value) =
        core.handshake(&session.session_token, &remote_id, ClientKind::RemoteMember);
    assert_eq!(status, 200, "{value}");
    let remote: HandshakeResponse = serde_json::from_value(value).unwrap();
    let (remote_connection_id, remote_connection_binding) =
        (remote_id.as_str(), remote.connection_binding.as_str());
    let remote_binding = Some((remote_connection_id, remote_connection_binding));
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let host_id = random_id();
    let (status, host) = core.local_request(
        "/core/v1/handshake",
        None,
        serde_json::to_value(HandshakeRequest {
            requirements: core_client_requirements(),
            client: ClientIdentity {
                kind: ClientKind::ElectronHost,
                build_id: "attachment-host".into(),
            },
            connection_id: host_id.clone(),
            expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
        })
        .unwrap(),
    );
    assert_eq!(status, 200, "{host}");
    let host: HandshakeResponse = serde_json::from_value(host).unwrap();
    let host_binding = Some((host_id.as_str(), host.connection_binding.as_str()));
    let (_, created) = core.local_request("/core/v1/modules/workspace/apply", host_binding,
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,"store_epoch":host.store_epoch,
        "operation_id":team_operation_id(),"intent":{"kind":"create_session","session_id":"photo-chat",
        "project_id":null,"title":"Photos","initial_page_ids":[]}}));
    assert_eq!(created["status"], "ok", "{created}");
    // The host reads the chat as the invoking Member before it reads any of its attachments.
    let read_chat = |proof: &str, session_id: &str| {
        core.local_request_proof(
            "/core/v1/modules/workspace/read",
            host_binding,
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            "read":{"kind":"session","session_id":session_id}}),
            Some(proof),
        )
        .1
    };
    let range = |offset: u64, version: Option<&str>| {
        let mut input = json!({"sessionId":"photo-chat","itemId":"phone-message","attachmentId":"photo",
            "offset":offset,"length":1_048_576});
        if let Some(version) = version {
            input["version"] = json!(version);
        }
        json!({"operation":"session_attachment","input":input})
    };
    let complete = |invocation: &Value, value: Value| {
        core.local_request(
            "/core/v1/admin/host/complete",
            None,
            json!({"token":lease["token"],"id":invocation["id"],"result":{"status":"ok","value":value}}),
        )
    };
    // A withdrawn Member's response may end before its body, so only the status line is read.
    let call_status = |body: Value| {
        let mut tls = core.tls(&core.info.fingerprint).unwrap();
        let bytes = serde_json::to_vec(&body).unwrap();
        let (id, binding) = (remote_connection_id, remote_connection_binding);
        write!(tls,"POST /core/v1/host/call HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",session.session_token,bytes.len()).unwrap();
        tls.write_all(&bytes).unwrap();
        tls.flush().unwrap();
        let mut line = String::new();
        BufReader::new(tls).read_line(&mut line).unwrap();
        line.split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u16>()
            .unwrap()
    };

    let chunk = json!({"base64":"iVBORw0KGgo=","totalBytes":16,"mimeType":"image/png",
        "name":"photo.png","version":"pinned"});
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            core.request(
                "/core/v1/host/call",
                &session.session_token,
                remote_binding,
                range(0, None),
            )
        });
        let (status, invocation) =
            core.local_request("/core/v1/admin/host/poll", None, lease.clone());
        assert_eq!(status, 200, "{invocation}");
        assert_eq!(invocation["call"]["operation"], "session_attachment");
        let proof = invocation["credential"].as_str().unwrap();
        // Core's own Session read admits this Space's chat for Bob, and nothing else.
        let chat = read_chat(proof, "photo-chat");
        assert_eq!(chat["status"], "ok", "{chat}");
        assert_eq!(chat["payload"]["value"]["session"]["id"], "photo-chat");
        assert_eq!(read_chat(proof, "another-chat")["status"], "error");
        assert_eq!(complete(&invocation, chunk.clone()).1, true);
        let (status, answered) = call.join().unwrap();
        assert_eq!(status, 200, "{answered}");
        assert_eq!(answered, json!({"status":"ok","value":chunk}));
    });

    // Revoking the Device between two ranges refuses the read in progress and every later one.
    std::thread::scope(|scope| {
        let call = scope.spawn(|| call_status(range(8, Some("pinned"))));
        let (_, invocation) = core.local_request("/core/v1/admin/host/poll", None, lease.clone());
        let proof = invocation["credential"].as_str().unwrap();
        assert_eq!(read_chat(proof, "photo-chat")["status"], "ok");
        core.local
            .space_revoke(RevokeDeviceRequest {
                device_id: bob.device_id.clone(),
            })
            .unwrap();
        let refused = read_chat(proof, "photo-chat");
        assert_eq!(refused["status"], "error", "{refused}");
        assert_eq!(refused["payload"]["code"], "unauthorized", "{refused}");
        assert_eq!(complete(&invocation, chunk.clone()).0, 503);
        assert_ne!(call.join().unwrap(), 200);
    });
    assert_eq!(call_status(range(0, None)), 401);
}

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

#[test]
fn personal_listener_keeps_its_certificate_and_saved_port_after_core_restart() {
    let mut core = Core::start();
    let fingerprint = core.info.fingerprint.clone();
    let address = core.info.url.trim_start_matches("https://").to_owned();
    let identity = fs::read(core.home.path().join("team-transport/server-identity.pem")).unwrap();
    let intent = core.local.space_remote_access().unwrap().intent;
    assert!(intent.enabled);
    assert_eq!(intent.address, address);
    core.restart(None);
    let restored = core.local.space_remote_access().unwrap();
    assert_eq!(
        restored.listener.as_ref().unwrap().url,
        core.info.url,
        "Core restores the saved listener before serving local clients"
    );
    assert!(!restored.routes_changed);
    assert_eq!(restored.intent, intent);
    core.info = core
        .local
        .space_listen(ListenRequest {
            address: address.clone(),
            cert: None,
            key: None,
            peer_policy: ListenerPeerPolicy::Private,
        })
        .unwrap();
    assert_eq!(core.info.url, format!("https://{address}"));
    assert_eq!(core.info.fingerprint, fingerprint);
    assert_eq!(
        fs::read(core.home.path().join("team-transport/server-identity.pem")).unwrap(),
        identity
    );
    assert!(core.tls(&fingerprint).is_ok());
    let disabled = core.local.space_stop_listener().unwrap();
    assert!(!disabled.intent.enabled);
    assert_eq!(disabled.intent.address, address);
    assert!(
        core.local
            .space_listen(ListenRequest {
                address: "192.0.2.254:8443".into(),
                cert: None,
                key: None,
                peer_policy: ListenerPeerPolicy::Private
            })
            .is_err()
    );
    assert_eq!(
        core.local.space_remote_access().unwrap().intent,
        disabled.intent,
        "a failed binding preserves valid intent"
    );
    core.local
        .space_listen(ListenRequest {
            address: "127.0.0.1:0".into(),
            cert: None,
            key: None,
            peer_policy: ListenerPeerPolicy::Operator,
        })
        .unwrap();
    assert_eq!(
        core.local.space_remote_access().unwrap().intent,
        disabled.intent,
        "operator hosting does not change personal intent"
    );
    assert_eq!(
        core.local.space_stop_listener().unwrap().intent,
        disabled.intent
    );
}

#[test]
fn personal_custom_certificate_paths_restore_without_changing_the_pin() {
    use nodex_core_protocol::client::RemoteConnection;
    let mut core = Core::start();
    let device = core.enroll();
    let fingerprint = core.info.fingerprint.clone();
    let address = core.info.url.trim_start_matches("https://").to_owned();
    let source = core.home.path().join("team-transport/server-identity.pem");
    let cert = core.home.path().join("custom-certificate.pem");
    nodex_platform::private_fs::write(&cert, fs::read(&source).unwrap()).unwrap();
    core.local.space_stop_listener().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match core.local.space_listen(ListenRequest {
            address: address.clone(),
            cert: Some(cert.to_string_lossy().into_owned()),
            key: Some(cert.to_string_lossy().into_owned()),
            peer_policy: ListenerPeerPolicy::Private,
        }) {
            Ok(info) => {
                core.info = info;
                break;
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("custom listener failed: {error}"),
        }
    }
    assert_eq!(core.info.fingerprint, fingerprint);
    core.child.kill().unwrap();
    core.child.wait().unwrap();
    fs::remove_file(&source).unwrap();
    core.restart(None);
    let restored = core.local.space_remote_access().unwrap();
    core.info = restored.listener.unwrap();
    assert!(!restored.routes_changed);
    assert_eq!(core.info.fingerprint, fingerprint);
    assert!(
        !source.exists(),
        "restoring custom trust never creates a substitute identity"
    );
    let remote = CoreClient::connect_remote(
        &RemoteConnection {
            url: core.info.url.clone(),
            fingerprint,
            space_id: device.space_id,
            device_credential: device.device_credential,
        },
        "custom-tls-proof",
    )
    .unwrap();
    assert!(remote.space_remote_access().unwrap().intent.enabled);
    assert!(
        serde_json::to_value(remote.space_remote_access().unwrap())
            .unwrap()
            .get("cert")
            .is_none()
    );
}

#[test]
fn personal_startup_uses_a_new_port_when_saved_address_is_occupied() {
    let mut core = Core::start();
    let original = core.info.clone();
    core.child.kill().unwrap();
    core.child.wait().unwrap();
    let occupied =
        std::net::TcpListener::bind(original.url.trim_start_matches("https://")).unwrap();
    core.restart(None);
    let state = core.local.space_remote_access().unwrap();
    core.info = state.listener.unwrap();
    assert!(state.routes_changed);
    assert_ne!(core.info.url, original.url);
    assert_eq!(
        state.intent.address,
        core.info.url.trim_start_matches("https://")
    );
    assert!(state.intent.enabled);
    assert_eq!(core.info.fingerprint, original.fingerprint);
    assert!(core.tls(&original.fingerprint).is_ok());
    drop(occupied);
}

#[test]
fn explicit_operator_startup_does_not_restore_or_change_personal_intent() {
    let mut core = Core::start();
    let intent = core.local.space_remote_access().unwrap().intent;
    core.child.kill().unwrap();
    core.child.wait().unwrap();
    let occupied = std::net::TcpListener::bind(&intent.address).unwrap();
    core.restart(Some("127.0.0.1:0"));
    let state = core.local.space_remote_access().unwrap();
    assert_eq!(
        state.listener.unwrap().peer_policy,
        ListenerPeerPolicy::Operator
    );
    assert_eq!(state.intent, intent);
    assert!(!state.routes_changed);
    drop(occupied);
}

#[test]
fn explicit_shutdown_stops_a_core_whose_listener_started_with_it() {
    // A listener restored or requested at startup begins waiting for drain before the
    // local server does, and the execution owner keeps a long poll open; an explicit
    // shutdown must still stop every part of Core within the owner's release deadline.
    for operator_address in [None, Some("127.0.0.1:0")] {
        let mut core = Core::start();
        core.restart(operator_address);
        let (status, lease) = core.local_request(
            "/core/v1/admin/host/register",
            None,
            json!({"instance":random_id()}),
        );
        assert_eq!(status, 200, "{lease}");
        std::thread::scope(|scope| {
            let poll = scope.spawn(|| core.local_request("/core/v1/admin/host/poll", None, lease));
            std::thread::sleep(Duration::from_millis(200));
            let requested = Instant::now();
            assert_eq!(
                core.local.shutdown().unwrap().status,
                nodex_core_protocol::ShutdownStatus::Draining
            );
            assert_eq!(poll.join().unwrap(), (200, Value::Null));
            assert!(
                requested.elapsed() < Duration::from_secs(2),
                "a draining Core ends its execution owner's poll"
            );
        });
        let until = Instant::now() + Duration::from_secs(4);
        while core.child.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < until,
                "Core stayed draining ({operator_address:?})"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let lifecycle: Value = serde_json::from_slice(
            &fs::read(core.home.path().join("run/core/lifecycle.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(lifecycle["current"]["phase"], "stopped", "{lifecycle}");
        assert_eq!(lifecycle["current"]["stop_outcome"], "success");
    }
}

#[cfg(unix)]
#[test]
fn unsafe_personal_intent_keeps_core_available_without_a_network_listener() {
    use std::os::unix::fs::PermissionsExt;
    let mut core = Core::start();
    let address = core.info.url.trim_start_matches("https://").to_owned();
    core.child.kill().unwrap();
    core.child.wait().unwrap();
    std::fs::set_permissions(
        core.home.path().join("team-transport/remote-access.json"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    core.restart(None);
    assert!(core.local.space_remote_access().is_err());
    assert!(
        core.local.space_members().is_ok(),
        "local content authority remains available"
    );
    assert!(
        TcpStream::connect(address).is_err(),
        "unsafe intent never opens remote access"
    );
}

/// A remote Member's enrolled Device with its live session and authenticated connection.
struct RemoteMember {
    enrollment: EnrollmentResponse,
    session: SessionResponse,
    connection: (String, String),
}

/// One team Space whose execution host has registered, with three remote Members: Alice, who
/// starts chats, Bob, who has no part in them, and Olivia, a Space Owner.
struct HostedChats {
    core: Core,
    lease: Value,
    host: (String, String),
    store_epoch: String,
    alice: RemoteMember,
    bob: RemoteMember,
    olivia: RemoteMember,
}
impl HostedChats {
    fn start() -> Self {
        let core = Core::start();
        let alice = Self::member(&core, MemberRole::Member, "Alice");
        let bob = Self::member(&core, MemberRole::Member, "Bob");
        let olivia = Self::member(&core, MemberRole::Owner, "Olivia");
        let (status, lease) = core.local_request(
            "/core/v1/admin/host/register",
            None,
            json!({"instance":random_id()}),
        );
        assert_eq!(status, 200, "{lease}");
        let host_id = random_id();
        let (status, host) = core.local_request(
            "/core/v1/handshake",
            None,
            serde_json::to_value(HandshakeRequest {
                requirements: core_client_requirements(),
                client: ClientIdentity {
                    kind: ClientKind::ElectronHost,
                    build_id: "hosted-chats".into(),
                },
                connection_id: host_id.clone(),
                expected_generation: RuntimeGenerationIdentity::from(&core.local.descriptor),
            })
            .unwrap(),
        );
        assert_eq!(status, 200, "{host}");
        let host: HandshakeResponse = serde_json::from_value(host).unwrap();
        let chats = Self {
            core,
            lease,
            host: (host_id, host.connection_binding),
            store_epoch: host.store_epoch.clone(),
            alice,
            bob,
            olivia,
        };
        let created = chats.host_apply(
            None,
            json!({"kind":"create_session","session_id":"chat","project_id":null,
                "title":"Release notes","initial_page_ids":[]}),
        );
        assert_eq!(created["status"], "ok", "{created}");
        chats
    }
    /// A newly enrolled Member's own authenticated connection.
    fn member(core: &Core, role: MemberRole, name: &str) -> RemoteMember {
        let enrollment = core.enroll_as(role, name);
        let session = core.session(&enrollment.device_credential);
        let id = random_id();
        let (status, value) = core.handshake(&session.session_token, &id, ClientKind::RemoteMember);
        assert_eq!(status, 200, "{value}");
        let handshake: HandshakeResponse = serde_json::from_value(value).unwrap();
        RemoteMember {
            enrollment,
            session,
            connection: (id, handshake.connection_binding),
        }
    }
    fn host_binding(&self) -> Option<(&str, &str)> {
        Some((self.host.0.as_str(), self.host.1.as_str()))
    }
    /// A Project Workspace write by the execution owner, carrying a Member's invocation if any.
    fn host_apply(&self, proof: Option<&str>, intent: Value) -> Value {
        self.core
            .local_request_proof(
                "/core/v1/modules/workspace/apply",
                self.host_binding(),
                json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                    "store_epoch":self.store_epoch,"operation_id":team_operation_id(),"intent":intent}),
                proof,
            )
            .1
    }
    fn call(&self, member: &RemoteMember, operation: &str, input: Value) -> (u16, Value) {
        self.core.request(
            "/core/v1/host/call",
            &member.session.session_token,
            Some((member.connection.0.as_str(), member.connection.1.as_str())),
            json!({"operation":operation,"input":input}),
        )
    }
    /// Core refuses the call before it reaches the host.
    fn refused(&self, member: &RemoteMember, operation: &str, input: Value) -> Value {
        let (status, refused) = self.call(member, operation, input);
        assert_ne!(status, 200, "{refused}");
        refused
    }
    /// Core delivers the call to the host, which acts on it with its invocation proof.
    fn admitted<R>(
        &self,
        member: &RemoteMember,
        operation: &str,
        input: Value,
        act: impl FnOnce(&str) -> R,
    ) -> R {
        let (completed, answered, acted) = self.delivered(member, operation, input, act);
        assert_eq!(completed, 200);
        assert_eq!(answered, 200);
        acted
    }
    /// The host's completion status, the Member's response status and what the host did.
    fn delivered<R>(
        &self,
        member: &RemoteMember,
        operation: &str,
        input: Value,
        act: impl FnOnce(&str) -> R,
    ) -> (u16, u16, R) {
        std::thread::scope(|scope| {
            let call = scope.spawn(|| self.call_status(member, operation, input));
            let (status, invocation) =
                self.core
                    .local_request("/core/v1/admin/host/poll", None, self.lease.clone());
            assert_eq!(status, 200, "{invocation}");
            assert_eq!(invocation["call"]["operation"], operation, "{invocation}");
            let acted = act(invocation["credential"].as_str().unwrap());
            let (completed, _) = self.core.local_request(
                "/core/v1/admin/host/complete",
                None,
                json!({"token":self.lease["token"],"id":invocation["id"],
                    "result":{"status":"ok","value":null}}),
            );
            (completed, call.join().unwrap(), acted)
        })
    }
    /// A withdrawn Member's response may end before its body, so only its status is read.
    fn call_status(&self, member: &RemoteMember, operation: &str, input: Value) -> u16 {
        let mut tls = self.core.tls(&self.core.info.fingerprint).unwrap();
        let bytes = serde_json::to_vec(&json!({"operation":operation,"input":input})).unwrap();
        let (id, binding) = &member.connection;
        write!(tls,"POST /core/v1/host/call HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nx-nodex-connection-id: {id}\r\nx-nodex-connection-binding: {binding}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",member.session.session_token,bytes.len()).unwrap();
        tls.write_all(&bytes).unwrap();
        tls.flush().unwrap();
        let mut line = String::new();
        BufReader::new(tls).read_line(&mut line).unwrap();
        line.split_whitespace().nth(1).unwrap().parse().unwrap()
    }
    /// The chat a launch proof creates, bound to this host's Runtime.
    fn launch(&self, proof: &str, session: &str, launch: &str, side_chat: Option<&str>) -> Value {
        let mut intent = json!({"kind":"create_agent_runtime_session","session_id":session,
            "project_id":null,"title":"Fork","initial_page_ids":[],"runtime_id":"runtime",
            "runtime_thread_id":format!("thread:{session}"),"launch_request_id":launch});
        if let Some(source) = side_chat {
            intent["side_chat_source_session_id"] = json!(source);
        }
        self.host_apply(Some(proof), intent)
    }
    /// Who a chat answers to, read from Core's own evidence.
    fn requester(&self, session: &str) -> String {
        let database = rusqlite::Connection::open_with_flags(
            self.core.home.path().join("nodex.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        database
            .query_row(
                "SELECT member_id FROM session_requesting_members WHERE session_id=?1 AND message_id='session:created'",
                [session],
                |row| row.get(0),
            )
            .unwrap()
    }
}

#[test]
fn any_member_who_reads_a_hosted_chat_forks_it_as_their_own() {
    let chats = HostedChats::start();
    let fork = |session: &str| {
        json!({"source":{"sessionId":"chat"},"sessionId":session,"requestId":format!("{session}:launch"),
            "acceptedAt":1,"environment":"same-directory"})
    };
    // Bob had no part in the chat; reading it is enough to fork it.
    let proof = chats.admitted(&chats.bob, "session_fork", fork("bob-fork"), |proof| {
        // The proof creates exactly the fork it was issued for, and no other chat.
        let other = chats.launch(proof, "other", "bob-fork:launch", None);
        assert_eq!(other["status"], "error", "{other}");
        let side = chats.launch(proof, "bob-fork", "bob-fork:launch", Some("chat"));
        assert_eq!(side["status"], "error", "{side}");
        let created = chats.launch(proof, "bob-fork", "bob-fork:launch", None);
        assert_eq!(created["status"], "ok", "{created}");
        proof.to_owned()
    });
    assert_eq!(chats.requester("bob-fork"), chats.bob.enrollment.member_id);
    // The proof ends with its call, and a Member's own connection cannot launch the fork.
    let expired = chats.launch(&proof, "late-fork", "late-fork:launch", None);
    assert_eq!(expired["status"], "error", "{expired}");
    let (status, direct) = chats.core.request(
        "/core/v1/modules/workspace/apply",
        &chats.alice.session.session_token,
        Some((
            chats.alice.connection.0.as_str(),
            chats.alice.connection.1.as_str(),
        )),
        json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
            "store_epoch":chats.store_epoch,"operation_id":team_operation_id(),
            "intent":{"kind":"create_agent_runtime_session","session_id":"direct","project_id":null,
                "title":"Fork","initial_page_ids":[],"runtime_id":"runtime",
                "runtime_thread_id":"thread:direct","launch_request_id":"direct"}}),
    );
    assert_eq!(status, 200, "{direct}");
    assert_eq!(direct["status"], "error", "{direct}");
    // A chat that is not in this Space cannot be forked by anyone.
    let missing = chats.refused(
        &chats.olivia,
        "session_fork",
        json!({"source":{"sessionId":"elsewhere"},"sessionId":"olivia-fork",
            "requestId":"olivia-fork:launch","acceptedAt":1,"environment":"same-directory"}),
    );
    assert!(missing.to_string().contains("unavailable"), "{missing}");
}

impl HostedChats {
    /// A Project Workspace write on a Member's own authenticated connection.
    fn member_apply(&self, member: &RemoteMember, intent: Value) -> Value {
        let (status, value) = self.core.request(
            "/core/v1/modules/workspace/apply",
            &member.session.session_token,
            Some((member.connection.0.as_str(), member.connection.1.as_str())),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                "store_epoch":self.store_epoch,"operation_id":team_operation_id(),"intent":intent}),
        );
        assert_eq!(status, 200, "{value}");
        value
    }
    /// The chats the Member's sidebar lists without a Project.
    fn listed(&self, member: &RemoteMember) -> Vec<String> {
        let read = self.member_read(
            member,
            json!({"kind":"task_window","project_id":null,"window":{"first":50}}),
        );
        assert_eq!(read["status"], "ok", "{read}");
        read["payload"]["value"]["tasks"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["session"]["id"].as_str().unwrap().to_owned())
            .collect()
    }
}

#[test]
fn a_member_starts_a_hosted_chat_of_their_own_from_their_own_draft() {
    let chats = HostedChats::start();
    let draft = |member: &RemoteMember, session: &str| {
        let ensured = chats.member_apply(
            member,
            json!({"kind":"ensure_default_draft_session","session_id":session,
                "project_id":null,"title":"New chat"}),
        );
        assert_eq!(ensured["status"], "ok", "{ensured}");
    };
    // Each Member opens a draft of their own, which no one else lists or starts.
    draft(&chats.alice, "alice-draft");
    draft(&chats.bob, "bob-draft");
    draft(&chats.alice, "alice-second-draft");
    assert_eq!(
        chats.requester("alice-draft"),
        chats.alice.enrollment.member_id
    );
    assert_eq!(chats.requester("bob-draft"), chats.bob.enrollment.member_id);
    let bob_lists = chats.listed(&chats.bob);
    assert!(bob_lists.contains(&"bob-draft".to_owned()), "{bob_lists:?}");
    assert!(
        !bob_lists.contains(&"alice-draft".to_owned()),
        "{bob_lists:?}"
    );
    assert!(
        !chats
            .listed(&chats.alice)
            .contains(&"alice-second-draft".to_owned())
    );
    let start = |session: &str| {
        json!({"sessionId":session,"launchId":format!("{session}:launch"),"acceptedAt":1,
            "projectId":null,"title":"New chat","message":{"messageId":format!("{session}:message"),"text":"Hello"},
            "modelSelection":{"instanceId":"codex","model":"gpt-6-luna"},"interactionMode":"default"})
    };
    let refused = chats.refused(&chats.bob, "session_start", start("alice-draft"));
    assert!(refused.to_string().contains("another Member"), "{refused}");
    // Bob starts his own draft; the host's proof launches exactly it, and it stays his.
    chats.admitted(&chats.bob, "session_start", start("bob-draft"), |proof| {
        let other = chats.launch(proof, "alice-draft", "bob-draft:launch", None);
        assert_eq!(other["status"], "error", "{other}");
        let created = chats.launch(proof, "bob-draft", "bob-draft:launch", None);
        assert_eq!(created["status"], "ok", "{created}");
        // The proof still carries the start's first message once its launch bound the chat.
        let message = chats.host_apply(
            Some(proof),
            json!({"kind":"mutate_session","session_id":"bob-draft",
                "intent":{"kind":"record_user_message","message_id":"bob-draft:message"}}),
        );
        assert_eq!(message["status"], "ok", "{message}");
    });
    assert_eq!(chats.requester("bob-draft"), chats.bob.enrollment.member_id);
    let mut again = start("bob-draft");
    again["launchId"] = json!("bob-draft:again");
    let started = chats.refused(&chats.bob, "session_start", again);
    assert!(started.to_string().contains("already started"), "{started}");
    // A new chat without a draft is its starter's too.
    chats.admitted(
        &chats.olivia,
        "session_start",
        start("olivia-chat"),
        |proof| {
            let created = chats.launch(proof, "olivia-chat", "olivia-chat:launch", None);
            assert_eq!(created["status"], "ok", "{created}");
        },
    );
    assert_eq!(
        chats.requester("olivia-chat"),
        chats.olivia.enrollment.member_id
    );
    assert!(chats.can_manage(&chats.olivia, "olivia-chat"));
    assert!(!chats.can_manage(&chats.bob, "olivia-chat"));
}

impl HostedChats {
    /// A Project Workspace read on a Member's own authenticated connection.
    fn member_read(&self, member: &RemoteMember, read: Value) -> Value {
        let (status, value) = self.core.request(
            "/core/v1/modules/workspace/read",
            &member.session.session_token,
            Some((member.connection.0.as_str(), member.connection.1.as_str())),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                "read":read}),
        );
        assert_eq!(status, 200, "{value}");
        value
    }
    /// What the Member may do with a chat, as every session read tells them.
    fn capabilities(&self, member: &RemoteMember, session: &str) -> (bool, bool) {
        let read = self.member_read(member, json!({"kind":"session","session_id":session}));
        assert_eq!(read["status"], "ok", "{read}");
        let session = &read["payload"]["value"]["session"];
        (
            session["can_manage"].as_bool().unwrap(),
            session["can_stop"].as_bool().unwrap(),
        )
    }
    fn can_manage(&self, member: &RemoteMember, session: &str) -> bool {
        self.capabilities(member, session).0
    }
}

#[test]
fn a_hosted_side_chat_answers_to_the_member_who_opened_it() {
    let chats = HostedChats::start();
    let alice = &chats.alice;
    let side = json!({"source":{"sessionId":"chat"},"sessionId":"alice-side",
        "requestId":"alice-side:launch","acceptedAt":1});
    chats.admitted(alice, "session_side_chat_create", side, |proof| {
        // The proof binds exactly a side chat of the chat it named.
        for source in [None, Some("elsewhere")] {
            let refused = chats.launch(proof, "alice-side", "alice-side:launch", source);
            assert_eq!(refused["status"], "error", "{refused}");
        }
        let created = chats.launch(proof, "alice-side", "alice-side:launch", Some("chat"));
        assert_eq!(created["status"], "ok", "{created}");
    });
    assert_eq!(chats.requester("alice-side"), alice.enrollment.member_id);
    assert!(chats.can_manage(alice, "alice-side"));
    assert!(!chats.can_manage(&chats.bob, "alice-side"));

    // Merging it back belongs to Alice and the Space Owners.
    let merge = json!({"sessionId":"alice-side","requestId":"merge"});
    let refused = chats.refused(&chats.bob, "session_merge_back", merge.clone());
    assert!(
        refused
            .to_string()
            .contains("started this chat or a Space Owner"),
        "{refused}"
    );
    chats.admitted(&chats.olivia, "session_merge_back", merge.clone(), |_| ());
    chats.admitted(alice, "session_merge_back", merge, |proof| {
        let refused = chats.host_apply(
            Some(proof),
            json!({"kind":"delete_session","session_id":"alice-side"}),
        );
        assert_eq!(refused["status"], "error", "{refused}");
        assert!(
            refused.to_string().contains("through the Space host"),
            "{refused}"
        );
    });
    let delete = json!({"sessionId":"alice-side","requestId":"delete-side"});
    // Neither another Member nor a Space Owner may delete Alice's side chat.
    for member in [&chats.bob, &chats.olivia] {
        let refused = chats.refused(member, "session_side_chat_delete", delete.clone());
        assert!(refused.to_string().contains("another Member"), "{refused}");
    }
    // A Member cannot turn ordinary hosted chat deletion into a side-chat command.
    for member in [alice, &chats.bob, &chats.olivia] {
        let refused = chats.refused(
            member,
            "session_side_chat_delete",
            json!({"sessionId":"chat","requestId":"delete-chat"}),
        );
        assert!(
            refused
                .to_string()
                .contains("Only a Member's own side chat"),
            "{refused}"
        );
    }
    // Even Alice's own side chat cannot be deleted on her direct connection without the Host.
    let direct = chats.member_apply(
        alice,
        json!({"kind":"delete_session","session_id":"alice-side"}),
    );
    assert_eq!(direct["status"], "error", "{direct}");
    assert!(
        direct.to_string().contains("through the Space host"),
        "{direct}"
    );
    chats.admitted(
        alice,
        "session_side_chat_create",
        json!({"source":{"sessionId":"chat"},"sessionId":"alice-sibling",
            "requestId":"alice-sibling:launch","acceptedAt":1}),
        |proof| {
            let created =
                chats.launch(proof, "alice-sibling", "alice-sibling:launch", Some("chat"));
            assert_eq!(created["status"], "ok", "{created}");
        },
    );
    // The live invocation proof authorizes exactly the named side chat, not another Alice owns.
    chats.admitted(alice, "session_side_chat_delete", delete, |proof| {
        let sibling = chats.host_apply(
            Some(proof),
            json!({"kind":"delete_session","session_id":"alice-sibling"}),
        );
        assert_eq!(sibling["status"], "error", "{sibling}");
        assert!(
            sibling.to_string().contains("through the Space host"),
            "{sibling}"
        );
        let deleted = chats.host_apply(
            Some(proof),
            json!({"kind":"delete_session","session_id":"alice-side"}),
        );
        assert_eq!(deleted["status"], "ok", "{deleted}");
    });
    let read = chats.member_read(alice, json!({"kind":"session","session_id":"alice-side"}));
    assert_eq!(read["status"], "error", "{read}");
    assert_eq!(read["payload"]["code"], "not_found", "{read}");
    let sibling = chats.member_read(
        alice,
        json!({"kind":"session","session_id":"alice-sibling"}),
    );
    assert_eq!(sibling["status"], "ok", "{sibling}");

    // An archived chat takes no new side chat from anyone.
    let archived = chats.host_apply(
        None,
        json!({"kind":"mutate_session","session_id":"chat","intent":{"kind":"set_archived","archived":true}}),
    );
    assert_eq!(archived["status"], "ok", "{archived}");
    let refused = chats.refused(
        &chats.olivia,
        "session_side_chat_create",
        json!({"source":{"sessionId":"chat"},"sessionId":"late-side",
            "requestId":"late-side:launch","acceptedAt":1}),
    );
    assert!(
        refused.to_string().contains("Restore this chat"),
        "{refused}"
    );
}

impl HostedChats {
    /// A Member's message reaches the chat through the host, which records its acceptance.
    fn send(&self, member: &RemoteMember, message: &str) {
        self.send_in(member, "chat", message);
    }
    fn send_in(&self, member: &RemoteMember, session: &str, message: &str) {
        let input = json!({"sessionId":session,"message":{"messageId":message,"text":message},
            "delivery":"send"});
        self.admitted(member, "session_message", input, |proof| {
            let accepted = self.accept_in(proof, session, message);
            assert_eq!(accepted["status"], "ok", "{accepted}");
        });
    }
    fn accept(&self, proof: &str, message: &str) -> Value {
        self.accept_in(proof, "chat", message)
    }
    fn accept_in(&self, proof: &str, session: &str, message: &str) -> Value {
        self.host_apply(
            Some(proof),
            json!({"kind":"mutate_session","session_id":session,
                "intent":{"kind":"record_user_message","message_id":message}}),
        )
    }
    /// The Runtime reports the message that opened a Run before its Agent acts.
    fn run(&self, run: &str, message: &str) {
        self.run_in("chat", run, message);
    }
    fn run_in(&self, session: &str, run: &str, message: &str) {
        let (status, attributed) = self.core.local_request(
            "/core/v1/agent-attributions",
            self.host_binding(),
            json!({"session_id":session,"run_id":run,"message_id":message,"backend":"codex"}),
        );
        assert_eq!(status, 200, "{attributed}");
    }
    /// The host observes `run` as the chat's current work.
    fn working(&self, session: &str, run: &str, revision: u64) {
        let observed = self.host_apply(
            None,
            json!({"kind":"record_session_execution","session_id":session,
                "expected_revision":revision,"observation":{"state":"working","runId":run,
                "runStartedAt":0,"pendingRequestIds":[],"pendingRequests":[],"queue":null,
                "terminalStatus":null,"personStopped":false,"stalled":false,
                "progressFingerprint":run,"progressSince":0},"events":[],"resolved_request_ids":[]}),
        );
        assert_eq!(observed["status"], "ok", "{observed}");
    }
    fn edits(&self, member: &RemoteMember) -> Value {
        let read = self.member_read(
            member,
            json!({"kind":"session_member_actions","session_id":"chat","run_ids":["r1","r2"]}),
        );
        assert_eq!(read["status"], "ok", "{read}");
        let runs = read["payload"]["value"]["actions"]["runs"]
            .as_array()
            .unwrap();
        runs.iter()
            .map(|run| json!({"run_id":run["run_id"],"edit":run["edit"]}))
            .collect()
    }
}

#[test]
fn a_member_edits_their_own_message_until_someone_else_replies() {
    let chats = HostedChats::start();
    let (alice, bob) = (&chats.alice, &chats.bob);
    let edit = |run: &str, message: &str| {
        json!({"sessionId":"chat","runId":run,"requestId":format!("{message}:request"),
            "message":{"messageId":message,"text":"Edited"}})
    };
    chats.send(alice, "m1");
    chats.run("r1", "m1");
    // Only Alice edits her message; an Owner's role does not make it theirs.
    for member in [bob, &chats.olivia] {
        let refused = chats.refused(member, "session_rewrite_message", edit("r1", "x1"));
        assert!(
            refused.to_string().contains("Only the person who sent"),
            "{refused}"
        );
    }
    chats.admitted(
        alice,
        "session_rewrite_message",
        edit("r1", "m1-edited"),
        |proof| {
            let accepted = chats.accept(proof, "m1-edited");
            assert_eq!(accepted["status"], "ok", "{accepted}");
        },
    );
    chats.run("r1-edited", "m1-edited");
    assert_eq!(
        chats.edits(alice),
        json!([{"run_id":"r1","edit":"available"},{"run_id":"r2","edit":"unavailable"}])
    );

    // Once Bob replies, the earlier message is no longer Alice's alone to rewrite.
    chats.send(bob, "m2");
    chats.run("r2", "m2");
    let refused = chats.refused(alice, "session_rewrite_message", edit("r1", "m1-again"));
    assert!(
        refused
            .to_string()
            .contains("Someone else has replied since"),
        "{refused}"
    );
    assert_eq!(
        chats.edits(alice),
        json!([{"run_id":"r1","edit":"replied_since"},{"run_id":"r2","edit":"unavailable"}])
    );
    assert_eq!(
        chats.edits(bob),
        json!([{"run_id":"r1","edit":"unavailable"},{"run_id":"r2","edit":"available"}])
    );

    // Core decides again when the host acts: a reply arriving meanwhile ends the edit.
    chats.admitted(
        bob,
        "session_rewrite_message",
        edit("r2", "m2-edited"),
        |proof| {
            chats.send(alice, "m3");
            let refused = chats.accept(proof, "m2-edited");
            assert_eq!(refused["status"], "error", "{refused}");
        },
    );
    // So does Bob's revoked Device, after the call was admitted.
    chats.send(alice, "m4");
    chats.run("r4", "m4");
    let (completed, answered, ()) = chats.delivered(
        alice,
        "session_rewrite_message",
        edit("r4", "m4-edited"),
        |proof| {
            chats
                .core
                .local
                .space_revoke(RevokeDeviceRequest {
                    device_id: alice.enrollment.device_id.clone(),
                })
                .unwrap();
            let refused = chats.accept(proof, "m4-edited");
            assert_eq!(refused["status"], "error", "{refused}");
        },
    );
    assert_eq!(completed, 503);
    assert_ne!(answered, 200);
}

#[test]
fn a_hosted_chats_owner_and_space_owners_compact_and_clear_it() {
    let chats = HostedChats::start();
    let (alice, bob, olivia) = (&chats.alice, &chats.bob, &chats.olivia);
    // Alice's fork answers to her, as the chat she started.
    let fork = json!({"source":{"sessionId":"chat"},"sessionId":"alice-chat",
        "requestId":"alice-chat:launch","acceptedAt":1,"environment":"same-directory"});
    chats.admitted(alice, "session_fork", fork, |proof| {
        let created = chats.launch(proof, "alice-chat", "alice-chat:launch", None);
        assert_eq!(created["status"], "ok", "{created}");
    });
    let compact = json!({"sessionId":"alice-chat","requestId":"compact"});
    let retry = json!({"sessionId":"alice-chat","requestId":"retry","failedRunId":"failed"});
    let clear = json!({"sessionId":"alice-chat","requestId":"clear"});
    for (operation, input) in [
        ("session_compact", &compact),
        ("session_compact", &retry),
        ("session_clear_context", &clear),
    ] {
        let refused = chats.refused(bob, operation, input.clone());
        assert!(
            refused
                .to_string()
                .contains("started this chat or a Space Owner"),
            "{refused}"
        );
        chats.admitted(alice, operation, input.clone(), |_| ());
        chats.admitted(olivia, operation, input.clone(), |_| ());
    }
    assert_eq!(
        [alice, olivia, bob].map(|member| chats.can_manage(member, "alice-chat")),
        [true, true, false]
    );

    // Core decides again whenever the host uses the call: a revoked Device ends it.
    let (completed, answered, ()) =
        chats.delivered(alice, "session_clear_context", clear.clone(), |proof| {
            let read = |proof| {
                chats.core.local_request_proof(
                    "/core/v1/modules/workspace/read",
                    chats.host_binding(),
                    json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                        "read":{"kind":"session","session_id":"alice-chat"}}),
                    Some(proof),
                )
                .1
            };
            assert_eq!(read(proof)["status"], "ok");
            chats
                .core
                .local
                .space_revoke(RevokeDeviceRequest {
                    device_id: alice.enrollment.device_id.clone(),
                })
                .unwrap();
            assert_eq!(read(proof)["status"], "error");
        });
    assert_eq!(completed, 503);
    assert_ne!(answered, 200);
}

#[test]
fn a_hosted_chat_stays_its_owners_when_another_member_replies() {
    let chats = HostedChats::start();
    let (alice, bob, olivia) = (&chats.alice, &chats.bob, &chats.olivia);
    let carol = HostedChats::member(&chats.core, MemberRole::Member, "Carol");
    // Alice starts a chat of her own by forking the Space's chat, then asks it for work.
    let fork = json!({"source":{"sessionId":"chat"},"sessionId":"alice-chat",
        "requestId":"alice-chat:launch","acceptedAt":1,"environment":"same-directory"});
    chats.admitted(alice, "session_fork", fork, |proof| {
        let created = chats.launch(proof, "alice-chat", "alice-chat:launch", None);
        assert_eq!(created["status"], "ok", "{created}");
    });
    chats.send_in(alice, "alice-chat", "alice-message");
    chats.run_in("alice-chat", "alice-run", "alice-message");
    chats.working("alice-chat", "alice-run", 0);
    // Bob replies, and the Run he asked for becomes the chat's current work.
    chats.send_in(bob, "alice-chat", "bob-message");
    chats.run_in("alice-chat", "bob-run", "bob-message");
    chats.working("alice-chat", "bob-run", 1);

    // Replying made Bob no owner: Alice and the Space Owner manage it, while Bob, with Alice and
    // the Owner, stops the work he asked for. Carol, who took no part, does neither.
    assert_eq!(
        [alice, olivia, bob, &carol].map(|member| chats.capabilities(member, "alice-chat")),
        [(true, true), (true, true), (false, true), (false, false)]
    );
    let compact = json!({"sessionId":"alice-chat","requestId":"compact"});
    for member in [bob, &carol] {
        let refused = chats.refused(member, "session_compact", compact.clone());
        assert!(
            refused
                .to_string()
                .contains("started this chat or a Space Owner"),
            "{refused}"
        );
    }
    chats.admitted(alice, "session_compact", compact, |_| ());

    // Bob stops only his own Run, its tasks included; Alice and the Owner stop either.
    let stop = |run: &str| json!({"sessionId":"alice-chat","threadId":"thread","requestId":"stop","runId":run});
    let task = |run: Option<&str>| {
        json!({"sessionId":"alice-chat","threadId":"thread","requestId":"task","taskId":"task",
            "runId":run})
    };
    chats.admitted(bob, "session_stop", stop("bob-run"), |_| ());
    chats.admitted(bob, "session_cancel_task", task(Some("bob-run")), |_| ());
    let refused = chats.refused(bob, "session_stop", stop("alice-run"));
    assert!(
        refused
            .to_string()
            .contains("Only the person who started this, or a Space Owner, can stop it."),
        "{refused}"
    );
    // A task whose Run is not known is only for those who manage the chat.
    chats.refused(bob, "session_cancel_task", task(None));
    chats.refused(&carol, "session_stop", stop("bob-run"));
    chats.refused(&carol, "session_cancel_task", task(Some("bob-run")));
    for member in [alice, olivia] {
        chats.admitted(member, "session_stop", stop("alice-run"), |_| ());
        chats.admitted(member, "session_stop", stop("bob-run"), |_| ());
        chats.admitted(member, "session_cancel_task", task(None), |_| ());
    }

    // Alice asks again, so her new Run is current while a subagent of Bob's earlier Run still
    // works. Each item answers for its own Run: Bob may no longer interrupt the chat, yet stops
    // that subagent and its Run's background work, and none of Alice's.
    chats.send_in(alice, "alice-chat", "alice-again");
    chats.run_in("alice-chat", "alice-run-2", "alice-again");
    chats.working("alice-chat", "alice-run-2", 2);
    assert_eq!(chats.capabilities(bob, "alice-chat"), (false, false));
    let stoppable = |member: &RemoteMember| {
        let read = chats.member_read(
            member,
            json!({"kind":"session_member_actions","session_id":"alice-chat",
                "run_ids":["alice-run","bob-run","alice-run-2"]}),
        );
        assert_eq!(read["status"], "ok", "{read}");
        read["payload"]["value"]["actions"]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["can_stop"].as_bool().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(stoppable(bob), [false, true, false]);
    assert_eq!(stoppable(&carol), [false, false, false]);
    assert_eq!(stoppable(alice), [true, true, true]);
    assert_eq!(stoppable(olivia), [true, true, true]);
    let subagent = |run: &str| {
        json!({"sessionId":"alice-chat","threadId":"thread","requestId":"subagent",
            "runId":run,"taskId":"subagent"})
    };
    let background = |run: &str| {
        json!({"sessionId":"alice-chat","threadId":"thread","requestId":"background",
            "runId":run,"taskIds":["build"]})
    };
    chats.admitted(bob, "session_stop_task", subagent("bob-run"), |_| ());
    chats.admitted(
        bob,
        "session_stop_background",
        background("bob-run"),
        |_| (),
    );
    chats.refused(bob, "session_stop_task", subagent("alice-run-2"));
    chats.refused(bob, "session_stop_background", background("alice-run"));
    chats.refused(bob, "session_stop", stop("alice-run-2"));

    // A rename from Bob's own connection meets the same rule as Alice's.
    let rename = |member: &RemoteMember, title: &str| {
        let (status, value) = chats.core.request(
            "/core/v1/modules/workspace/apply",
            &member.session.session_token,
            Some((member.connection.0.as_str(), member.connection.1.as_str())),
            json!({"contract_version":nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                "store_epoch":chats.store_epoch,"operation_id":team_operation_id(),
                "intent":{"kind":"mutate_session","session_id":"alice-chat",
                    "intent":{"kind":"rename","title":title}}}),
        );
        assert_eq!(status, 200, "{value}");
        value["status"].as_str().unwrap().to_owned()
    };
    assert_eq!(rename(bob, "Bob's title"), "error");
    assert_eq!(rename(alice, "Alice's title"), "ok");
}

#[test]
fn member_presence_follows_each_members_own_live_desktops() {
    let core = Core::start();
    let bob = core.enroll_as(MemberRole::Member, "Bob");
    let carol = core.enroll_as(MemberRole::Member, "Carol");
    let bob_session = core.session(&bob.device_credential);
    let (status, lease) = core.local_request(
        "/core/v1/admin/host/register",
        None,
        json!({"instance":random_id()}),
    );
    assert_eq!(status, 200, "{lease}");
    let presence = |member: &str| {
        let (status, value) = core.local_request(
            "/core/v1/admin/host/member-presence",
            None,
            json!({"token":lease["token"],"member_id":member}),
        );
        assert_eq!(status, 200, "{value}");
        value["idle_ms"].clone()
    };
    let report = |token: &str, idle: Value| {
        core.request(
            "/core/v1/host/presence",
            token,
            None,
            json!({ "idle_ms": idle }),
        )
    };
    // Nobody has vouched for either Member yet.
    assert_eq!(presence(&bob.member_id), Value::Null);
    assert_eq!(report(&bob_session.session_token, json!(2_000)).0, 200);
    let idle = presence(&bob.member_id)
        .as_u64()
        .expect("Bob is at his desktop");
    assert!((2_000..60_000).contains(&idle), "{idle}");
    // One Member's desktop says nothing about another, and only the Host's lease reads it.
    assert_eq!(presence(&carol.member_id), Value::Null);
    let (status, _) = core.local_request(
        "/core/v1/admin/host/member-presence",
        None,
        json!({"token":"0".repeat(64),"member_id":bob.member_id}),
    );
    assert_ne!(status, 200, "presence needs the live Host lease");
    let (status, _) = core.request(
        "/core/v1/admin/host/member-presence",
        &bob_session.session_token,
        None,
        json!({"token":lease["token"],"member_id":bob.member_id}),
    );
    assert_ne!(status, 200, "a Member cannot read anyone's presence");
    // A locked screen vouches for nobody.
    assert_eq!(report(&bob_session.session_token, Value::Null).0, 200);
    assert_eq!(presence(&bob.member_id), Value::Null);
    assert_eq!(report(&bob_session.session_token, json!(500)).0, 200);
    assert!(presence(&bob.member_id).is_u64());
    // A revoked Device's presence never counts, and it can no longer report.
    core.local
        .space_revoke(RevokeDeviceRequest {
            device_id: bob.device_id,
        })
        .unwrap();
    assert_eq!(presence(&bob.member_id), Value::Null);
    assert_ne!(report(&bob_session.session_token, json!(0)).0, 200);
}
