use std::fs::File;
use std::io::{self, Cursor, Read, Write};
use std::path::Path;

use nodex_core_contracts::library::{
    LIBRARY_CONTRACT_VERSION, LibraryFileChange as Change, LibraryFileLifecycle,
    LibraryFileReadSource, LibraryFileUsageFilter, LibraryIntent, LibraryRead, LibraryReadValue,
};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::cli::{FileCommand, MutationArgs};
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, selected_project, unwrap_library,
};

pub(crate) struct FileSession<'a> {
    pub client: &'a CoreClient,
    pub project_id: String,
}

impl<'a> FileSession<'a> {
    pub fn new(
        client: &'a CoreClient,
        project: Option<&str>,
        cwd: &Path,
    ) -> Result<Self, CliError> {
        Ok(Self {
            client,
            project_id: selected_project(client, project, cwd)?.id,
        })
    }

    pub fn read(&self, read: LibraryRead) -> Result<LibraryReadValue, CliError> {
        Ok(unwrap_library(self.client.library_read(Some(&self.project_id), read))?.value)
    }

    pub fn query(&self, read: LibraryRead) -> Result<CommandOutput, CliError> {
        let value = match self.read(read)? {
            LibraryReadValue::Files { value } => serde_json::to_value(value),
            LibraryReadValue::File { value } => serde_json::to_value(value),
            LibraryReadValue::FileVersions { value } => serde_json::to_value(value),
            LibraryReadValue::FileUsages { value } => serde_json::to_value(value),
            LibraryReadValue::PageFileInventory { value } => serde_json::to_value(value),
            _ => return Err(internal("Core returned an unexpected File query result")),
        }
        .map_err(|error| internal(error.to_string()))?;
        Ok(CommandOutput::Json(value))
    }

