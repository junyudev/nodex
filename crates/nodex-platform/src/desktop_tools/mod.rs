//! Main's dedicated stdio platform command. No Profile, Store, or Core listener.
mod authenticode;
mod files;
mod job_stdio;
mod pipes;
mod processes;
mod registry;

pub use authenticode::verify_authenticode;
pub use files::inspect_path;
pub use job_stdio::run_job;
pub use pipes::{PipeConnection, PipeListener, connect_pipe, enumerate_pipes};
pub use processes::{ProcessIdentity, descendants, process_identity, terminate_subtree};
pub use registry::{
    HostKey, read_registration, restore_installation_registrations, restore_registration,
    write_registration,
};

use files::invalid;
use pipes::{MAX_CHUNK, MAX_CONNECTIONS};
use registry::{Registration, RegistryValue};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio::task::JoinSet;

const MAX_REQUEST: usize = 384 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Start {
    VerifyAuthenticode {
        path: PathBuf,
        #[serde(default)]
        require_revocation: bool,
    },
    InspectPath {
        path: PathBuf,
    },
    InspectPaths {
        paths: Vec<PathBuf>,
    },
    Ancestors {
        peer: ProcessIdentity,
    },
    ProcessIdentity {
        pid: u32,
    },
    Descendants {
        root: ProcessIdentity,
    },
    TerminateSubtree {
        root: ProcessIdentity,
    },
    EnumeratePipes {
        prefix: String,
        limit: usize,
    },
    ListenPipe {
        prefix: String,
    },
    ConnectPipe {
        endpoint: String,
    },
    ReadRegistration {
        key: HostKey,
    },
    WriteRegistration {
        key: HostKey,
        expected: Option<RegistryValue>,
        manifest: PathBuf,
    },
    RestoreRegistration {
        key: HostKey,
        receipt: Registration,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum PipeRequest {
    Accept,
    Read { connection: u32 },
    Write { connection: u32, hex: String },
    Close { connection: u32 },
}

#[derive(Deserialize)]
struct Request<T> {
    id: u32,
    body: T,
}

fn send(id: u32, result: io::Result<Value>) -> io::Result<()> {
    let result = match result {
        Ok(value) => json!({ "id": id, "value": value }),
        Err(error) => json!({ "id": id, "error": error.to_string() }),
    };
    let bytes = serde_json::to_vec(&result)?;
    let mut output = io::stdout().lock();
    if bytes.len() > MAX_RESPONSE {
        writeln!(
            output,
            "{{\"id\":{id},\"error\":\"platform response limit exceeded\"}}"
        )?;
    } else {
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
    }
    output.flush()
}

fn read_line(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_REQUEST as u64 + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        return Err(invalid("oversized or incomplete platform request"));
    }
    Ok(Some(bytes))
}

fn value(result: impl serde::Serialize) -> io::Result<Value> {
    Ok(serde_json::to_value(result)?)
}

fn run_once(command: Start) -> io::Result<Value> {
    match command {
        Start::VerifyAuthenticode {
            path,
            require_revocation,
        } => value(authenticode::inspect_signature(&path, require_revocation)?),
        Start::InspectPath { path } => value(inspect_path(&path)?),
        Start::InspectPaths { paths } => {
            if paths.len() > 64 {
                return Err(invalid("path inspection batch limit exceeded"));
            }
            value(
                paths
                    .iter()
                    .map(|path| {
                        inspect_path(path).map_err(|error| {
                            io::Error::other(format!("{}: {error}", path.display()))
                        })
                    })
                    .collect::<io::Result<Vec<_>>>()?,
            )
        }
        Start::Ancestors { peer } => value(processes::ancestors(&peer)?),
        Start::ProcessIdentity { pid } => value(process_identity(pid)?),
        Start::Descendants { root } => value(descendants(&root)?),
        Start::TerminateSubtree { root } => value(terminate_subtree(&root)?),
        Start::EnumeratePipes { prefix, limit } => value(enumerate_pipes(&prefix, limit)?),
        Start::ReadRegistration { key } => value(read_registration(&key)?),
        Start::WriteRegistration {
            key,
            expected,
            manifest,
        } => value(write_registration(&key, expected, &manifest)?),
        Start::RestoreRegistration { key, receipt } => value(restore_registration(&key, &receipt)?),
        _ => Err(invalid("operation requires a scoped platform command")),
    }
}

pub fn run_stdio() -> io::Result<()> {
    let mut stdin = io::stdin().lock();
    let bytes = read_line(&mut stdin)?.ok_or_else(|| invalid("missing platform request"))?;
    let Request { id, body } = serde_json::from_slice::<Request<Start>>(&bytes)?;
    match body {
        Start::ListenPipe { .. } | Start::ConnectPipe { .. } => {
            drop(stdin);
            tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()?
                .block_on(run_pipes(id, body))
        }
        _ => send(id, run_once(body)),
    }
}

#[derive(Default)]
struct Connections {
    next: u32,
    open: HashMap<u32, PipeConnection>,
}
impl Connections {
    fn insert(&mut self, pipe: PipeConnection) -> io::Result<Value> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| io::Error::other("pipe connection ID exhausted"))?;
        let id = self.next;
        let ready = json!({ "connection": id, "peer": pipe.identity });
        self.open.insert(id, pipe);
        Ok(ready)
    }
}

