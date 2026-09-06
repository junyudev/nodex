use std::path::Path;

use nodex_core_contracts::library::{
    LibraryFileReadSource, LibraryIntent, LibraryPageFileCollisionPolicy,
    LibraryPageFileEntryChange as Change, LibraryPageFileSelector, LibraryRead, LibraryReadValue,
};
use nodex_core_protocol::client::CoreClient;

use crate::cli::{PageFileCommand, PageFileWriteArgs};
use crate::error::CliError;
use crate::files::{
    FileSession, file_id_for_operation, infer_mime_type, input_mime, invalid, mutation_id,
};
use crate::runtime::{CommandOutput, resolve_page_selector};

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
        PageFileCommand::List(args) => session.query(LibraryRead::PageFileInventory {
            page_id: resolve_page(&args.page)?,
            query: args.query,
            cursor: args.pagination.after,
            limit: args.pagination.limit,
        }),
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
            session.download(
                &value.file.file_id,
                LibraryFileReadSource::Page { page_id },
                None,
                &args.output,
                json_output,
            )
        }
        PageFileCommand::Put(args) => {
            let operation = mutation_id(&args.mutation)?;
            let page_id = resolve_page(&args.page)?;
            let mime_type = args
                .mime
                .unwrap_or_else(|| infer_mime_type(&args.path).to_owned());
            let prepared_blob_receipt_id = session.prepare(&operation, &args.source)?;
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
            apply_entry(&session, args.write, change)
        }
        PageFileCommand::RenamePath(args) => {
            let change = Change::Rename {
                file_id: args.write.file_id.clone(),
                logical_path: args.path,
            };
            apply_entry(&session, args.write, change)
        }
        PageFileCommand::Remove(args) => {
            let change = Change::Remove {
                file_id: args.file_id.clone(),
            };
            apply_entry(&session, args, change)
        }
        PageFileCommand::ReplaceEntry(args) => {
            let operation = mutation_id(&args.write.mutation)?;
            let page_id = resolve_page(&args.write.page)?;
            let mime_type = input_mime(&args.source, args.mime)?;
            let prepared_blob_receipt_id = session.prepare(&operation, &args.source)?;
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

fn apply_entry(
    session: &FileSession<'_>,
    args: PageFileWriteArgs,
    change: Change,
) -> Result<CommandOutput, CliError> {
    let operation = mutation_id(&args.mutation)?;
    let page_id = resolve_page_selector(session.client, &session.project_id, &args.page)?;
    session.apply(
        operation,
        LibraryIntent::ApplyPageFileEntries {
            page_id,
            expected_manifest_revision: args.if_manifest,
            changes: vec![change],
            turn_id: args.turn_id,
        },
    )
}

fn transfer(
    session: &FileSession<'_>,
    args: crate::cli::PageFileTransferArgs,
    copy: bool,
) -> Result<CommandOutput, CliError> {
    let operation = mutation_id(&args.mutation)?;
    let source_page_id = resolve_page_selector(session.client, &session.project_id, &args.page)?;
    let target_page_id = resolve_page_selector(session.client, &session.project_id, &args.to)?;
    session.apply(
        operation,
        LibraryIntent::TransferPageFileEntry {
            file_id: args.file_id,
            source_page_id,
            target_page_id,
            source_manifest_revision: args.if_source_manifest,
            target_manifest_revision: args.if_target_manifest,
            target_logical_path: args.path,
            copy,
        },
    )
}