    pub fn apply(
        &self,
        operation_id: String,
        intent: LibraryIntent,
    ) -> Result<CommandOutput, CliError> {
        let response = self
            .client
            .library_apply(
                Some(&self.project_id),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id,
                    store_epoch: StoreEpoch(self.client.handshake.store_epoch.clone()),
                    intent,
                },
            )
            .map_err(map_client_error)?;
        let committed = match response.0 {
            ResponseEnvelope::Ok(value) => value,
            ResponseEnvelope::Error(error) => return Err(map_core_error(error)),
        };
        Ok(CommandOutput::Json(json!({
            "operation_id": committed.receipt().mutation.operation_id,
            "duplicate": committed.receipt().mutation.duplicate,
            "file_mutation": committed.outcome().file_mutation,
            "page_file_entries": committed.outcome().page_file_entries,
            "commit_seq": committed.commit_cursor(),
        })))
    }

    pub fn change(
        &self,
        operation_id: String,
        change: Change,
        turn_id: Option<String>,
    ) -> Result<CommandOutput, CliError> {
        self.apply(
            operation_id,
            LibraryIntent::ApplyFileChange { change, turn_id },
        )
    }

    pub fn prepare(&self, operation_id: &str, source: &Path) -> Result<String, CliError> {
        if source == Path::new("-") {
            let mut bytes = Vec::new();
            io::stdin()
                .lock()
                .take((MAX_FILE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            return self.prepare_bytes(operation_id, &bytes);
        }
        let mut file = open_regular(source, false)?;
        let length = file.metadata().map_err(io_error)?.len();
        self.prepare_reader(operation_id, &mut file, length)
    }

    fn prepare_bytes(&self, operation_id: &str, bytes: &[u8]) -> Result<String, CliError> {
        self.prepare_reader(operation_id, &mut Cursor::new(bytes), bytes.len() as u64)
    }

    fn prepare_reader(
        &self,
        operation_id: &str,
        source: &mut impl Read,
        length: u64,
    ) -> Result<String, CliError> {
        if length > MAX_FILE_BYTES as u64 {
            return Err(invalid("File input exceeds the 64 MiB limit"));
        }
        self.client
            .prepare_blob(
                Some(&self.project_id),
                operation_id,
                &self.client.handshake.store_epoch,
                Some("file"),
                source,
                length,
            )
            .map(|receipt| receipt.receipt_id)
            .map_err(map_client_error)
    }

    pub fn download(
        &self,
        file_id: &str,
        source: LibraryFileReadSource,
        version: Option<i64>,
        output: &Path,
        json_output: bool,
    ) -> Result<CommandOutput, CliError> {
        if json_output && output == Path::new("-") {
            return Err(invalid(
                "Use --output PATH for JSON downloads, or omit --json for exact stdout bytes",
            ));
        }
        let blob = self
            .client
            .read_file_blob(Some(&self.project_id), file_id, &source, version)
            .map_err(map_client_error)?;
        if output == Path::new("-") {
            return Ok(CommandOutput::Bytes(blob.bytes));
        }
        let mut file = open_regular(output, true)?;
        file.set_len(0).map_err(io_error)?;
        file.write_all(&blob.bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        Ok(CommandOutput::Json(
            json!({ "file_id": file_id, "source": source,
            "byte_length": blob.bytes.len(), "mime_type": blob.mime_type,
            "etag": blob.etag, "output": output }),
        ))
    }
}

pub(crate) fn execute(
    client: &CoreClient,
    project: Option<&str>,
    cwd: &Path,
    command: FileCommand,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let session = FileSession::new(client, project, cwd)?;
    match command {
        FileCommand::List(args) => session.query(LibraryRead::Files {
            query: args.query,
            lifecycle: if args.trashed {
                LibraryFileLifecycle::Trashed
            } else {
                LibraryFileLifecycle::Live
            },
            usage: LibraryFileUsageFilter::All,
            cursor: args.pagination.after,
            limit: args.pagination.limit,
        }),
        FileCommand::Info(args) => session.query(LibraryRead::File {
            file_id: args.file_id,
        }),
        FileCommand::Read(args) => session.download(
            &args.file_id,
            LibraryFileReadSource::Direct,
            args.version,
            &args.output,
            json_output,
        ),
        FileCommand::Versions(args) => session.query(LibraryRead::FileVersions {
            file_id: args.file_id,
            cursor: args.pagination.after,
            limit: args.pagination.limit,
        }),
        FileCommand::Usages(args) => session.query(LibraryRead::FileUsages {
            file_id: args.file_id,
            cursor: args.pagination.after,
            limit: args.pagination.limit,
        }),
        FileCommand::Import(args) => {
            let operation = mutation_id(&args.mutation, json_output)?;
            let name = input_name(&args.source, args.name)?;
            let mime_type = args
                .mime
                .unwrap_or_else(|| infer_mime_type(&name).to_owned());
            let prepared_blob_receipt_id = session.prepare(&operation, &args.source)?;
            session.change(
                operation.clone(),
                Change::Create {
                    file_id: file_id_for_operation(&operation),
                    default_name: name,
                    mime_type,
                    prepared_blob_receipt_id,
                },
                args.turn_id,
            )
        }
        FileCommand::Rename(args) => {
            let operation = mutation_id(&args.write.mutation, json_output)?;
            session.change(
                operation,
                Change::Rename {
                    file_id: args.write.file_id,
                    expected_revision: args.write.if_revision,
                    default_name: args.name,
                },
                args.write.turn_id,
            )
        }
        FileCommand::Replace(args) => {
            let operation = mutation_id(&args.write.mutation, json_output)?;
            let mime_type = input_mime(&args.source, args.mime)?;
            let prepared_blob_receipt_id = session.prepare(&operation, &args.source)?;
            session.change(
                operation,
                Change::ReplaceContent {
                    file_id: args.write.file_id,
                    expected_revision: args.write.if_revision,
                    expected_head_version: args.if_head,
                    mime_type,
                    prepared_blob_receipt_id,
                },
                args.write.turn_id,
            )
        }
        FileCommand::Fork(args) => {
            let operation = mutation_id(&args.mutation, json_output)?;
            session.change(
                operation.clone(),
                Change::Fork {
                    source_file_id: args.file_id,
                    source_version: args.version,
                    source: LibraryFileReadSource::Direct,
                    file_id: file_id_for_operation(&operation),
                    default_name: args.name,
                },
                args.turn_id,
            )
        }
        FileCommand::Restore(args) => {
            let operation = mutation_id(&args.write.mutation, json_output)?;
            let blob = client
                .read_file_blob(
                    Some(&session.project_id),
                    &args.write.file_id,
                    &LibraryFileReadSource::Direct,
                    Some(args.version),
                )
                .map_err(map_client_error)?;
            let prepared_blob_receipt_id = session.prepare_bytes(&operation, &blob.bytes)?;
            session.change(
                operation,
                Change::ReplaceContent {
                    file_id: args.write.file_id,
                    expected_revision: args.write.if_revision,
                    expected_head_version: args.if_head,
                    mime_type: blob.mime_type,
                    prepared_blob_receipt_id,
                },
                args.write.turn_id,
            )
        }
        FileCommand::Trash(args) => {
            let operation = mutation_id(&args.mutation, json_output)?;
            session.change(
                operation,
                Change::Trash {
                    file_id: args.file_id,
                    expected_revision: args.if_revision,
                },
                args.turn_id,
            )
        }
        FileCommand::Untrash(args) => {
            let operation = mutation_id(&args.mutation, json_output)?;
            session.change(
                operation,
                Change::Restore {
                    file_id: args.file_id,
                    expected_revision: args.if_revision,
                },
                args.turn_id,
            )
        }
        FileCommand::Purge(args) => {
            let operation = mutation_id(&args.mutation, json_output)?;
            session.change(
                operation,
                Change::Purge {
                    file_id: args.file_id,
                    expected_revision: args.if_revision,
                },
                args.turn_id,
            )
        }
    }
}

pub(crate) fn mutation_id(args: &MutationArgs, json_output: bool) -> Result<String, CliError> {
    if !args.r#return.is_empty() {
        return Err(invalid("File commands do not accept --return fields"));
    }
    operation_id(args.idempotency_key.as_deref(), json_output)
}

pub(crate) fn file_id_for_operation(operation: &str) -> String {
    format!(
        "file:{}",
        hex::encode(&Sha256::digest(operation.as_bytes())[..16])
    )
}

const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

// Validate the opened handle, not a preceding path stat. Never follow final symlinks or block on a FIFO.
fn open_regular(path: &Path, write: bool) -> Result<File, CliError> {
    use rustix::fs::{Mode, OFlags};
    let access = if write {
        OFlags::WRONLY | OFlags::CREATE
    } else {
        OFlags::RDONLY
    };
    let descriptor = rustix::fs::open(
        path,
        access | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|error| io_error(error.into()))?;
    let file = File::from(descriptor);
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(invalid("File input and output paths must be regular files"));
    }
    Ok(file)
}