#[derive(Default)]
struct Broker {
    listener: Option<AsyncMutex<PipeListener>>,
    connections: Mutex<Connections>,
}
impl Broker {
    async fn request(&self, request: PipeRequest) -> io::Result<Value> {
        match request {
            PipeRequest::Accept => {
                let mut listener = self
                    .listener
                    .as_ref()
                    .ok_or_else(|| invalid("pipe is a client"))?
                    .try_lock()
                    .map_err(|_| invalid("an accept is already pending"))?;
                if self.connections.lock().unwrap().open.len() >= MAX_CONNECTIONS {
                    return Err(io::Error::other("pipe connection limit reached"));
                }
                let pipe = listener.accept().await?;
                self.connections.lock().unwrap().insert(pipe)
            }
            PipeRequest::Close { connection } => {
                self.connections.lock().unwrap().open.remove(&connection);
                Ok(Value::Null)
            }
            PipeRequest::Read { connection } => {
                let (mut reader, mut closed) = {
                    let connections = self.connections.lock().unwrap();
                    let pipe = connections
                        .open
                        .get(&connection)
                        .ok_or_else(|| invalid("unknown pipe connection"))?;
                    let reader = pipe
                        .reader
                        .clone()
                        .try_lock_owned()
                        .map_err(|_| invalid("a pipe read is already pending"))?;
                    (reader, pipe.closed.subscribe())
                };
                let mut bytes = vec![0; MAX_CHUNK];
                tokio::select! {
                    biased;
                    _ = closed.changed() => Err(io::Error::other("pipe closed")),
                    length = reader.read(&mut bytes) => {
                        let length = match length {
                            Ok(length) => length,
                            Err(error) if error.kind() == io::ErrorKind::BrokenPipe
                                || error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED as i32) => 0,
                            Err(error) => return Err(error),
                        };
                        Ok(if length == 0 { Value::Null } else { json!(hex::encode(&bytes[..length])) })
                    }
                }
            }
            PipeRequest::Write { connection, hex } => {
                if hex.len() > MAX_CHUNK * 2 {
                    return Err(invalid("pipe transfer exceeds the chunk limit"));
                }
                let bytes = hex::decode(hex).map_err(io::Error::other)?;
                let (mut writer, mut closed) = {
                    let connections = self.connections.lock().unwrap();
                    let pipe = connections
                        .open
                        .get(&connection)
                        .ok_or_else(|| invalid("unknown pipe connection"))?;
                    let writer = pipe
                        .writer
                        .clone()
                        .try_lock_owned()
                        .map_err(|_| invalid("a pipe write is already pending"))?;
                    (writer, pipe.closed.subscribe())
                };
                tokio::select! {
                    biased;
                    _ = closed.changed() => Err(io::Error::other("pipe closed")),
                    result = writer.write_all(&bytes) => { result?; Ok(Value::Null) }
                }
            }
        }
    }
}

async fn run_pipes(id: u32, command: Start) -> io::Result<()> {
    let mut broker = Broker::default();
    let ready = match command {
        Start::ListenPipe { prefix } => PipeListener::bind(&prefix).map(|listener| {
            let ready = json!(listener.endpoint);
            broker.listener = Some(AsyncMutex::new(listener));
            ready
        }),
        Start::ConnectPipe { endpoint } => connect_pipe(&endpoint)
            .and_then(|pipe| broker.connections.get_mut().unwrap().insert(pipe)),
        _ => unreachable!("dispatch checks scoped command"),
    };
    let started = ready.is_ok();
    send(id, ready)?;
    if !started {
        return Ok(());
    }

    let (tx, mut rx) = mpsc::channel(4);
    std::thread::spawn(move || -> io::Result<()> {
        let mut stdin = io::stdin().lock();
        while let Some(bytes) = read_line(&mut stdin)? {
            let request = serde_json::from_slice::<Request<PipeRequest>>(&bytes)?;
            if tx.blocking_send(request).is_err() {
                break;
            }
        }
        Ok(())
    });
    let broker = Arc::new(broker);
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            request = rx.recv() => {
                let Some(Request { id, body }) = request else { break; };
                if tasks.len() >= MAX_CONNECTIONS * 4 {
                    send(id, Err(io::Error::other("too many pending pipe requests")))?;
                    continue;
                }
                let broker = broker.clone();
                tasks.spawn(async move { send(id, broker.request(body).await) });
            }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                result.map_err(io::Error::other)??;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
