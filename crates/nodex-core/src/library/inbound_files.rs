//! Publish a returned message's prepared attachments in its Page-creation transaction.
use crate::infrastructure::{
    durable_mutation::DurableMutationScope,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::library::LibraryFileChange;
use nodex_core_contracts::{BoundModuleContext, ProjectionImpact};
use rusqlite::Connection;

#[allow(clippy::too_many_arguments)]
pub(crate) fn publish(
    connection: &Connection,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    scope: &DurableMutationScope<'_>,
    changes: &[LibraryFileChange],
    now: &str,
) -> Result<String, StoreError> {
    if changes.is_empty() {
        return Ok(String::new());
    }
    let mut markdown = Vec::new();
    let mut revisions = std::collections::BTreeMap::new();
    for change in changes {
        let LibraryFileChange::Create {
            file_id,
            default_name,
            mime_type,
            prepared_blob_receipt_id,
        } = change
        else {
            return Err(StoreError::new(
                StoreErrorCode::InvalidInput,
                "Inbound attachments must create immutable Files",
                false,
            ));
        };
        let blob = crate::infrastructure::prepared_blobs::read_receipt(
            connection,
            epoch,
            &context.library_id.0,
            None,
            operation,
            prepared_blob_receipt_id,
        )?;
        let file = super::files::create(
            &super::files::FileWriteContext {
                connection,
                library_id: &context.library_id.0,
                turn_id: None,
                operation_id: operation,
                now,
            },
            file_id,
            default_name,
            super::files::FileContent {
                blob_hash: &blob.content_hash,
                mime_type,
            },
        )?;
        crate::infrastructure::prepared_blobs::consume(
            connection,
            &blob.receipt_id,
            scope.evidence().commit_seq(),
            now,
        )?;
        let label = file
            .default_name
            .replace('\\', "\\\\")
            .replace('[', "\\[")
            .replace(']', "\\]");
        let prefix = if file.mime_type.starts_with("image/") {
            "!"
        } else {
            ""
        };
        markdown.push(format!("{prefix}[{label}](nodex://files/{file_id})"));
        revisions.insert(file_id.clone(), file.revision);
    }
    let impact = ProjectionImpact::Resources {
        page_ids: vec![],
        database_ids: vec![],
        data_source_ids: vec![],
        view_ids: vec![],
        document_heads: vec![],
    };
    crate::infrastructure::event_log::append_change_log(connection,crate::infrastructure::event_log::NewChangeLogEntry{
        project_id:None,store_epoch:epoch,kind:"library.changed",operation_id:Some(operation),block_ids:&[],document_ids:&[],database_block_ids:&[],
        payload_json:&serde_json::json!({"module":"library","operationKind":"publish_inbound_files","didMutate":true,"affectedParentKeys":[],"affectedPageIds":[],"affectedDatabaseIds":[],"affectedViewIds":[],"fileRevisions":revisions}).to_string(),projection_impact:&impact,committed_at:now,
    },scope.evidence())?;
    Ok(markdown.join("\n\n"))
}