fn input_name(source: &Path, name: Option<String>) -> Result<String, CliError> {
    if let Some(name) = name {
        return Ok(name);
    }
    if source == Path::new("-") {
        return Err(invalid("stdin import requires --name"));
    }
    source
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .ok_or_else(|| invalid("File input needs a UTF-8 filename or explicit --name"))
}

pub(crate) fn input_mime(source: &Path, mime: Option<String>) -> Result<String, CliError> {
    if let Some(mime) = mime {
        return Ok(mime);
    }
    if source == Path::new("-") {
        return Err(invalid("stdin replacement requires --mime"));
    }
    Ok(infer_mime_type(&input_name(source, None)?).to_owned())
}

pub(crate) fn infer_mime_type(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" | "mdx" => "text/markdown",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub(crate) fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}
fn internal(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::Internal, message)
}
fn io_error(error: io::Error) -> CliError {
    internal(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_file_io_rejects_symlinks_and_special_files_before_truncation() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        std::fs::write(&target, b"keep").unwrap();
        let link = directory.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(open_regular(&link, false).is_err());
        assert!(open_regular(&link, true).is_err());
        assert!(open_regular(directory.path(), false).is_err());
        let fifo = directory.path().join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        assert!(open_regular(&fifo, false).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        let mut file = open_regular(&target, false).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"keep");
    }

    #[test]
    fn input_metadata_is_stable_and_never_guessed_from_current_file_state() {
        assert!(input_name(Path::new("-"), None).is_err());
        assert_eq!(
            input_name(Path::new("-"), Some("notes.txt".into())).unwrap(),
            "notes.txt"
        );
        assert_eq!(
            input_name(Path::new("folder/photo.PNG"), None).unwrap(),
            "photo.PNG"
        );
        assert_eq!(
            input_mime(Path::new("folder/photo.PNG"), None).unwrap(),
            "image/png"
        );
        assert!(input_mime(Path::new("-"), None).is_err());
        assert_eq!(
            input_mime(Path::new("-"), Some("text/plain".into())).unwrap(),
            "text/plain"
        );
    }
}
