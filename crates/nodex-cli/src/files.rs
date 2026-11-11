use std::fs::File;
use std::io::{self, Cursor, Read, Write};
use std::path::Path;

use nodex_core_contracts::library::{
    LIBRARY_CONTRACT_VERSION, LibraryFileChange as Change, LibraryFileReadSource, LibraryIntent,
    LibraryRead, LibraryReadValue,
};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::ResponseEnvelope;
use nodex_core_protocol::client::CoreClient;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::cli::{FileCommand, MutationArgs};
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, selected_project, unwrap_library,
};

#[derive(Serialize, ToSchema)]
pub(crate) struct FileMutationResult {
    operation_id: String,
    duplicate: bool,
    file_mutation: Option<nodex_core_contracts::library::LibraryFileMutationResult>,
    page_file_entries: Vec<nodex_core_contracts::library::LibraryPageFileEntryReceipt>,
    commit_seq: i64,
}
#[derive(Deserialize, Serialize, ToSchema)]
pub(crate) struct FileDownloadResult {
    file_id: String,
    source: LibraryFileReadSource,
    byte_length: usize,
    mime_type: String,
    etag: String,
    output: String,
}

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
        serde_json::to_value(FileMutationResult {
            operation_id: committed.receipt().mutation.operation_id.clone(),
            duplicate: committed.receipt().mutation.duplicate,
            file_mutation: committed.outcome().file_mutation.clone(),
            page_file_entries: committed.outcome().page_file_entries.clone(),
            commit_seq: committed.commit_cursor(),
        })
        .map(CommandOutput::Json)
        .map_err(|error| internal(error.to_string()))
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

    fn admit_change(
        &self,
        command: &str,
        args: &MutationArgs,
        change: Change,
        turn_id: Option<String>,
    ) -> Result<CommandOutput, CliError> {
        let operation = self.admit(command, args, (&change, &turn_id))?;
        self.change(operation, change, turn_id)
    }

    pub fn admit(
        &self,
        command: &str,
        args: &MutationArgs,
        intent: impl Serialize,
    ) -> Result<String, CliError> {
        if !args.r#return.is_empty() {
            return Err(invalid("File commands do not accept --return fields"));
        }
        crate::retry_key::admit(
            self.client,
            Some(&self.project_id),
            command,
            args.idempotency_key.as_deref(),
            intent,
        )
    }

    pub fn prepare_input(
        &self,
        command: &str,
        args: &MutationArgs,
        intent: impl Serialize,
        source: &Path,
    ) -> Result<(String, String), CliError> {
        let mut bytes = Vec::new();
        let limit = (MAX_FILE_BYTES + 1) as u64;
        if source == Path::new("-") {
            io::stdin()
                .lock()
                .take(limit)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
        } else {
            open_regular(source, false)?
                .take(limit)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
        }
        if bytes.len() > MAX_FILE_BYTES {
            return Err(invalid("File input exceeds the 64 MiB limit"));
        }
        let operation = self.admit(command, args, (intent, hex::encode(Sha256::digest(&bytes))))?;
        let receipt = self.prepare_bytes(&operation, &bytes)?;
        Ok((operation, receipt))
    }

    fn prepare_bytes(&self, operation_id: &str, bytes: &[u8]) -> Result<String, CliError> {
        self.client
            .prepare_file_blob(
                Some(&self.project_id),
                operation_id,
                &self.client.handshake.store_epoch,
                Some("file"),
                &mut Cursor::new(bytes),
                bytes.len() as u64,
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
        serde_json::to_value(FileDownloadResult {
            file_id: file_id.to_owned(),
            source,
            byte_length: blob.bytes.len(),
            mime_type: blob.mime_type,
            etag: blob.etag,
            output: output.to_string_lossy().into_owned(),
        })
        .map(CommandOutput::Json)
        .map_err(|error| internal(error.to_string()))
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
        FileCommand::Read(args) => session.download(
            &args.file_id,
            LibraryFileReadSource::Direct,
            args.version,
            &args.output,
            json_output,
        ),
        FileCommand::Import(args) => {
            let name = input_name(&args.source, args.name)?;
            let mime_type = args
                .mime
                .unwrap_or_else(|| infer_mime_type(&name).to_owned());
            let (operation, prepared_blob_receipt_id) = session.prepare_input(
                "file import",
                &args.mutation,
                (&name, &mime_type, &args.turn_id),
                &args.source,
            )?;
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
        FileCommand::Rename(args) => session.admit_change(
            "file rename",
            &args.write.mutation,
            Change::Rename {
                file_id: args.write.file_id,
                expected_revision: args.write.if_revision,
                default_name: args.name,
            },
            args.write.turn_id,
        ),
        FileCommand::Replace(args) => {
            let mime_type = input_mime(&args.source, args.mime)?;
            let (operation, prepared_blob_receipt_id) = session.prepare_input(
                "file replace",
                &args.write.mutation,
                (
                    &args.write.file_id,
                    args.write.if_revision,
                    args.if_head,
                    &mime_type,
                    &args.write.turn_id,
                ),
                &args.source,
            )?;
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
            let operation = session.admit(
                "file fork",
                &args.mutation,
                (&args.file_id, args.version, &args.name, &args.turn_id),
            )?;
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
            let operation = session.admit(
                "file restore",
                &args.write.mutation,
                (
                    &args.write.file_id,
                    args.version,
                    args.write.if_revision,
                    args.if_head,
                    &args.write.turn_id,
                ),
            )?;
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
        FileCommand::Trash(args) => session.admit_change(
            "file trash",
            &args.mutation,
            Change::Trash {
                file_id: args.file_id,
                expected_revision: args.if_revision,
            },
            args.turn_id,
        ),
        FileCommand::Untrash(args) => session.admit_change(
            "file untrash",
            &args.mutation,
            Change::Restore {
                file_id: args.file_id,
                expected_revision: args.if_revision,
            },
            args.turn_id,
        ),
        FileCommand::Purge(args) => session.admit_change(
            "file purge",
            &args.mutation,
            Change::Purge {
                file_id: args.file_id,
                expected_revision: args.if_revision,
            },
            args.turn_id,
        ),
    }
}

pub(crate) fn file_id_for_operation(operation: &str) -> String {
    format!(
        "file:{}",
        hex::encode(&Sha256::digest(operation.as_bytes())[..16])
    )
}

pub(crate) const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

// Validate the opened handle, not a preceding path stat. Never follow final symlinks or block on a FIFO.
fn open_regular(path: &Path, write: bool) -> Result<File, CliError> {
    nodex_platform::private_fs::open_regular(path, write).map_err(io_error)
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

    #[cfg(unix)]
    #[test]
    fn regular_file_io_rejects_symlinks_and_special_files_before_truncation() {
        let directory = nodex_platform::test_support::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        std::fs::write(&target, b"keep").unwrap();
        let link = directory.path().join("link.txt");
        nodex_platform::private_fs::symlink(&target, &link).unwrap();
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
