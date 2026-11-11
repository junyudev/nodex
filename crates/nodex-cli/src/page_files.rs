use std::path::Path;

use serde::Serialize;
use utoipa::ToSchema;

use nodex_core_contracts::library::{
    LibraryFileReadSource, LibraryIntent, LibraryPageFileAttachment,
    LibraryPageFileAttachmentActor, LibraryPageFileCollisionPolicy,
    LibraryPageFileEntryChange as Change, LibraryPageFileSelector, LibraryRead, LibraryReadValue,
};
use nodex_core_protocol::client::CoreClient;

use crate::cli::{PageFileCommand, PageFileListArgs, PageFileWriteArgs};
use crate::error::{CliError, CliErrorCode};
use crate::files::{FileSession, file_id_for_operation, infer_mime_type, input_mime, invalid};
use crate::runtime::{CommandOutput, resolve_page_selector};

#[derive(Serialize, ToSchema)]
pub(crate) struct PageFileDownloadResult {
    #[serde(flatten)]
    download: crate::files::FileDownloadResult,
    #[schema(required = true)]
    attachment: Option<LibraryPageFileAttachment>,
}

pub(crate) fn execute(
    client: &CoreClient,
    project: Option<&str>,
    cwd: &Path,
    command: PageFileCommand,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let session = FileSession::new(client, project, cwd)?;
    let resolve_page =
        |selector: &str| resolve_page_selector(client, &session.project_id, selector);
    match command {
        PageFileCommand::List(args) => list(&session, args, json_output),
        PageFileCommand::Read(args) => {
            let page_id = resolve_page(&args.page)?;
            let selector = match (args.file_id, args.path) {
                (Some(file_id), None) => LibraryPageFileSelector::FileId { file_id },
                (None, Some(logical_path)) => LibraryPageFileSelector::Path { logical_path },
                _ => return Err(invalid("Select exactly one --file-id or --path")),
            };
            let LibraryReadValue::ResolvedPageFile { value } =
                session.read(LibraryRead::ResolvePageFile {
                    page_id: page_id.clone(),
                    selector,
                })?
            else {
                return Err(invalid("Core returned an unexpected Page File result"));
            };
            let output = session.download(
                &value.file.file_id,
                LibraryFileReadSource::Page { page_id },
                None,
                &args.output,
                json_output,
            )?;
            let CommandOutput::Json(download) = output else {
                return Ok(output);
            };
            let download = serde_json::from_value(download).map_err(internal)?;
            serde_json::to_value(PageFileDownloadResult {
                download,
                attachment: value.attachment,
            })
            .map(CommandOutput::Json)
            .map_err(internal)
        }
        PageFileCommand::Put(args) => {
            let page_id = resolve_page(&args.page)?;
            let mime_type = args
                .mime
                .unwrap_or_else(|| infer_mime_type(&args.path).to_owned());
            let (operation, prepared_blob_receipt_id) = session.prepare_input(
                "page file put",
                &args.mutation,
                (
                    &page_id,
                    args.if_manifest,
                    &args.path,
                    &mime_type,
                    args.replace_entry,
                    &args.turn_id,
                ),
                &args.source,
            )?;
            session.apply(
                operation.clone(),
                LibraryIntent::PutPageFileEntry {
                    page_id,
                    expected_manifest_revision: args.if_manifest,
                    file_id: file_id_for_operation(&operation),
                    logical_path: args.path,
                    mime_type,
                    prepared_blob_receipt_id,
                    replace_entry: args.replace_entry,
                    turn_id: args.turn_id,
                },
            )
        }
        PageFileCommand::Add(args) => {
            let change = Change::Attach {
                file_id: args.write.file_id.clone(),
                logical_path: args.path,
                source: LibraryFileReadSource::Direct,
                collision_policy: LibraryPageFileCollisionPolicy::Reject,
            };
            apply_entry(&session, "page file add", args.write, change)
        }
        PageFileCommand::RenamePath(args) => {
            let change = Change::Rename {
                file_id: args.write.file_id.clone(),
                logical_path: args.path,
            };
            apply_entry(&session, "page file rename-path", args.write, change)
        }
        PageFileCommand::Remove(args) => {
            let change = Change::Remove {
                file_id: args.file_id.clone(),
            };
            apply_entry(&session, "page file remove", args, change)
        }
        PageFileCommand::ReplaceEntry(args) => {
            let page_id = resolve_page(&args.write.page)?;
            let mime_type = input_mime(&args.source, args.mime)?;
            let (operation, prepared_blob_receipt_id) = session.prepare_input(
                "page file replace-entry",
                &args.write.mutation,
                (
                    &page_id,
                    &args.write.file_id,
                    args.write.if_manifest,
                    &mime_type,
                    &args.write.turn_id,
                ),
                &args.source,
            )?;
            session.apply(
                operation.clone(),
                LibraryIntent::ApplyPageFileEntries {
                    page_id,
                    expected_manifest_revision: args.write.if_manifest,
                    changes: vec![Change::Replace {
                        file_id: args.write.file_id,
                        replacement_file_id: file_id_for_operation(&operation),
                        mime_type,
                        prepared_blob_receipt_id,
                    }],
                    turn_id: args.write.turn_id,
                },
            )
        }
        PageFileCommand::Move(args) => transfer(&session, args, false),
        PageFileCommand::Copy(args) => transfer(&session, args, true),
    }
}

