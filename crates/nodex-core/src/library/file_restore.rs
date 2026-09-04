//! Forward restoration of exact File bindings within the caller's durable
//! Document commit. Planning never changes Files or grants.

use std::collections::BTreeMap;

use nodex_core_contracts::{BoundModuleContext, CommittedCoreModuleEvent};
use rusqlite::Connection;

use crate::domain::files::{FileRestoreAction, FileSnapshotManifest};
use crate::domain::identity::stable_uuid_v7;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use crate::infrastructure::event_log::load_committed_event_by_sequence;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::files::{self, FileWriteContext};
use super::mutation::{self, MutationEffects};

#[derive(Debug)]
pub(crate) struct FileRestorePlan {
    actions: Vec<FileRestoreAction>,
    pub(crate) mapping: BTreeMap<String, String>,
}

impl FileRestorePlan {
    pub(crate) fn authorized_file_ids(&self) -> Vec<String> {
        self.mapping.values().cloned().collect()
    }
}

pub(crate) fn plan(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    snapshot: &FileSnapshotManifest,
) -> Result<FileRestorePlan, StoreError> {
    let actions =
        snapshot.plan_restore(&files::restore_heads(connection, library_id, snapshot)?)?;
    let mapping = actions
        .iter()
        .map(|action| match action {
            FileRestoreAction::Reuse { file_id, .. } => (file_id.clone(), file_id.clone()),
            FileRestoreAction::Fork { source_file_id, .. } => (
                source_file_id.clone(),
                stable_uuid_v7(operation_id, "restored_file", source_file_id),
            ),
        })
        .collect();
    Ok(FileRestorePlan { actions, mapping })
}

/// The caller has authorized the source Document. Its current canonical uses
/// prove current File reads; newly introduced IDs still need direct authority.
pub(crate) fn capture_recovery_target(
    connection: &Connection,
    context: &BoundModuleContext,
    source_document_id: &str,
    file_id: &str,
) -> Result<Option<crate::domain::files::FileSnapshotTarget>, StoreError> {
    let current_use: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM block_asset_refs WHERE library_id = ?1 AND document_id = ?2 AND file_id = ?3)",
        rusqlite::params![context.library_id.0, source_document_id, file_id], |row| row.get(0),
    )?;
    if !current_use {
        match super::file_access::require_direct(connection, context, file_id, false) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.code,
                    StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        }
    }
    match files::metadata(connection, &context.library_id.0, file_id) {
        Ok(file) => Ok(Some(crate::domain::files::FileSnapshotTarget {
            version: file.head_version,
            default_name: file.default_name,
        })),
        Err(error) if error.code == StoreErrorCode::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Default)]
pub(crate) struct RestoredFiles {
    pub(super) authorized_file_ids: Vec<String>,
    pub(super) created_revisions: BTreeMap<String, i64>,
}

impl RestoredFiles {
    pub(crate) fn merge(&mut self, other: Self) {
        self.authorized_file_ids.extend(other.authorized_file_ids);
        self.authorized_file_ids.sort();
        self.authorized_file_ids.dedup();
        self.created_revisions.extend(other.created_revisions);
    }

    pub(super) fn add_to(&self, effects: &mut MutationEffects) {
        effects
            .file_revisions
            .extend(self.created_revisions.clone());
        effects.committed_revisions.extend(
            self.created_revisions
                .iter()
                .map(|(id, revision)| (format!("file:{id}"), *revision)),
        );
    }
}

pub(crate) fn apply(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    plan: &FileRestorePlan,
) -> Result<RestoredFiles, StoreError> {
    if plan.actions.is_empty() {
        return Ok(RestoredFiles::default());
    }
    let connection = scope.connection();
    let library_id = &context.library_id.0;
    let authority = mutation::resolve_library_mutation_authority(connection, context, library_id)?;
    let write = FileWriteContext {
        connection,
        library_id,
        actor_id: &authority.actor_project_id,
        turn_id: None,
        operation_id: scope.evidence().operation_id(),
        now: scope.committed_at(),
    };
    let mut revisions = BTreeMap::new();
    for action in &plan.actions {
        let (source_id, expected_revision) = match action {
            FileRestoreAction::Reuse {
                file_id,
                expected_revision,
            } => (file_id, expected_revision),
            FileRestoreAction::Fork {
                source_file_id,
                expected_revision,
                ..
            } => (source_file_id, expected_revision),
        };
        if files::metadata(connection, library_id, source_id)?.revision != *expected_revision {
            return Err(StoreError::new(
                StoreErrorCode::RevisionConflict,
                "File changed during snapshot restore",
                false,
            ));
        }
        let FileRestoreAction::Fork {
            source_version,
            default_name,
            ..
        } = action
        else {
            continue;
        };
        let file = files::fork(
            &write,
            source_id,
            *source_version,
            &plan.mapping[source_id],
            default_name,
        )?;
        if let Some(project_id) = &authority.requesting_project_id {
            mutation::grant_created_file(
                connection,
                library_id,
                &file.file_id,
                project_id,
                scope.committed_at(),
            )?;
        }
        revisions.insert(file.file_id, file.revision);
    }
    Ok(RestoredFiles {
        authorized_file_ids: plan.authorized_file_ids(),
        created_revisions: revisions,
    })
}

/// A Document-only restore publishes the File effect on its own. Library
/// creation flows merge it into their one Library event instead.
pub(crate) fn publish(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    restored: &RestoredFiles,
) -> Result<Option<CommittedCoreModuleEvent>, StoreError> {
    if restored.created_revisions.is_empty() {
        return Ok(None);
    }
    let connection = scope.connection();
    let authority =
        mutation::resolve_library_mutation_authority(connection, context, &context.library_id.0)?;
    let revisions = restored.created_revisions.clone();
    let effects = MutationEffects {
        committed_revisions: revisions
            .iter()
            .map(|(id, revision)| (format!("file:{id}"), *revision))
            .collect(),
        file_revisions: revisions,
        page_file_entries: Vec::new(),
        file_mutation: None,
        project_id: authority.actor_project_id.clone(),
        operation_kind: "restore_file_snapshot",
        change_kind: "library.changed",
        did_mutate: true,
        created_target: None,
        affected_parent_keys: Vec::new(),
        affected_block_ids: Vec::new(),
        affected_page_ids: Vec::new(),
        affected_database_ids: Vec::new(),
        affected_view_ids: Vec::new(),
        affected_document_ids: Vec::new(),
        page_create: None,
        page_copy: None,
        canvas_mutation: None,
        block_transfer: None,
        block_transfer_undo: None,
        page_relocation_undo: None,
        structural_edit: None,
        page_lifecycle: None,
        block_property_mutation: None,
        agent_page_copy: None,
        agent_create_pages: None,
        agent_move_pages: None,
        change_payload: None,
        committed_at: scope.committed_at().to_owned(),
    };
    let (_, sequence) = mutation::build_mutation_result(
        connection,
        context,
        scope.store_epoch(),
        scope.evidence().operation_id(),
        effects,
        scope.evidence(),
        &scope.authorization_before()?,
    )?;
    Ok(Some(load_committed_event_by_sequence(
        connection, sequence,
    )?))
}