fn list(
    session: &FileSession<'_>,
    args: PageFileListArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let page_id = resolve_page_selector(session.client, &session.project_id, &args.page)?;
    let LibraryReadValue::PageFileInventory { value } =
        session.read(LibraryRead::PageFileInventory {
            page_id,
            query: args.query,
            cursor: args.cursor,
            limit: args.limit,
        })?
    else {
        return Err(invalid("Core returned an unexpected Page File inventory"));
    };
    if json_output {
        return serde_json::to_value(value)
            .map(CommandOutput::Json)
            .map_err(internal);
    }
    let mut output = String::new();
    for item in value.files {
        let actor = match item
            .attachment
            .as_ref()
            .map(|attachment| &attachment.attached_by)
        {
            Some(LibraryPageFileAttachmentActor::Member { member_id }) => {
                format!("member:{member_id}")
            }
            Some(LibraryPageFileAttachmentActor::Agent { session_id, .. }) => {
                format!("agent:{session_id}")
            }
            Some(LibraryPageFileAttachmentActor::Service { kind }) => format!("service:{kind:?}"),
            None => "—".to_owned(),
        };
        let time = item
            .attachment
            .as_ref()
            .and_then(|attachment| attachment.attached_at.as_deref())
            .unwrap_or("—");
        let path = item
            .logical_path
            .as_deref()
            .unwrap_or(&item.file.default_name);
        output.push_str(&format!(
            "{}\t{}\t{actor}\t{time}\n",
            item.file.file_id,
            path.replace(['\n', '\r', '\t'], " ")
        ));
    }
    if let Some(cursor) = value.next_cursor {
        output.push_str(&format!("cursor\t{cursor}\n"));
    }
    Ok(CommandOutput::Text(output))
}

fn internal(error: serde_json::Error) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

fn apply_entry(
    session: &FileSession<'_>,
    command: &str,
    args: PageFileWriteArgs,
    change: Change,
) -> Result<CommandOutput, CliError> {
    let page_id = resolve_page_selector(session.client, &session.project_id, &args.page)?;
    let intent = LibraryIntent::ApplyPageFileEntries {
        page_id,
        expected_manifest_revision: args.if_manifest,
        changes: vec![change],
        turn_id: args.turn_id,
    };
    let operation = session.admit(command, &args.mutation, &intent)?;
    session.apply(operation, intent)
}

fn transfer(
    session: &FileSession<'_>,
    args: crate::cli::PageFileTransferArgs,
    copy: bool,
) -> Result<CommandOutput, CliError> {
    let source_page_id = resolve_page_selector(session.client, &session.project_id, &args.page)?;
    let target_page_id = resolve_page_selector(session.client, &session.project_id, &args.to)?;
    let intent = LibraryIntent::TransferPageFileEntry {
        file_id: args.file_id,
        source_page_id,
        target_page_id,
        source_manifest_revision: args.if_source_manifest,
        target_manifest_revision: args.if_target_manifest,
        target_logical_path: args.path,
        copy,
    };
    let command = if copy {
        "page file copy"
    } else {
        "page file move"
    };
    let operation = session.admit(command, &args.mutation, &intent)?;
    session.apply(operation, intent)
}
