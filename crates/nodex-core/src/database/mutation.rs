use std::collections::{BTreeMap, BTreeSet, HashSet};

mod data_history;
pub(crate) mod property_value_history;

use nodex_core_contracts::database::{
    DatabaseCommitValue, DatabaseDuplicatePropertyOption, DatabaseEvent, DatabaseEventKind,
    DatabaseIntent, DatabaseListMoveSelection, DatabaseListMoveTarget, DatabaseListMoveUndoRecipe,
    DatabaseListProjectionExpectation, DatabaseOperationOutcome, DatabaseOptionPlacement,
    DatabasePageLayoutPlacement, DatabasePagePosition, DatabasePagePropertyAddress,
    DatabasePagePropertyVisibility, DatabasePersonalViewChange, DatabasePropertyCapabilities,
    DatabasePropertyPlacement, DatabasePropertySchema, DatabasePropertySetDelta,
    DatabasePropertyValueEdit, DatabasePropertyValueInput, DatabasePropertyValueMutation,
    DatabaseReceipt, DatabaseRelationCardinality, DatabaseTaskParentPage, DatabaseTransferTarget,
    DatabaseViewConditionalColorSource, DatabaseViewDefinition, DatabaseViewDisclosureTarget,
    DatabaseViewField, DatabaseViewFilter, DatabaseViewFilterOperator as ViewFilterOperator,
    DatabaseViewIntrinsicField, DatabaseViewLayout, DatabaseViewPersonalPreferences,
    DatabaseViewPlacement, DatabaseViewPreferencesOverrideInput,
    DatabaseViewPresentationOverrideInput, DatabaseViewRulesOverrideInput,
    DatabaseViewSortDirection, DatabaseViewSortField,
};
use nodex_core_contracts::{
    BoundModuleContext, CoreModuleEventPayload, ModuleApplyRequest, ModuleMutationReceipt,
    ModuleName, StoreEpoch,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::document::{read_store_epoch, sha256};
use crate::domain::fractional_rank::{
    FractionalRankError, FractionalRankErrorCode, RankedItem, plan as plan_fractional_rank,
};
use crate::domain::identity::stable_uuid_v7;
use crate::domain::ordered_position::LogicalPositionRun;
use crate::infrastructure::durable_mutation::{
    self, CommitResult, DurableMutationScope, OperationIdentity, ReceiptMetadata, SealedOutcome,
};
use crate::infrastructure::event_log::{
    NewChangeLogEntry, append_change_log, load_committed_event_by_sequence,
};
use crate::infrastructure::projection_impact::{expand_database_coordinates, impact_for_payload};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use super::DatabaseApplyOutcome;
use super::authorization::{authorize_required, project_primary_database};
use super::ensure_database_page_key;
use super::is_trusted_library_database_context;
use super::relation::RelationValueEdit as RelationEdit;
use super::view_contract::MAX_VIEW_SORT_RULES;

const MODULE_NAME: &str = "database";
const MAX_OPERATIONS: usize = 64;
const MAX_BULK_VALUES: usize = 4_096;
const MAX_ID_LENGTH: usize = 512;
const MAX_PROPERTY_ID_LENGTH: usize = 128;
const MAX_NAME_LENGTH: usize = 256;
const MAX_VIEW_DISPLAY_PROPERTIES: usize = 64;
const MAX_COLLAPSED_OCCURRENCES: i64 = 2_000;
const MAX_OCCURRENCE_KEY_LENGTH: usize = 1_024;

#[derive(Default)]
struct MutationEffects {
    database_ids: BTreeSet<String>,
    data_source_ids: BTreeSet<String>,
    page_ids: BTreeSet<String>,
    view_ids: BTreeSet<String>,
    revisions: BTreeMap<String, i64>,
    personal_preferences: BTreeMap<String, DatabaseViewPersonalPreferences>,
    occurrence_disclosures: BTreeMap<(String, DatabaseViewDisclosureTarget), bool>,
    operation_outcomes: Vec<DatabaseOperationOutcome>,
}

struct DatabaseMutationAuthority {
    /// Actor/delivery coordinate for the change ledger; never a content owner.
    actor_project_id: String,
    project_id: Option<String>,
}

impl DatabaseMutationAuthority {
    fn is_library(&self) -> bool {
        self.project_id.is_none()
    }
}

#[derive(Debug)]
struct SourceRow {
    id: String,
    database_id: String,
    lifecycle: String,
    revision: i64,
}

#[derive(Debug)]
pub(crate) struct PropertyRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) value_type: String,
    pub(crate) config_json: String,
    pub(crate) rank_key: String,
    pub(crate) lifecycle: String,
    pub(crate) revision: i64,
    pub(crate) created_at: String,
}

#[derive(Debug)]
struct ContainerRow {
    default_view_id: Option<String>,
    lifecycle: String,
}

#[derive(Debug)]
struct ViewRow {
    id: String,
    database_id: String,
    data_source_id: String,
    name: String,
    layout: String,
    config_json: String,
    rank_key: String,
    lifecycle: String,
    revision: i64,
    created_at: String,
}

pub(super) fn apply(
    writer: &StoreWriter,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: ModuleApplyRequest<Vec<DatabaseIntent>>,
) -> Result<DatabaseApplyOutcome, StoreError> {
    validate_request(&request)?;
    let profile_id = profile_id.to_owned();
    let library_id = library_id.to_owned();
    let context = context.clone();
    writer.call(move |connection| {
        let result = with_immediate_transaction(connection, |transaction| {
            apply_in_transaction(transaction, &profile_id, &library_id, &context, &request)
        });
        super::finish_order_attempt(connection, result)
    })
}

pub(crate) fn apply_in_transaction(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    context: &BoundModuleContext,
    request: &ModuleApplyRequest<Vec<DatabaseIntent>>,
) -> Result<DatabaseApplyOutcome, StoreError> {
    validate_request(request)?;
    assert_identity(connection, profile_id, library_id)?;
    let authority = mutation_authority(connection, library_id, context)?;
    let store_epoch = read_store_epoch(connection)?;
    if request.store_epoch.0 != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Database mutation targets a stale store epoch",
            true,
        ));
    }
    let fingerprint = serde_json::to_vec(&(
        &context.profile_id,
        &context.library_id,
        &context.project_id,
        &context.adapter,
        request.contract_version,
        &request.store_epoch,
        &request.intent,
    ))
    .map_err(|_| internal("Database mutation cannot be fingerprinted"))?;
    let request_hash = sha256(&fingerprint);
    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Database,
            module_name: MODULE_NAME,
            operation_id: &request.operation_id,
            intent_hash: &request_hash,
            store_epoch: &store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let mut effects = MutationEffects::default();
            data_history::authorize_replays(connection, library_id, &authority, &request.intent)?;
            let history =
                data_history::capture(connection, library_id, &authority, &request.intent)?;
            for (operation_index, intent) in request.intent.iter().enumerate() {
                apply_intent(
                    scope.connection(),
                    context.profile_id.0.as_str(),
                    library_id,
                    &authority,
                    intent,
                    u32::try_from(operation_index)
                        .map_err(|_| internal("Database operation index"))?,
                    &now,
                    &mut effects,
                )?;
            }
            if let Some(outcome) = data_history::finish(connection, history, request.intent.len())?
            {
                effects.operation_outcomes.push(outcome);
            }
            refresh_scheduled_page_indexes(scope.connection(), &effects.page_ids, &now)?;
            seal_commit(
                scope,
                context,
                request,
                &request_hash,
                &authority,
                &now,
                effects,
            )
        },
    )?;
    result.verify_manifest_identity(|committed| {
        (committed.commit_seq, committed.store_epoch.0.clone())
    })?;
    match result {
        CommitResult::Committed {
            outcome: committed, ..
        } => {
            let event = load_committed_event_by_sequence(connection, committed.event_sequence)?;
            Ok(DatabaseApplyOutcome {
                committed,
                event: Some(event),
            })
        }
        CommitResult::NoOp { outcome: committed } => Ok(DatabaseApplyOutcome {
            committed,
            event: None,
        }),
        CommitResult::IdempotentReplay {
            outcome: mut committed,
            manifest: _,
        } => {
            committed.receipt.mutation.duplicate = true;
            Ok(DatabaseApplyOutcome {
                committed,
                event: None,
            })
        }
    }
}

/// Applies Database canonical writes as part of an owning domain mutation.
/// The owner publishes the single receipt/event/manifest; this collaborator
/// must never allocate an independent commit for the same user command.
pub(crate) fn apply_as_collaborator(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    operation_id: &str,
    intents: &[DatabaseIntent],
    committed_at: &str,
) -> Result<DatabaseReceipt, StoreError> {
    if intents.is_empty() || intents.len() > MAX_OPERATIONS {
        return Err(invalid("Database collaborator operation count is invalid"));
    }
    let authority = mutation_authority(connection, library_id, context)?;
    let mut effects = MutationEffects::default();
    for (operation_index, intent) in intents.iter().enumerate() {
        apply_intent(
            connection,
            context.profile_id.0.as_str(),
            library_id,
            &authority,
            intent,
            u32::try_from(operation_index)
                .map_err(|_| internal("Database collaborator operation index"))?,
            committed_at,
            &mut effects,
        )?;
    }
    refresh_scheduled_page_indexes(connection, &effects.page_ids, committed_at)?;
    Ok(DatabaseReceipt {
        mutation: ModuleMutationReceipt {
            // The owning receipt carries the public operation identity. This
            // private collaborator value is used only to merge typed effects.
            operation_id: operation_id.to_owned(),
            duplicate: false,
        },
        affected_database_ids: effects.database_ids.into_iter().collect(),
        affected_data_source_ids: effects.data_source_ids.into_iter().collect(),
        affected_page_ids: effects.page_ids.into_iter().collect(),
        affected_view_ids: effects.view_ids.into_iter().collect(),
        operation_kinds: intents
            .iter()
            .map(database_intent_kind)
            .map(str::to_owned)
            .collect(),
        operation_outcomes: effects.operation_outcomes,
        committed_revisions: effects.revisions,
        commit_seq: 0,
        committed_at: committed_at.to_owned(),
    })
}

fn validate_request(request: &ModuleApplyRequest<Vec<DatabaseIntent>>) -> Result<(), StoreError> {
    validate_id(&request.operation_id, "operation_id", MAX_ID_LENGTH)?;
    if request.intent.is_empty() || request.intent.len() > MAX_OPERATIONS {
        return Err(invalid(format!(
            "Database apply requires between 1 and {MAX_OPERATIONS} operations"
        )));
    }
    for intent in &request.intent {
        if let DatabaseIntent::RenamePageKeyPrefix {
            database_id,
            expected_revision,
            ..
        } = intent
        {
            validate_id(database_id, "database_id", MAX_ID_LENGTH)?;
            if *expected_revision < 1 {
                return Err(invalid(
                    "Page-key namespace expected revision must be positive",
                ));
            }
        }
        if let DatabaseIntent::EditPropertyValues { edits } = intent
            && (edits.is_empty() || edits.len() > MAX_BULK_VALUES)
        {
            return Err(invalid(format!(
                "edit_property_values requires between 1 and {MAX_BULK_VALUES} edits"
            )));
        }
        if let DatabaseIntent::SetTaskParent { pages, .. } = intent
            && (pages.is_empty() || pages.len() > MAX_BULK_VALUES)
        {
            return Err(invalid(format!(
                "set_task_parent requires between 1 and {MAX_BULK_VALUES} Pages"
            )));
        }
        if let DatabaseIntent::PutViewPersonalPreferences {
            expected_revision, ..
        } = intent
            && *expected_revision < 0
        {
            return Err(invalid(
                "View personal preferences revision cannot be negative",
            ));
        }
        if let DatabaseIntent::SetViewOccurrenceDisclosure { target, .. } = intent {
            validate_disclosure_target(target)?;
        }
        if let DatabaseIntent::MoveListOccurrences {
            view_id,
            initiator_occurrence_key,
            selection,
            target,
            expected_projection,
            ..
        } = intent
        {
            validate_id(view_id, "view_id", MAX_ID_LENGTH)?;
            validate_id(
                initiator_occurrence_key,
                "initiator_occurrence_key",
                MAX_OCCURRENCE_KEY_LENGTH,
            )?;
            validate_list_move_selection(selection)?;
            validate_list_move_target(target)?;
            validate_id(
                &expected_projection.scope_key,
                "expected_projection.scope_key",
                MAX_OCCURRENCE_KEY_LENGTH,
            )?;
            if expected_projection.revision < 0 || expected_projection.covered_commit_seq < 0 {
                return Err(invalid("List projection revisions cannot be negative"));
            }
        }
        if let DatabaseIntent::UndoListOccurrenceMove { recipe } = intent {
            validate_list_move_undo_recipe(recipe)?;
        }
        if let DatabaseIntent::ReverseDataEdit { recipe } = intent {
            if request.intent.len() != 1 {
                return Err(invalid(
                    "A Database history inverse must be one atomic command",
                ));
            }
            data_history::validate(recipe)?;
        }
    }
    Ok(())
}

fn validate_occurrence_keys(
    keys: &[String],
    label: &str,
    allow_empty: bool,
) -> Result<(), StoreError> {
    if (!allow_empty && keys.is_empty()) || keys.len() > MAX_BULK_VALUES {
        return Err(invalid(format!(
            "{label} must contain between {} and {MAX_BULK_VALUES} occurrence keys",
            usize::from(!allow_empty),
        )));
    }
    let mut unique = HashSet::with_capacity(keys.len());
    for key in keys {
        validate_id(key, label, MAX_OCCURRENCE_KEY_LENGTH)?;
        if !unique.insert(key) {
            return Err(invalid(format!(
                "{label} contains duplicate occurrence keys"
            )));
        }
    }
    Ok(())
}

fn validate_list_move_selection(selection: &DatabaseListMoveSelection) -> Result<(), StoreError> {
    match selection {
        DatabaseListMoveSelection::Explicit { occurrence_keys } => {
            validate_occurrence_keys(occurrence_keys, "selection.occurrence_keys", false)
        }
        DatabaseListMoveSelection::AllMatching {
            excluded_occurrence_keys,
        } => validate_occurrence_keys(
            excluded_occurrence_keys,
            "selection.excluded_occurrence_keys",
            true,
        ),
    }
}

fn validate_list_move_target(target: &DatabaseListMoveTarget) -> Result<(), StoreError> {
    let Some(occurrence_key) = (match target {
        DatabaseListMoveTarget::Page { occurrence_key, .. }
        | DatabaseListMoveTarget::Group { occurrence_key } => Some(occurrence_key),
        DatabaseListMoveTarget::Root => None,
    }) else {
        return Ok(());
    };
    validate_id(
        occurrence_key,
        "target.occurrence_key",
        MAX_OCCURRENCE_KEY_LENGTH,
    )
}

fn validate_list_move_undo_recipe(recipe: &DatabaseListMoveUndoRecipe) -> Result<(), StoreError> {
    validate_id(&recipe.view_id, "recipe.view_id", MAX_ID_LENGTH)?;
    validate_id(
        &recipe.data_source_id,
        "recipe.data_source_id",
        MAX_ID_LENGTH,
    )?;
    if recipe.property_states.len() > MAX_BULK_VALUES
        || recipe.post_parent_guards.is_empty()
        || recipe.post_parent_guards.len() > MAX_BULK_VALUES
        || recipe.restore_runs.is_empty()
        || recipe.restore_runs.len() > MAX_BULK_VALUES
    {
        return Err(invalid("List move Undo recipe exceeds its bounded shape"));
    }
    let mut guard_pages = HashSet::new();
    for guard in &recipe.post_parent_guards {
        validate_id(&guard.page_id, "recipe.page_id", MAX_ID_LENGTH)?;
        if !guard_pages.insert(guard.page_id.as_str()) {
            return Err(invalid("List move Undo recipe repeats a root Page"));
        }
        if let Some(parent_page_id) = &guard.parent_page_id {
            validate_id(parent_page_id, "recipe.parent_page_id", MAX_ID_LENGTH)?;
        }
    }
    if recipe.post_order_runs.len() > MAX_BULK_VALUES {
        return Err(invalid(
            "List move order evidence exceeds its bounded shape",
        ));
    }
    let mut ordered_pages = HashSet::new();
    for run in &recipe.post_order_runs {
        if run.page_ids.is_empty() || run.page_ids.len() > MAX_BULK_VALUES {
            return Err(invalid("List move order run is empty or too large"));
        }
        if let Some(before_page_id) = &run.before_page_id {
            validate_id(
                before_page_id,
                "recipe.post_order_before_page_id",
                MAX_ID_LENGTH,
            )?;
            if guard_pages.contains(before_page_id.as_str()) {
                return Err(invalid("List move order anchor belongs to the moved roots"));
            }
        }
        for page_id in &run.page_ids {
            if !ordered_pages.insert(page_id.as_str())
                || !recipe.post_parent_guards.iter().any(|guard| {
                    guard.page_id == *page_id && guard.parent_page_id == run.parent_page_id
                })
            {
                return Err(invalid(
                    "List move order evidence does not match its guarded roots",
                ));
            }
        }
    }
    let mut restored_pages = HashSet::new();
    for run in &recipe.restore_runs {
        if run.page_ids.is_empty() || run.page_ids.len() > MAX_BULK_VALUES {
            return Err(invalid("List move Undo restore run is empty or too large"));
        }
        for page_id in &run.page_ids {
            validate_id(page_id, "recipe.restore_page_id", MAX_ID_LENGTH)?;
            if !restored_pages.insert(page_id.as_str()) {
                return Err(invalid("List move Undo recipe restores a Page twice"));
            }
        }
        if let Some(parent_page_id) = &run.parent_page_id {
            validate_id(
                parent_page_id,
                "recipe.restore_parent_page_id",
                MAX_ID_LENGTH,
            )?;
        }
        if let Some(before_page_id) = &run.before_page_id {
            validate_id(
                before_page_id,
                "recipe.restore_before_page_id",
                MAX_ID_LENGTH,
            )?;
        }
    }
    if restored_pages != guard_pages {
        return Err(invalid(
            "List move Undo restore roots do not match its post-state guards",
        ));
    }
    for state in &recipe.property_states {
        validate_id(&state.page_id, "recipe.property_page_id", MAX_ID_LENGTH)?;
        validate_id(
            &state.property_id,
            "recipe.property_id",
            MAX_PROPERTY_ID_LENGTH,
        )?;
    }
    Ok(())
}

fn database_intent_kind(intent: &DatabaseIntent) -> &'static str {
    match intent {
        DatabaseIntent::RenamePageKeyPrefix { .. } => "rename_page_key_prefix",
        DatabaseIntent::PutProperty { .. } => "put_property",
        DatabaseIntent::MoveProperty { .. } => "move_property",
        DatabaseIntent::ChangePropertyType { .. } => "change_property_type",
        DatabaseIntent::DuplicateProperty { .. } => "duplicate_property",
        DatabaseIntent::RestoreProperty { .. } => "restore_property",
        DatabaseIntent::PermanentlyDeleteProperty { .. } => "permanently_delete_property",
        DatabaseIntent::DeleteProperty { .. } => "delete_property",
        DatabaseIntent::PutOption { .. } => "put_option",
        DatabaseIntent::MoveOption { .. } => "move_option",
        DatabaseIntent::DeleteOption { .. } => "delete_option",
        DatabaseIntent::DeleteOptionAndClearValues { .. } => "delete_option_and_clear_values",
        DatabaseIntent::PutPageLayoutEntry { .. } => "put_page_layout_entry",
        DatabaseIntent::EditPropertyValues { .. } => "edit_property_values",
        DatabaseIntent::TransferPage { .. } => "transfer_page",
        DatabaseIntent::PutView { .. } => "put_view",
        DatabaseIntent::DuplicateView { .. } => "duplicate_view",
        DatabaseIntent::ChangeViewLayout { .. } => "change_view_layout",
        DatabaseIntent::MoveView { .. } => "move_view",
        DatabaseIntent::DeleteView { .. } => "delete_view",
        DatabaseIntent::PositionPage { .. } => "position_page",
        DatabaseIntent::PositionPages { .. } => "position_pages",
        DatabaseIntent::SetTaskParent { .. } => "set_task_parent",
        DatabaseIntent::MoveListOccurrences { .. } => "move_list_occurrences",
        DatabaseIntent::UndoListOccurrenceMove { .. } => "undo_list_occurrence_move",
        DatabaseIntent::ReverseDataEdit { .. } => "reverse_data_edit",
        DatabaseIntent::PutViewPersonalPreferences { .. } => "put_view_personal_preferences",
        DatabaseIntent::SetViewOccurrenceDisclosure { .. } => "set_view_occurrence_disclosure",
    }
}

fn page_detail_dependency_ids(intents: &[DatabaseIntent]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut data_source_ids = BTreeSet::new();
    let mut database_ids = BTreeSet::new();
    for intent in intents {
        match intent {
            DatabaseIntent::RenamePageKeyPrefix { database_id, .. } => {
                database_ids.insert(database_id.clone());
            }
            DatabaseIntent::PutProperty { data_source_id, .. }
            | DatabaseIntent::MoveProperty { data_source_id, .. }
            | DatabaseIntent::ChangePropertyType { data_source_id, .. }
            | DatabaseIntent::DuplicateProperty { data_source_id, .. }
            | DatabaseIntent::RestoreProperty { data_source_id, .. }
            | DatabaseIntent::PermanentlyDeleteProperty { data_source_id, .. }
            | DatabaseIntent::DeleteProperty { data_source_id, .. }
            | DatabaseIntent::PutOption { data_source_id, .. }
            | DatabaseIntent::MoveOption { data_source_id, .. }
            | DatabaseIntent::DeleteOption { data_source_id, .. }
            | DatabaseIntent::DeleteOptionAndClearValues { data_source_id, .. }
            | DatabaseIntent::PutPageLayoutEntry { data_source_id, .. } => {
                data_source_ids.insert(data_source_id.clone());
            }
            DatabaseIntent::PutView { database_id, .. }
            | DatabaseIntent::DuplicateView { database_id, .. }
            | DatabaseIntent::ChangeViewLayout { database_id, .. }
            | DatabaseIntent::MoveView { database_id, .. }
            | DatabaseIntent::DeleteView { database_id, .. } => {
                database_ids.insert(database_id.clone());
            }
            DatabaseIntent::EditPropertyValues { .. }
            | DatabaseIntent::TransferPage { .. }
            | DatabaseIntent::PositionPage { .. }
            | DatabaseIntent::PositionPages { .. }
            | DatabaseIntent::SetTaskParent { .. }
            | DatabaseIntent::MoveListOccurrences { .. }
            | DatabaseIntent::UndoListOccurrenceMove { .. }
            | DatabaseIntent::ReverseDataEdit { .. }
            | DatabaseIntent::PutViewPersonalPreferences { .. }
            | DatabaseIntent::SetViewOccurrenceDisclosure { .. } => {}
        }
    }
    (data_source_ids, database_ids)
}

#[allow(clippy::too_many_arguments)]
fn apply_intent(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    intent: &DatabaseIntent,
    operation_index: u32,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    let project_id = authority.actor_project_id.as_str();
    let library_scope = authority.is_library();
    match intent {
        DatabaseIntent::RenamePageKeyPrefix {
            database_id,
            expected_revision,
            prefix,
        } => rename_page_key_namespace_prefix(
            connection,
            library_id,
            project_id,
            database_id,
            *expected_revision,
            prefix,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PutProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
            name,
            schema,
            before_property_id,
        } => put_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            name,
            schema,
            before_property_id.as_deref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::MoveProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
            placement,
        } => move_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            placement,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::ChangePropertyType {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
            schema,
        } => change_property_type(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            schema,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DuplicateProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
            new_property_id,
            name,
            option_ids,
        } => duplicate_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            new_property_id,
            name,
            option_ids,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::RestoreProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
        } => restore_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PermanentlyDeleteProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
        } => permanently_delete_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DeleteProperty {
            data_source_id,
            property_id,
            expected_data_source_revision,
            expected_property_revision,
        } => delete_property(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            *expected_data_source_revision,
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PutOption {
            data_source_id,
            property_id,
            option_id,
            name,
            color,
            expected_property_revision,
        } => put_option(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            option_id,
            name,
            color.as_deref(),
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::MoveOption {
            data_source_id,
            property_id,
            option_id,
            expected_property_revision,
            placement,
        } => move_option(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            option_id,
            *expected_property_revision,
            placement,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DeleteOption {
            data_source_id,
            property_id,
            option_id,
            expected_property_revision,
        } => delete_option(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            option_id,
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DeleteOptionAndClearValues {
            data_source_id,
            property_id,
            option_id,
            expected_property_revision,
        } => delete_option_and_clear_values(
            connection,
            library_id,
            project_id,
            data_source_id,
            property_id,
            option_id,
            *expected_property_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PutPageLayoutEntry {
            data_source_id,
            expected_revision,
            property_id,
            visibility,
            placement,
        } => put_page_layout_entry(
            connection,
            library_id,
            project_id,
            data_source_id,
            *expected_revision,
            property_id,
            *visibility,
            placement.as_ref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::EditPropertyValues { edits } => {
            let mut addresses = HashSet::with_capacity(edits.len());
            for edit in edits {
                let address_key = (
                    edit.address.page_id.as_str(),
                    edit.address.data_source_id.as_str(),
                    edit.address.property_id.as_str(),
                );
                if !addresses.insert(address_key) {
                    return Err(invalid(
                        "edit_property_values contains a duplicate Page Property address",
                    ));
                }
                edit_property_value(
                    connection,
                    library_id,
                    project_id,
                    edit,
                    now,
                    effects,
                    library_scope,
                )?;
            }
            Ok(())
        }
        DatabaseIntent::PutView {
            database_id,
            data_source_id,
            view_id,
            expected_revision,
            name,
            layout,
            definition,
            is_default,
            before_view_id,
        } => put_view(
            connection,
            library_id,
            project_id,
            database_id,
            data_source_id,
            view_id,
            *expected_revision,
            name,
            *layout,
            definition,
            *is_default,
            before_view_id.as_deref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DuplicateView {
            database_id,
            source_view_id,
            expected_revision,
            new_view_id,
        } => duplicate_view(
            connection,
            library_id,
            project_id,
            database_id,
            source_view_id,
            *expected_revision,
            new_view_id,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::ChangeViewLayout {
            database_id,
            view_id,
            expected_revision,
            layout,
        } => change_view_layout(
            connection,
            library_id,
            project_id,
            database_id,
            view_id,
            *expected_revision,
            *layout,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::MoveView {
            database_id,
            view_id,
            expected_revision,
            placement,
        } => move_view(
            connection,
            library_id,
            project_id,
            database_id,
            view_id,
            *expected_revision,
            placement,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::DeleteView {
            database_id,
            view_id,
            expected_revision,
        } => delete_view(
            connection,
            library_id,
            project_id,
            database_id,
            view_id,
            *expected_revision,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PositionPage {
            view_id,
            page_id,
            expected_position_revision,
            before_page_id,
        } => position_pages(
            connection,
            library_id,
            project_id,
            view_id,
            &[DatabasePagePosition {
                page_id: page_id.clone(),
                expected_position_revision: *expected_position_revision,
            }],
            before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::PositionPages {
            view_id,
            pages,
            before_page_id,
        } => position_pages(
            connection,
            library_id,
            project_id,
            view_id,
            pages,
            before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::SetTaskParent {
            data_source_id,
            pages,
            parent_page_id,
            before_page_id,
        } => set_task_parent(
            connection,
            library_id,
            project_id,
            data_source_id,
            pages,
            parent_page_id.as_deref(),
            before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::MoveListOccurrences {
            view_id,
            preferences_override,
            expected_projection,
            initiator_occurrence_key,
            selection,
            target,
        } => move_list_occurrences(
            connection,
            library_id,
            project_id,
            authority.project_id.as_deref(),
            view_id,
            preferences_override,
            expected_projection,
            initiator_occurrence_key,
            selection,
            target,
            operation_index,
            now,
            effects,
            library_scope,
        ),
        DatabaseIntent::UndoListOccurrenceMove { recipe } => undo_list_occurrence_move(
            connection,
            library_id,
            authority,
            recipe,
            operation_index,
            now,
            effects,
        ),
        DatabaseIntent::ReverseDataEdit { recipe } => data_history::reverse(
            connection,
            profile_id,
            library_id,
            authority,
            recipe,
            operation_index,
            now,
            effects,
        ),
        DatabaseIntent::PutViewPersonalPreferences {
            view_id,
            expected_revision,
            rules_override,
            presentation_override,
        } => put_view_personal_preferences(
            connection,
            profile_id,
            library_id,
            project_id,
            authority.project_id.as_deref(),
            view_id,
            *expected_revision,
            rules_override,
            presentation_override,
            now,
            effects,
        ),
        DatabaseIntent::SetViewOccurrenceDisclosure {
            view_id,
            target,
            collapsed,
        } => set_view_occurrence_disclosure(
            connection,
            profile_id,
            library_id,
            authority.project_id.as_deref(),
            view_id,
            target,
            *collapsed,
            now,
            effects,
        ),
        DatabaseIntent::TransferPage {
            page_id,
            expected_parent_revision,
            expected_active_membership_revision,
            target,
        } => transfer_page(
            connection,
            library_id,
            project_id,
            page_id,
            *expected_parent_revision,
            *expected_active_membership_revision,
            target,
            now,
            effects,
            library_scope,
            false,
            false,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn rename_page_key_namespace_prefix(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    expected_revision: i64,
    prefix: &str,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let container = require_container(connection, library_id, database_id)?;
    if container.lifecycle != "active" {
        return Err(not_found("Database is not active"));
    }
    authorize_write(
        connection,
        project_id,
        database_id,
        DatabaseWriteAction::ManageNamespace,
        library_scope,
    )?;
    let namespace = super::rename_page_key_prefix(
        connection,
        library_id,
        database_id,
        expected_revision,
        prefix,
        now,
    )?;
    effects.revisions.insert(
        format!("page_key_namespace:{database_id}"),
        namespace.revision,
    );
    if namespace.revision != expected_revision {
        effects.database_ids.insert(database_id.to_owned());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn put_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    name: &str,
    schema: &DatabasePropertySchema,
    before_property_id: Option<&str>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    validate_id(data_source_id, "data_source_id", MAX_ID_LENGTH)?;
    validate_id(property_id, "property_id", MAX_PROPERTY_ID_LENGTH)?;
    if !super::property_semantics::is_canonical_property_id(property_id) {
        return Err(invalid("Property ID is not canonical"));
    }
    let name = validate_name(name, "Property name")?;
    let value_type = super::property_semantics::value_type(schema);
    if !super::property_semantics::schema_matches_canonical_property(
        property_id,
        data_source_id,
        schema,
    ) {
        return Err(invalid("Reserved Property schema is not canonical"));
    }
    if let DatabasePropertySchema::Relation {
        target_data_source_id,
        ..
    } = schema
    {
        validate_id(
            target_data_source_id,
            "target_data_source_id",
            MAX_ID_LENGTH,
        )?;
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    if let DatabasePropertySchema::Relation {
        target_data_source_id,
        ..
    } = schema
    {
        authorize_relation_target_read(
            connection,
            library_id,
            project_id,
            target_data_source_id,
            library_scope,
        )?;
    }
    require_revision(
        expected_source_revision,
        source.revision,
        "Data Source revision changed",
    )?;
    let existing = property_row(connection, data_source_id, property_id)?;
    if existing.is_none()
        && connection
            .query_row(
                "SELECT 1 FROM retired_data_source_property_ids \
                 WHERE data_source_id = ?1 AND property_id = ?2",
                params![data_source_id, property_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Property identity was permanently retired",
            false,
        ));
    }
    require_revision(
        expected_property_revision,
        existing.as_ref().map_or(0, |property| property.revision),
        "Property revision changed",
    )?;
    if !existing
        .as_ref()
        .is_some_and(|property| property.lifecycle == "active")
    {
        let active_count = connection.query_row(
            "SELECT count(*) FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active'",
            [data_source_id],
            |row| row.get::<_, i64>(0),
        )?;
        ensure_collection_capacity(
            active_count,
            super::MAX_DATA_SOURCE_PROPERTIES,
            "Data Source Property collection",
        )?;
    }
    let config = property_config_for_put(property_id, schema, existing.as_ref())?;
    let preserve_rank = existing
        .as_ref()
        .filter(|property| property.lifecycle == "active" && before_property_id.is_none())
        .map(|property| property.rank_key.clone());
    let rank_key = preserve_rank.clone().unwrap_or_else(|| "0".repeat(32));
    let property_revision = existing
        .as_ref()
        .map_or(1, |property| property.revision + 1);
    let created_at = existing
        .as_ref()
        .map_or(now, |property| property.created_at.as_str());
    connection.execute(
        "INSERT INTO data_source_properties(\
           data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
           schema_revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9) \
         ON CONFLICT(data_source_id, id) DO UPDATE SET \
           name = excluded.name, value_type = excluded.value_type, \
           config_json = excluded.config_json, rank_key = excluded.rank_key, \
           lifecycle = 'active', schema_revision = excluded.schema_revision, \
           updated_at = excluded.updated_at",
        params![
            data_source_id,
            property_id,
            name,
            value_type,
            serde_json::to_string(&config).map_err(|_| internal("Property config"))?,
            rank_key,
            property_revision,
            created_at,
            now,
        ],
    )?;
    if let DatabasePropertySchema::Relation {
        target_data_source_id,
        cardinality,
    } = schema
    {
        let cardinality = match cardinality {
            DatabaseRelationCardinality::One => "one",
            DatabaseRelationCardinality::Many => "many",
        };
        let existing_relation = connection
            .query_row(
                "SELECT target_data_source_id, cardinality FROM data_source_relation_properties \
                 WHERE data_source_id = ?1 AND property_id = ?2",
                params![data_source_id, property_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match existing_relation {
            Some((existing_target, existing_cardinality))
                if existing_target == *target_data_source_id
                    && existing_cardinality == cardinality => {}
            Some(_) => {
                return Err(StoreError::new(
                    StoreErrorCode::Conflict,
                    "Relation Property target and cardinality are immutable",
                    false,
                ));
            }
            None => {
                connection.execute(
                    "INSERT INTO data_source_relation_properties(\
                       data_source_id, property_id, target_data_source_id, cardinality\
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        data_source_id,
                        property_id,
                        target_data_source_id,
                        cardinality
                    ],
                )?;
            }
        }
    }
    if preserve_rank.is_none() {
        reorder_properties(connection, data_source_id, property_id, before_property_id)?;
    }
    connection.execute(
        "INSERT OR IGNORE INTO data_source_page_layouts(\
           data_source_id, revision, created_at, updated_at\
         ) VALUES (?1, 1, ?2, ?2)",
        params![data_source_id, now],
    )?;
    let inserted_layout_entry = connection.execute(
        "INSERT OR IGNORE INTO data_source_page_layout_entries(\
           data_source_id, property_id, rank_key, visibility\
         ) SELECT ?1, id, rank_key, 'always_show' FROM data_source_properties \
           WHERE data_source_id = ?1 AND id = ?2",
        params![data_source_id, property_id],
    )?;
    if inserted_layout_entry == 1 {
        connection.execute(
            "UPDATE data_source_page_layouts SET revision = revision + 1, updated_at = ?1 \
             WHERE data_source_id = ?2",
            params![now, data_source_id],
        )?;
        let layout_revision = connection.query_row(
            "SELECT revision FROM data_source_page_layouts WHERE data_source_id = ?1",
            [data_source_id],
            |row| row.get::<_, i64>(0),
        )?;
        effects
            .revisions
            .insert(format!("page_layout:{data_source_id}"), layout_revision);
    }
    let source_revision = source.revision + 1;
    connection.execute(
        "UPDATE data_sources SET schema_revision = ?1, updated_at = ?2 WHERE id = ?3",
        params![source_revision, now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source_revision);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn property_non_empty_value_count(
    connection: &Connection,
    data_source_id: &str,
    property: &PropertyRow,
) -> Result<i64, StoreError> {
    if property.value_type == "relation" {
        return connection
            .query_row(
                "SELECT count(DISTINCT source_membership_id) \
                 FROM data_source_relation_edges \
                 WHERE source_data_source_id = ?1 AND property_id = ?2",
                params![data_source_id, property.id],
                |row| row.get(0),
            )
            .map_err(StoreError::from);
    }
    connection
        .query_row(
            "SELECT count(*) FROM data_source_property_values \
             WHERE data_source_id = ?1 AND property_id = ?2 AND \
               CASE value_type \
                 WHEN 'text' THEN json_type(value_json) = 'text' \
                   AND length(json_extract(value_json, '$')) > 0 \
                 WHEN 'multi_select' THEN json_type(value_json) = 'array' \
                   AND json_array_length(value_json) > 0 \
                 ELSE json_type(value_json) <> 'null' \
               END",
            params![data_source_id, property.id],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

#[allow(clippy::too_many_arguments)]
fn move_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    placement: &DatabasePropertyPlacement,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    require_revision(
        expected_source_revision,
        source.revision,
        "Data Source revision changed",
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let before_property_id = match placement {
        DatabasePropertyPlacement::Before { property_id } => Some(property_id.as_str()),
        DatabasePropertyPlacement::End => None,
    };
    reorder_properties(connection, data_source_id, property_id, before_property_id)?;
    let property_revision = property.revision + 1;
    connection.execute(
        "UPDATE data_source_properties SET schema_revision = ?1, updated_at = ?2 \
         WHERE data_source_id = ?3 AND id = ?4",
        params![property_revision, now, data_source_id, property_id],
    )?;
    let source_revision = source.revision + 1;
    connection.execute(
        "UPDATE data_sources SET schema_revision = ?1, updated_at = ?2 WHERE id = ?3",
        params![source_revision, now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source_revision);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn change_property_type(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    schema: &DatabasePropertySchema,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if !super::property_semantics::is_custom_property_id(property_id) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Required Properties cannot change type",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    require_revision(
        expected_source_revision,
        source.revision,
        "Data Source revision changed",
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let existing_schema = super::property_semantics::schema_from_storage(
        connection,
        data_source_id,
        property_id,
        &property.value_type,
    )?;
    if existing_schema == *schema {
        effects.revisions.insert(
            format!("property:{data_source_id}:{property_id}"),
            property.revision,
        );
        return Ok(());
    }
    let presentation_only = matches!(
        (&existing_schema, schema),
        (
            DatabasePropertySchema::Number { .. },
            DatabasePropertySchema::Number { .. }
        ) | (
            DatabasePropertySchema::Date { .. },
            DatabasePropertySchema::Date { .. }
        ) | (
            DatabasePropertySchema::Datetime { .. },
            DatabasePropertySchema::Datetime { .. }
        )
    );
    if !presentation_only
        && property_non_empty_value_count(connection, data_source_id, &property)? > 0
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Property type and Relation structure can change only when all values are empty",
            false,
        ));
    }
    if let DatabasePropertySchema::Relation {
        target_data_source_id,
        ..
    } = schema
    {
        authorize_relation_target_read(
            connection,
            library_id,
            project_id,
            target_data_source_id,
            library_scope,
        )?;
    }
    let value_type = super::property_semantics::value_type(schema);
    if !presentation_only {
        connection.execute(
            "DELETE FROM data_source_property_values \
             WHERE data_source_id = ?1 AND property_id = ?2",
            params![data_source_id, property_id],
        )?;
        connection.execute(
            "DELETE FROM data_source_relation_properties \
             WHERE data_source_id = ?1 AND property_id = ?2",
            params![data_source_id, property_id],
        )?;
        if let DatabasePropertySchema::Relation {
            target_data_source_id,
            cardinality,
        } = schema
        {
            connection.execute(
                "INSERT INTO data_source_relation_properties(\
                   data_source_id, property_id, target_data_source_id, cardinality\
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    data_source_id,
                    property_id,
                    target_data_source_id,
                    match cardinality {
                        DatabaseRelationCardinality::One => "one",
                        DatabaseRelationCardinality::Many => "many",
                    }
                ],
            )?;
        }
    }
    let config = property_config_for_put(property_id, schema, None)?;
    connection.execute(
        "UPDATE data_source_properties SET value_type = ?1, config_json = ?2, \
           schema_revision = schema_revision + 1, updated_at = ?3 \
         WHERE data_source_id = ?4 AND id = ?5",
        params![
            value_type,
            serde_json::to_string(&config).map_err(|_| internal("Property config"))?,
            now,
            data_source_id,
            property_id
        ],
    )?;
    connection.execute(
        "UPDATE data_sources SET schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE id = ?2",
        params![now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn duplicate_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    new_property_id: &str,
    name: &str,
    option_ids: &[DatabaseDuplicatePropertyOption],
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    if property_id == super::property_semantics::TASK_PARENT_PROPERTY_ID {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Task Parent cannot be duplicated",
            false,
        ));
    }
    let schema = super::property_semantics::schema_from_storage(
        connection,
        data_source_id,
        property_id,
        &property.value_type,
    )?;
    put_property(
        connection,
        library_id,
        project_id,
        data_source_id,
        new_property_id,
        expected_source_revision,
        0,
        name,
        &schema,
        None,
        now,
        effects,
        library_scope,
    )?;
    if !matches!(property.value_type.as_str(), "select" | "multi_select") {
        if !option_ids.is_empty() {
            return Err(invalid(
                "Only option-backed Properties accept duplicate option identities",
            ));
        }
        return Ok(());
    }
    let source_options = option_config(&property)?.options;
    if source_options.len() != option_ids.len() {
        return Err(invalid(
            "Duplicate Property option identity plan is incomplete",
        ));
    }
    let mapping = option_ids
        .iter()
        .map(|mapping| {
            (
                mapping.source_option_id.as_str(),
                mapping.new_option_id.as_str(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    if mapping.len() != option_ids.len() {
        return Err(invalid(
            "Duplicate Property option identity plan contains duplicates",
        ));
    }
    let options = source_options
        .into_iter()
        .map(|option| {
            let new_option_id = mapping
                .get(option.id.as_str())
                .ok_or_else(|| invalid("Duplicate Property option identity plan is incomplete"))?;
            if !super::property_semantics::is_canonical_option_id(new_property_id, new_option_id) {
                return Err(invalid(
                    "Duplicated Property option identity is not canonical",
                ));
            }
            Ok(super::property_semantics::PropertyOption {
                id: (*new_option_id).to_owned(),
                name: option.name,
                color: option.color,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    connection.execute(
        "UPDATE data_source_properties SET config_json = ?1 \
         WHERE data_source_id = ?2 AND id = ?3",
        params![
            serde_json::to_string(&json!({ "options": options }))
                .map_err(|_| internal("Duplicated Property options"))?,
            data_source_id,
            new_property_id
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn restore_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let property = property_row(connection, data_source_id, property_id)?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    if property.lifecycle != "deleted" {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Only deleted Properties can be restored",
            false,
        ));
    }
    if super::property_semantics::is_required_property_id(property_id) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Required Properties cannot enter the deleted lifecycle",
            false,
        ));
    }
    let schema = super::property_semantics::schema_from_storage(
        connection,
        data_source_id,
        property_id,
        &property.value_type,
    )?;
    put_property(
        connection,
        library_id,
        project_id,
        data_source_id,
        property_id,
        expected_source_revision,
        expected_property_revision,
        &property.name,
        &schema,
        None,
        now,
        effects,
        library_scope,
    )
}

#[allow(clippy::too_many_arguments)]
fn permanently_delete_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if super::property_semantics::is_required_property_id(property_id) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Required Property identities cannot be retired",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    require_revision(
        expected_source_revision,
        source.revision,
        "Data Source revision changed",
    )?;
    let property = property_row(connection, data_source_id, property_id)?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    if property.lifecycle != "deleted" {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Property must be deleted before it can be permanently removed",
            false,
        ));
    }
    if active_view_references_property(connection, data_source_id, property_id)? {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Property is still referenced by an active Database View",
            false,
        ));
    }
    connection.execute(
        "DELETE FROM data_source_page_layout_entries \
         WHERE data_source_id = ?1 AND property_id = ?2",
        params![data_source_id, property_id],
    )?;
    connection.execute(
        "INSERT INTO retired_data_source_property_ids(data_source_id, property_id, retired_at) \
         VALUES (?1, ?2, ?3)",
        params![data_source_id, property_id, now],
    )?;
    connection.execute(
        "DELETE FROM data_source_properties WHERE data_source_id = ?1 AND id = ?2",
        params![data_source_id, property_id],
    )?;
    connection.execute(
        "UPDATE data_source_page_layouts SET revision = revision + 1, updated_at = ?1 \
         WHERE data_source_id = ?2",
        params![now, data_source_id],
    )?;
    connection.execute(
        "UPDATE data_sources SET schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE id = ?2",
        params![now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    let page_layout_revision = connection.query_row(
        "SELECT revision FROM data_source_page_layouts WHERE data_source_id = ?1",
        [data_source_id],
        |row| row.get::<_, i64>(0),
    )?;
    effects.revisions.insert(
        format!("page_layout:{data_source_id}"),
        page_layout_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn delete_property(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    expected_source_revision: i64,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if super::property_semantics::is_required_property_id(property_id) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Required Properties cannot be deleted",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    require_revision(
        expected_source_revision,
        source.revision,
        "Data Source revision changed",
    )?;
    let property = property_row(connection, data_source_id, property_id)?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    if property.lifecycle != "active" {
        return Err(not_found("Property is not active"));
    }
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    if active_view_references_property(connection, data_source_id, property_id)? {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Property is referenced by an active Database View",
            false,
        ));
    }
    connection.execute(
        "UPDATE data_source_properties SET lifecycle = 'deleted', \
           schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE data_source_id = ?2 AND id = ?3",
        params![now, data_source_id, property_id],
    )?;
    if matches!(property_id, "scheduled_start" | "scheduled_end") {
        let page_ids = connection
            .prepare(
                "SELECT page_block_id FROM data_source_page_memberships \
                 WHERE data_source_id = ?1 AND removed_at IS NULL",
            )?
            .query_map([data_source_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        effects.page_ids.extend(page_ids);
    }
    connection.execute(
        "UPDATE data_sources SET schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE id = ?2",
        params![now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn put_option(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    option_id: &str,
    name: &str,
    color: Option<&str>,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    validate_id(option_id, "option_id", MAX_PROPERTY_ID_LENGTH)?;
    if !super::property_semantics::is_canonical_option_id(property_id, option_id) {
        return Err(invalid("Property option ID is not canonical"));
    }
    if !super::property_semantics::is_canonical_option_name(property_id, name) {
        return Err(invalid(
            "Option name must be canonical Unicode with no surrounding whitespace and at most 256 bytes",
        ));
    }
    if color.is_some_and(|value| !super::property_semantics::is_canonical_option_color(value)) {
        return Err(invalid("Option color must contain between 1 and 128 bytes"));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let mut config = option_config(&property)?;
    if property_id == super::property_semantics::STATUS_PROPERTY_ID
        && !config.options.iter().any(|option| option.id == option_id)
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Workflow status option membership is fixed",
            false,
        ));
    }
    if property_id == "tags"
        && config
            .options
            .iter()
            .any(|option| option.id != option_id && option.name == name)
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Tags options must have unique canonical names",
            false,
        ));
    }
    let next = super::property_semantics::PropertyOption {
        id: option_id.to_owned(),
        name: name.to_owned(),
        color: color.map(str::to_owned),
    };
    if let Some(existing) = config
        .options
        .iter_mut()
        .find(|option| option.id == option_id)
    {
        if *existing == next {
            effects.revisions.insert(
                format!("property:{data_source_id}:{property_id}"),
                property.revision,
            );
            return Ok(());
        }
        *existing = next;
    } else {
        if config.options.len() >= super::MAX_PROPERTY_OPTIONS {
            return Err(invalid("Property option registry exceeds its bound"));
        }
        config.options.push(next);
    }
    persist_option_config(connection, &source, &property, &config, now)?;
    if property_id == "tags" {
        refresh_tag_projections(connection, data_source_id, &config, now, effects)?;
    }
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn delete_option(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    option_id: &str,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if property_id == super::property_semantics::STATUS_PROPERTY_ID {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Workflow status options cannot be deleted",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let mut config = option_config(&property)?;
    if !config.options.iter().any(|option| option.id == option_id) {
        return Err(not_found("Property option is unavailable"));
    }
    let mut statement = connection.prepare(
        "SELECT value_json FROM data_source_property_values \
         WHERE data_source_id = ?1 AND property_id = ?2",
    )?;
    let values = statement
        .query_map(params![data_source_id, property_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for value in values {
        let value = parse_json(&value, "Property value")?;
        if value == Value::String(option_id.to_owned())
            || value
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(option_id)))
        {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Property option is selected by an existing Page",
                false,
            ));
        }
    }
    config.options.retain(|option| option.id != option_id);
    persist_option_config(connection, &source, &property, &config, now)?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn move_option(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    option_id: &str,
    expected_property_revision: i64,
    placement: &DatabaseOptionPlacement,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if property_id == super::property_semantics::STATUS_PROPERTY_ID {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Workflow status option order is fixed",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let mut config = option_config(&property)?;
    let source_index = config
        .options
        .iter()
        .position(|option| option.id == option_id)
        .ok_or_else(|| not_found("Property option is unavailable"))?;
    let option = config.options.remove(source_index);
    let target_index = match placement {
        DatabaseOptionPlacement::Before {
            option_id: anchor_id,
        } => config
            .options
            .iter()
            .position(|candidate| candidate.id == *anchor_id)
            .ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::Conflict,
                    "Property option placement anchor changed",
                    false,
                )
            })?,
        DatabaseOptionPlacement::End => config.options.len(),
    };
    config.options.insert(target_index, option);
    persist_option_config(connection, &source, &property, &config, now)?;
    if property_id == "tags" {
        refresh_tag_projections(connection, data_source_id, &config, now, effects)?;
    }
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn delete_option_and_clear_values(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    property_id: &str,
    option_id: &str,
    expected_property_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if property_id == super::property_semantics::STATUS_PROPERTY_ID {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Workflow status options cannot be deleted",
            false,
        ));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    let property = active_property(connection, data_source_id, property_id)?;
    require_revision(
        expected_property_revision,
        property.revision,
        "Property revision changed",
    )?;
    let mut config = option_config(&property)?;
    if !config.options.iter().any(|option| option.id == option_id) {
        return Err(not_found("Property option is unavailable"));
    }
    let selected_values = connection
        .prepare(
            "SELECT membership.page_block_id, value.value_json, value.revision \
             FROM data_source_property_values value \
             JOIN data_source_page_memberships membership \
               ON membership.data_source_id = value.data_source_id \
              AND membership.id = value.membership_id \
             WHERE value.data_source_id = ?1 AND value.property_id = ?2 \
               AND membership.removed_at IS NULL",
        )?
        .query_map(params![data_source_id, property_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (page_id, value_json, revision) in selected_values {
        let value = parse_json(&value_json, "Property value")?;
        let next = if property.value_type == "select" {
            if value.as_str() != Some(option_id) {
                continue;
            }
            Value::Null
        } else {
            let Some(values) = value.as_array() else {
                return Err(corrupt("Stored multi_select value is not an array"));
            };
            if !values.iter().any(|value| value.as_str() == Some(option_id)) {
                continue;
            }
            Value::Array(
                values
                    .iter()
                    .filter(|value| value.as_str() != Some(option_id))
                    .cloned()
                    .collect(),
            )
        };
        set_value(
            connection,
            library_id,
            project_id,
            &DatabasePagePropertyAddress {
                page_id,
                data_source_id: data_source_id.to_owned(),
                property_id: property_id.to_owned(),
            },
            revision,
            &next,
            now,
            effects,
            library_scope,
        )?;
    }
    config.options.retain(|option| option.id != option_id);
    persist_option_config(connection, &source, &property, &config, now)?;
    if property_id == "tags" {
        refresh_tag_projections(connection, data_source_id, &config, now, effects)?;
    }
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("source:{data_source_id}"), source.revision + 1);
    effects.revisions.insert(
        format!("property:{data_source_id}:{property_id}"),
        property.revision + 1,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn put_page_layout_entry(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    expected_revision: i64,
    property_id: &str,
    visibility: DatabasePagePropertyVisibility,
    placement: Option<&DatabasePageLayoutPlacement>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        library_scope,
    )?;
    let revision = connection
        .query_row(
            "SELECT revision FROM data_source_page_layouts WHERE data_source_id = ?1",
            [data_source_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Data Source Page layout is unavailable"))?;
    require_revision(
        expected_revision,
        revision,
        "Data Source Page layout revision changed",
    )?;
    active_property(connection, data_source_id, property_id)?;
    let visibility = match visibility {
        DatabasePagePropertyVisibility::AlwaysShow => "always_show",
        DatabasePagePropertyVisibility::HideWhenEmpty => "hide_when_empty",
        DatabasePagePropertyVisibility::AlwaysHide => "always_hide",
    };
    let changed = connection.execute(
        "UPDATE data_source_page_layout_entries SET visibility = ?1 \
         WHERE data_source_id = ?2 AND property_id = ?3 AND visibility <> ?1",
        params![visibility, data_source_id, property_id],
    )?;
    if let Some(placement) = placement {
        reorder_page_layout_entries(connection, data_source_id, property_id, placement)?;
    }
    if changed == 0 && placement.is_none() {
        effects
            .revisions
            .insert(format!("page_layout:{data_source_id}"), revision);
        return Ok(());
    }
    let next_revision = revision + 1;
    connection.execute(
        "UPDATE data_source_page_layouts SET revision = ?1, updated_at = ?2 \
         WHERE data_source_id = ?3",
        params![next_revision, now, data_source_id],
    )?;
    touch_source(effects, &source);
    effects
        .revisions
        .insert(format!("page_layout:{data_source_id}"), next_revision);
    Ok(())
}

fn edit_property_value(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    input: &DatabasePropertyValueMutation,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    match &input.edit {
        DatabasePropertyValueEdit::Replace {
            expected_value_revision,
            value,
        } => {
            let value = property_value_input_json(value)?;
            set_value(
                connection,
                library_id,
                project_id,
                &input.address,
                *expected_value_revision,
                &value,
                now,
                effects,
                library_scope,
            )
        }
        DatabasePropertyValueEdit::PatchSet { delta } => match delta {
            DatabasePropertySetDelta::MultiSelect {
                add_option_ids,
                remove_option_ids,
            } => add_remove_value(
                connection,
                library_id,
                project_id,
                &input.address.page_id,
                &input.address.data_source_id,
                &input.address.property_id,
                add_option_ids,
                remove_option_ids,
                now,
                effects,
                library_scope,
            ),
            DatabasePropertySetDelta::Relation {
                add_page_ids,
                remove_edge_ids,
            } => edit_relation_value(
                connection,
                library_id,
                project_id,
                &input.address,
                RelationEdit::PatchMany {
                    add_page_ids,
                    remove_edge_ids,
                },
                now,
                effects,
                library_scope,
            ),
        },
        DatabasePropertyValueEdit::ReplaceOneRelation {
            expected_value_revision,
            target_page_id,
        } => edit_relation_value(
            connection,
            library_id,
            project_id,
            &input.address,
            RelationEdit::ReplaceOne {
                expected_value_revision: *expected_value_revision,
                target_page_id: target_page_id.as_deref(),
            },
            now,
            effects,
            library_scope,
        ),
        DatabasePropertyValueEdit::ClearManyRelation {
            expected_value_revision,
        } => edit_relation_value(
            connection,
            library_id,
            project_id,
            &input.address,
            RelationEdit::ClearMany {
                expected_value_revision: *expected_value_revision,
            },
            now,
            effects,
            library_scope,
        ),
    }
}

fn property_value_input_json(input: &DatabasePropertyValueInput) -> Result<Value, StoreError> {
    let value = match input {
        DatabasePropertyValueInput::Empty => Value::Null,
        DatabasePropertyValueInput::Text { value }
        | DatabasePropertyValueInput::Date { value }
        | DatabasePropertyValueInput::Datetime { value } => Value::String(value.clone()),
        DatabasePropertyValueInput::Number { value } => {
            if !value.is_finite() {
                return Err(invalid("Number Property requires a finite value"));
            }
            json!(value)
        }
        DatabasePropertyValueInput::Checkbox { value } => Value::Bool(*value),
        DatabasePropertyValueInput::Select { option_id } => Value::String(option_id.clone()),
        DatabasePropertyValueInput::MultiSelect { option_ids } => {
            Value::Array(option_ids.iter().cloned().map(Value::String).collect())
        }
    };
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn edit_relation_value(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    address: &DatabasePagePropertyAddress,
    edit: RelationEdit<'_>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, &address.data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        library_scope,
    )?;
    let property = active_property(connection, &address.data_source_id, &address.property_id)?;
    if property.value_type != "relation" {
        return Err(invalid("Relation value edit requires a Relation Property"));
    }
    let adds_target = match &edit {
        RelationEdit::ReplaceOne { target_page_id, .. } => target_page_id.is_some(),
        RelationEdit::PatchMany { add_page_ids, .. } => !add_page_ids.is_empty(),
        RelationEdit::ClearMany { .. } => false,
    };
    if adds_target {
        let target_data_source_id = super::relation::target_data_source_id(
            connection,
            &address.data_source_id,
            &address.property_id,
        )?;
        authorize_relation_target_read(
            connection,
            library_id,
            project_id,
            &target_data_source_id,
            library_scope,
        )?;
    }
    let outcome = super::relation::apply_value_edit(
        connection,
        library_id,
        (!library_scope).then_some(project_id),
        address,
        edit,
        now,
    )?;
    if !outcome.changed {
        return Ok(());
    }
    record_relation_outcomes(
        connection,
        library_id,
        &outcome.affected_values,
        None,
        now,
        effects,
    )?;
    Ok(())
}

fn record_relation_outcomes(
    connection: &Connection,
    library_id: &str,
    outcomes: &[super::relation::RelationValueRevision],
    skipped_page_id: Option<&str>,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    let metadata_revisions =
        synchronize_relation_value_projections(connection, outcomes, skipped_page_id, now)?;
    let mut source_ids = BTreeSet::new();
    for affected in outcomes {
        effects.revisions.insert(
            format!(
                "value:{}:{}:{}",
                affected.data_source_id, affected.membership_id, affected.property_id
            ),
            affected.value_revision,
        );
        source_ids.insert(affected.data_source_id.as_str());
    }
    for (page_id, metadata_revision) in metadata_revisions {
        effects.page_ids.insert(page_id.clone());
        effects
            .revisions
            .insert(format!("page:{page_id}:metadata"), metadata_revision);
    }
    for data_source_id in source_ids {
        let source = require_source(connection, library_id, data_source_id)?;
        touch_source(effects, &source);
    }
    Ok(())
}

pub(crate) fn synchronize_relation_value_projections(
    connection: &Connection,
    outcomes: &[super::relation::RelationValueRevision],
    skipped_page_id: Option<&str>,
    now: &str,
) -> Result<BTreeMap<String, i64>, StoreError> {
    let mut metadata_revisions = BTreeMap::new();
    for affected in outcomes {
        if skipped_page_id == Some(affected.page_id.as_str()) {
            continue;
        }
        let metadata_revision = match metadata_revisions.get(&affected.page_id) {
            Some(revision) => *revision,
            None => {
                let revision = bump_page_metadata_revision(connection, &affected.page_id, now)?;
                metadata_revisions.insert(affected.page_id.clone(), revision);
                revision
            }
        };
        let property =
            active_property(connection, &affected.data_source_id, &affected.property_id)?;
        refresh_value_projection(
            connection,
            &affected.page_id,
            &affected.property_id,
            &Value::Null,
            affected.value_revision,
            metadata_revision,
            &property,
            now,
        )?;
    }
    Ok(metadata_revisions)
}

#[allow(clippy::too_many_arguments)]
fn set_value(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    address: &DatabasePagePropertyAddress,
    expected_value_revision: i64,
    input_value: &Value,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, &address.data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        library_scope,
    )?;
    let property = active_property(connection, &address.data_source_id, &address.property_id)?;
    if property.value_type == "relation" {
        return Err(invalid("Relation Property requires a Relation value edit"));
    }
    let membership = connection
        .query_row(
            "SELECT id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NULL",
            params![address.data_source_id, address.page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page has no active membership in the Data Source"))?;
    let active_row = connection
        .query_row(
            "SELECT 1 FROM pages page JOIN blocks block \
               ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.parent_kind = 'data_source' \
               AND page.parent_id = ?2 AND block.lifecycle = 'active'",
            params![address.page_id, address.data_source_id],
            |_| Ok(()),
        )
        .optional()?;
    if active_row.is_none() {
        return Err(not_found("Page is not an active row in the Data Source"));
    }
    let existing_revision = connection
        .query_row(
            "SELECT revision FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
            params![address.data_source_id, membership, address.property_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    require_revision(
        expected_value_revision,
        existing_revision,
        "Property value revision changed",
    )?;
    let value = normalize_value(&property, input_value)?;
    let revision = existing_revision + 1;
    connection.execute(
        "INSERT INTO data_source_property_values(\
           data_source_id, membership_id, property_id, value_type, value_json, revision, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(data_source_id, membership_id, property_id) DO UPDATE SET \
           value_type = excluded.value_type, value_json = excluded.value_json, \
           revision = excluded.revision, updated_at = excluded.updated_at",
        params![
            address.data_source_id,
            membership,
            address.property_id,
            property.value_type,
            serde_json::to_string(&value).map_err(|_| internal("Property value"))?,
            revision,
            now,
        ],
    )?;
    update_membership_completion_timestamp(
        connection,
        &membership,
        &address.property_id,
        &value,
        now,
    )?;
    update_grouped_view_projections(
        connection,
        &address.data_source_id,
        &address.property_id,
        &address.page_id,
        &value,
        now,
        effects,
    )?;
    let metadata_revision = bump_page_metadata_revision(connection, &address.page_id, now)?;
    refresh_value_projection(
        connection,
        &address.page_id,
        &address.property_id,
        &value,
        revision,
        metadata_revision,
        &property,
        now,
    )?;
    touch_source(effects, &source);
    effects.page_ids.insert(address.page_id.clone());
    effects.revisions.insert(
        format!(
            "value:{}:{membership}:{}",
            address.data_source_id, address.property_id
        ),
        revision,
    );
    effects.revisions.insert(
        format!("page:{}:metadata", address.page_id),
        metadata_revision,
    );
    Ok(())
}

fn update_membership_completion_timestamp(
    connection: &Connection,
    membership_id: &str,
    property_id: &str,
    value: &Value,
    now: &str,
) -> Result<(), StoreError> {
    if property_id != super::property_semantics::STATUS_PROPERTY_ID {
        return Ok(());
    }
    if value.as_str() == Some(super::property_semantics::COMPLETED_STATUS_OPTION_ID) {
        connection.execute(
            "UPDATE data_source_page_memberships \
             SET completed_at = COALESCE(completed_at, ?1) WHERE id = ?2",
            params![now, membership_id],
        )?;
        return Ok(());
    }
    connection.execute(
        "UPDATE data_source_page_memberships SET completed_at = NULL WHERE id = ?1",
        [membership_id],
    )?;
    Ok(())
}

pub(crate) fn synchronize_membership_completion_timestamp(
    connection: &Connection,
    data_source_id: &str,
    membership_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let status = connection
        .query_row(
            "SELECT value_json FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
            params![
                data_source_id,
                membership_id,
                super::property_semantics::STATUS_PROPERTY_ID
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| parse_json(&value, "Workflow status value"))
        .transpose()?
        .unwrap_or(Value::Null);
    update_membership_completion_timestamp(
        connection,
        membership_id,
        super::property_semantics::STATUS_PROPERTY_ID,
        &status,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn add_remove_value(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
    data_source_id: &str,
    property_id: &str,
    add: &[String],
    remove: &[String],
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let property = active_property(connection, data_source_id, property_id)?;
    if property.value_type != "multi_select" {
        return Err(invalid("add_remove_value requires a multi_select Property"));
    }
    let config = option_config(&property)?;
    let known = config
        .options
        .iter()
        .map(|option| option.id.as_str())
        .collect::<HashSet<_>>();
    if add
        .iter()
        .chain(remove)
        .any(|option_id| !known.contains(option_id.as_str()))
    {
        return Err(invalid("add_remove_value references an unknown option"));
    }
    let membership = connection
        .query_row(
            "SELECT id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NULL",
            params![data_source_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page has no active membership in the Data Source"))?;
    let existing = connection
        .query_row(
            "SELECT value_json, revision FROM data_source_property_values \
             WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
            params![data_source_id, membership, property_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let mut selection = match &existing {
        Some((value, _)) => normalize_value(&property, &parse_json(value, "Property value")?)?
            .as_array()
            .cloned()
            .ok_or_else(|| corrupt("Stored multi_select value is not an array"))?
            .into_iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| corrupt("Stored multi_select option is invalid"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?,
        None => BTreeSet::new(),
    };
    let before = selection.clone();
    for option_id in remove {
        selection.remove(option_id);
    }
    selection.extend(add.iter().cloned());
    if selection == before {
        return Ok(());
    }
    set_value(
        connection,
        library_id,
        project_id,
        &DatabasePagePropertyAddress {
            page_id: page_id.to_owned(),
            data_source_id: data_source_id.to_owned(),
            property_id: property_id.to_owned(),
        },
        existing.as_ref().map_or(0, |(_, revision)| *revision),
        &Value::Array(selection.into_iter().map(Value::String).collect()),
        now,
        effects,
        library_scope,
    )
}

struct ActiveMembership {
    id: String,
    data_source_id: String,
    revision: i64,
}

struct CompatibilityValues {
    values: Map<String, Value>,
    revisions: Map<String, Value>,
}

struct PreferredViewPlacement {
    view_id: Option<String>,
    group_key: Option<String>,
    rank_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PageCopyValueDraft {
    pub(crate) property_id: String,
    pub(crate) value: Value,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PageCopyPositionAnchor {
    pub(crate) page_id: String,
    pub(crate) expected_position_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PageCopyViewPlacement {
    pub(crate) view_id: String,
    pub(crate) expected_view_revision: i64,
    pub(crate) group_key: Option<String>,
    pub(crate) before: Option<PageCopyPositionAnchor>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PageCopyDataSourceDestination {
    pub(crate) data_source_id: String,
    pub(crate) expected_data_source_revision: i64,
    pub(crate) values: Vec<PageCopyValueDraft>,
    pub(crate) view: Option<PageCopyViewPlacement>,
}

#[derive(Clone, Debug)]
pub(crate) struct PageTaskShorthandCandidate {
    pub(crate) root_id: String,
    pub(crate) priority: u8,
    pub(crate) estimate: Option<String>,
    pub(crate) tag_names: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PageTaskShorthandRootPlan {
    pub(crate) root_id: String,
    pub(crate) values: Vec<PageCopyValueDraft>,
    pub(crate) priority_option_id: String,
    pub(crate) estimate_option_id: Option<String>,
    pub(crate) tag_option_ids: Vec<String>,
    pub(crate) tag_names: Vec<String>,
    pub(crate) created_tag_option_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PageTaskShorthandBatchPlan {
    pub(crate) roots: Vec<PageTaskShorthandRootPlan>,
    pub(crate) preserved_reasons: BTreeMap<String, PageTaskShorthandPreservedReason>,
    pub(crate) new_tag_options: Vec<super::property_semantics::PropertyOption>,
    pub(crate) expected_tags_property_revision: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum PageTaskShorthandPreservedReason {
    TargetPropertyConflict,
    TargetSchemaIncompatible,
    TagSchemaPermissionRequired,
    TagOptionLimit,
}

pub(crate) struct AppliedPageTaskShorthandSchema {
    pub(crate) source_revision: i64,
    pub(crate) committed_revisions: BTreeMap<String, i64>,
}

pub(crate) fn plan_page_task_shorthand(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    operation_id: &str,
    destination: &PageCopyDataSourceDestination,
    candidates: &[PageTaskShorthandCandidate],
) -> Result<PageTaskShorthandBatchPlan, StoreError> {
    let source = require_source(connection, library_id, &destination.data_source_id)?;
    let priority = active_property(
        connection,
        &source.id,
        super::property_semantics::PRIORITY_PROPERTY_ID,
    )
    .ok();
    let estimate = active_property(connection, &source.id, "estimate").ok();
    let tags = active_property(connection, &source.id, "tags").ok();
    let tags_config = tags
        .as_ref()
        .and_then(|property| option_config(property).ok());
    let can_manage_schema = authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        false,
    )
    .is_ok();

    let mut option_by_name = tags_config
        .as_ref()
        .map(|config| {
            config
                .options
                .iter()
                .map(|option| (option.name.clone(), option.id.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut used_option_ids = tags_config
        .as_ref()
        .map(|config| {
            config
                .options
                .iter()
                .map(|option| option.id.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut new_tag_options = Vec::new();
    let mut roots = Vec::new();
    let mut preserved_reasons = BTreeMap::new();

    for candidate in candidates {
        let Some(priority_property) = priority
            .as_ref()
            .filter(|property| property.value_type == "select")
        else {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
            );
            continue;
        };
        let Some(priority_option_id) =
            super::property_semantics::priority_option_id(candidate.priority)
        else {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
            );
            continue;
        };
        if !option_config(priority_property)?
            .options
            .iter()
            .any(|option| option.id == priority_option_id)
        {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
            );
            continue;
        }
        let estimate_option_id = candidate
            .estimate
            .as_ref()
            .map(|value| value.to_ascii_lowercase());
        if let Some(option_id) = estimate_option_id.as_deref() {
            let Some(property) = estimate
                .as_ref()
                .filter(|property| property.value_type == "select")
            else {
                preserved_reasons.insert(
                    candidate.root_id.clone(),
                    PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
                );
                continue;
            };
            if !super::property_semantics::is_estimate_option_id(option_id)
                || !option_config(property)?
                    .options
                    .iter()
                    .any(|option| option.id == option_id)
            {
                preserved_reasons.insert(
                    candidate.root_id.clone(),
                    PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
                );
                continue;
            }
        }
        if !candidate.tag_names.is_empty()
            && tags
                .as_ref()
                .is_none_or(|property| property.value_type != "multi_select")
        {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetSchemaIncompatible,
            );
            continue;
        }

        let mut values = destination.values.clone();
        if merge_scalar_promotion_value(
            &mut values,
            super::property_semantics::PRIORITY_PROPERTY_ID,
            priority_option_id,
        )
        .is_err()
        {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetPropertyConflict,
            );
            continue;
        }
        if let Some(option_id) = estimate_option_id.as_deref()
            && merge_scalar_promotion_value(&mut values, "estimate", option_id).is_err()
        {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TargetPropertyConflict,
            );
            continue;
        }

        let missing = candidate
            .tag_names
            .iter()
            .filter(|name| !option_by_name.contains_key(*name))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() && !can_manage_schema {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TagSchemaPermissionRequired,
            );
            continue;
        }
        if used_option_ids.len() + missing.len() > super::MAX_PROPERTY_OPTIONS {
            preserved_reasons.insert(
                candidate.root_id.clone(),
                PageTaskShorthandPreservedReason::TagOptionLimit,
            );
            continue;
        }
        let mut created_tag_option_ids = Vec::new();
        for name in missing {
            let option_id =
                allocate_task_tag_option_id(operation_id, &source.id, &name, &used_option_ids);
            used_option_ids.insert(option_id.clone());
            option_by_name.insert(name.clone(), option_id.clone());
            created_tag_option_ids.push(option_id.clone());
            new_tag_options.push(super::property_semantics::PropertyOption {
                id: option_id,
                name,
                color: None,
            });
        }
        let tag_option_ids = candidate
            .tag_names
            .iter()
            .filter_map(|name| option_by_name.get(name).cloned())
            .collect::<Vec<_>>();
        if !tag_option_ids.is_empty() {
            merge_tag_promotion_value(&mut values, &tag_option_ids)?;
        }
        roots.push(PageTaskShorthandRootPlan {
            root_id: candidate.root_id.clone(),
            values,
            priority_option_id: priority_option_id.to_owned(),
            estimate_option_id,
            tag_option_ids,
            tag_names: candidate.tag_names.clone(),
            created_tag_option_ids,
        });
    }

    Ok(PageTaskShorthandBatchPlan {
        roots,
        preserved_reasons,
        expected_tags_property_revision: tags
            .as_ref()
            .map(|property| property.revision)
            .filter(|_| !new_tag_options.is_empty()),
        new_tag_options,
    })
}

pub(crate) fn apply_page_task_shorthand_schema(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    options: &[super::property_semantics::PropertyOption],
    expected_property_revision: Option<i64>,
    now: &str,
) -> Result<AppliedPageTaskShorthandSchema, StoreError> {
    let mut effects = MutationEffects::default();
    for (revision, option) in (expected_property_revision.unwrap_or(0)..).zip(options) {
        put_option(
            connection,
            library_id,
            project_id,
            data_source_id,
            "tags",
            &option.id,
            &option.name,
            option.color.as_deref(),
            revision,
            now,
            &mut effects,
            false,
        )?;
    }
    let source_revision = require_source(connection, library_id, data_source_id)?.revision;
    Ok(AppliedPageTaskShorthandSchema {
        source_revision,
        committed_revisions: effects.revisions,
    })
}

fn merge_scalar_promotion_value(
    values: &mut Vec<PageCopyValueDraft>,
    property_id: &str,
    option_id: &str,
) -> Result<(), ()> {
    if let Some(existing) = values.iter().find(|value| value.property_id == property_id) {
        return if existing.value == Value::String(option_id.to_owned()) {
            Ok(())
        } else {
            Err(())
        };
    }
    values.push(PageCopyValueDraft {
        property_id: property_id.to_owned(),
        value: Value::String(option_id.to_owned()),
    });
    Ok(())
}

fn merge_tag_promotion_value(
    values: &mut Vec<PageCopyValueDraft>,
    option_ids: &[String],
) -> Result<(), StoreError> {
    let existing = values.iter_mut().find(|value| value.property_id == "tags");
    let Some(existing) = existing else {
        values.push(PageCopyValueDraft {
            property_id: "tags".to_owned(),
            value: Value::Array(option_ids.iter().cloned().map(Value::String).collect()),
        });
        return Ok(());
    };
    let Some(array) = existing.value.as_array_mut() else {
        return Err(invalid("Tags group value is not a multi-select set"));
    };
    let mut seen = array
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    for option_id in option_ids {
        if seen.insert(option_id.clone()) {
            array.push(Value::String(option_id.clone()));
        }
    }
    Ok(())
}

fn allocate_task_tag_option_id(
    operation_id: &str,
    data_source_id: &str,
    name: &str,
    used: &BTreeSet<String>,
) -> String {
    for ordinal in 0_u32.. {
        let seed = format!("{data_source_id}:{name}:{ordinal}");
        let uuid = stable_uuid_v7(operation_id, "task_shorthand_tag", &seed);
        let compact = uuid
            .chars()
            .filter(|ch| *ch != '-')
            .take(8)
            .collect::<String>();
        let candidate = format!("o_{compact}");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("compact option identity space exhausted")
}

pub(crate) struct PageCopyDataSourcePlacement {
    pub(crate) database_id: String,
    pub(crate) data_source_id: String,
    pub(crate) membership_id: String,
    pub(crate) membership_revision: i64,
    pub(crate) affected_view_ids: Vec<String>,
    pub(crate) location_revision: i64,
    pub(crate) metadata_revision: i64,
    pub(crate) parent_revision: i64,
    pub(crate) value_revisions: BTreeMap<String, i64>,
    pub(crate) position_revision: Option<i64>,
}

#[derive(Clone, Copy)]
pub(crate) struct StagedPagePlacementRevisions {
    pub(crate) location_revision: i64,
    pub(crate) metadata_revision: i64,
    pub(crate) parent_revision: i64,
}

pub(crate) enum ExistingPageTransferTarget<'a> {
    Library,
    Page { page_id: &'a str },
    DataSource(&'a PageCopyDataSourceDestination),
}

pub(crate) struct ExistingPageTransferPlacement {
    pub(crate) database_id: Option<String>,
    pub(crate) data_source_id: Option<String>,
    pub(crate) membership_id: Option<String>,
    pub(crate) affected_database_ids: Vec<String>,
    pub(crate) affected_view_ids: Vec<String>,
    pub(crate) committed_revisions: BTreeMap<String, i64>,
    pub(crate) location_revision: i64,
    pub(crate) metadata_revision: i64,
    pub(crate) parent_revision: i64,
}

pub(crate) struct AgentMoveDataSourceFinalization {
    pub(crate) affected_database_ids: Vec<String>,
    pub(crate) affected_view_ids: Vec<String>,
    pub(crate) committed_revisions: BTreeMap<String, i64>,
}

pub(crate) fn validate_page_transfer_data_source_source(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        requesting_project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        false,
    )?;
    Ok(())
}

pub(crate) fn validate_page_transfer_data_source_source_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
) -> Result<(), StoreError> {
    require_source(connection, library_id, data_source_id)?;
    crate::library::require_project_in_library(connection, requesting_project_id, library_id)?;
    Ok(())
}

pub(crate) fn validate_page_copy_data_source_source(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    let primary = project_primary_database(connection, library_id, requesting_project_id)?;
    authorize_required(
        connection,
        Some(requesting_project_id),
        primary.as_deref(),
        &source.database_id,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_page_transfer_data_source_destination(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    view_id: &str,
    group_key: Option<&str>,
    before_page_id: Option<&str>,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    resolve_page_transfer_data_source_destination_with_access(
        connection,
        library_id,
        requesting_project_id,
        data_source_id,
        view_id,
        group_key,
        before_page_id,
        true,
        TransferGroupAxis::Durable,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_page_transfer_board_destination(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    group_key: Option<&str>,
    before_page_id: Option<&str>,
    sorted_property_values: &[PageCopyValueDraft],
) -> Result<PageCopyDataSourceDestination, StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        requesting_project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        false,
    )?;
    crate::library::require_project_in_library(connection, requesting_project_id, library_id)?;
    let drop_presentation = super::window::direct_drop_presentation(
        connection,
        library_id,
        view_id,
        preferences_override,
    )?;
    if sorted_property_values.len() > drop_presentation.writable_sort_property_ids.len()
        || sorted_property_values
            .iter()
            .zip(&drop_presentation.writable_sort_property_ids)
            .any(|(value, property_id)| value.property_id != *property_id)
    {
        return Err(invalid(
            "Block transfer inferred Properties must match the presented Board sort prefix",
        ));
    }
    let mut destination = resolve_page_transfer_data_source_destination_with_access(
        connection,
        library_id,
        requesting_project_id,
        data_source_id,
        view_id,
        group_key,
        before_page_id,
        false,
        TransferGroupAxis::Effective(drop_presentation.group_property_id.as_deref()),
    )?;
    for value in sorted_property_values {
        if destination
            .values
            .iter()
            .any(|candidate| candidate.property_id == value.property_id)
        {
            return Err(invalid(
                "Block transfer inferred the same Property as a presented Board axis",
            ));
        }
        destination.values.push(value.clone());
    }
    Ok(destination)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_page_transfer_data_source_destination_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    view_id: &str,
    group_key: Option<&str>,
    before_page_id: Option<&str>,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    resolve_page_transfer_data_source_destination_with_access(
        connection,
        library_id,
        requesting_project_id,
        data_source_id,
        view_id,
        group_key,
        before_page_id,
        false,
        TransferGroupAxis::Durable,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_page_transfer_list_destination(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    expected_projection: &DatabaseListProjectionExpectation,
    target: &DatabaseListMoveTarget,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        requesting_project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        false,
    )?;
    crate::library::require_project_in_library(connection, requesting_project_id, library_id)?;
    let projection = super::window::presented_list_projection(
        connection,
        library_id,
        view_id,
        preferences_override,
        &read_store_epoch(connection)?,
        Some(requesting_project_id),
    )?;
    if projection.graph.database_id != source.database_id
        || projection.graph.data_source_id != source.id
    {
        return Err(invalid(
            "Block transfer List target belongs to another Data Source",
        ));
    }
    let normalized =
        super::list_drag::resolve_list_insertion_target(&projection, expected_projection, target)?;
    if normalized.parent_page_id.is_some() || normalized.depth > 0 {
        return Err(invalid(
            "Block promotion cannot create a nested List Page without an explicit nesting action",
        ));
    }
    let view = view_row(connection, view_id)?
        .filter(|view| view.lifecycle == "active")
        .ok_or_else(|| not_found("Block transfer target View is unavailable"))?;
    if view.database_id != source.database_id || view.data_source_id != source.id {
        return Err(invalid(
            "Block transfer target View belongs to another Data Source",
        ));
    }
    let axes = [
        (
            projection
                .graph
                .presentation
                .group
                .as_ref()
                .map(|group| group.property_id.as_str()),
            normalized.group_key.as_deref(),
        ),
        (
            projection
                .graph
                .presentation
                .subgroup
                .as_ref()
                .map(|group| group.property_id.as_str()),
            normalized.subgroup_key.as_deref(),
        ),
    ];
    let mut seen_property_ids = HashSet::new();
    let mut values = axes
        .into_iter()
        .filter_map(|(property_id, key)| property_id.map(|property_id| (property_id, key)))
        .map(|(property_id, key)| {
            if !seen_property_ids.insert(property_id.to_owned()) {
                return Err(invalid(
                    "A List cannot group and subgroup by the same Property",
                ));
            }
            let property = active_property(connection, data_source_id, property_id)?;
            Ok(PageCopyValueDraft {
                property_id: property_id.to_owned(),
                value: database_group_value_from_key(&property.value_type, key),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let ignored_page_ids = HashSet::new();
    for (property_id, value) in super::list_drag::inferred_list_drop_sort_values(
        connection,
        &projection.graph,
        &normalized,
        &ignored_page_ids,
    )? {
        if !seen_property_ids.insert(property_id.clone()) {
            continue;
        }
        values.push(PageCopyValueDraft { property_id, value });
    }
    let fractional_order =
        super::view_contract::fractional_order_direction(&projection.graph.sorts).is_some();
    let before = if fractional_order {
        normalized
            .before_page_id
            .as_deref()
            .map(|page_id| page_copy_position_anchor(connection, view_id, data_source_id, page_id))
            .transpose()?
    } else {
        None
    };
    Ok(PageCopyDataSourceDestination {
        data_source_id: source.id,
        expected_data_source_revision: source.revision,
        values,
        view: Some(PageCopyViewPlacement {
            view_id: view.id,
            expected_view_revision: view.revision,
            group_key: normalized.group_key,
            before,
        }),
    })
}

fn page_copy_position_anchor(
    connection: &Connection,
    view_id: &str,
    data_source_id: &str,
    page_id: &str,
) -> Result<PageCopyPositionAnchor, StoreError> {
    let expected_position_revision = connection
        .query_row(
            &format!(
                "SELECT COALESCE({}, 0) \
             FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             {} \
             WHERE membership.data_source_id = ?2 \
               AND membership.page_block_id = ?3 AND membership.removed_at IS NULL \
               AND page.parent_kind = 'data_source' AND page.parent_id = ?2 \
               AND block.lifecycle = 'active'",
                super::POSITION_REVISION,
                super::view_position_joins("?1", "page.block_id")
            ),
            params![view_id, data_source_id, page_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Block transfer View anchor is unavailable"))?;
    Ok(PageCopyPositionAnchor {
        page_id: page_id.to_owned(),
        expected_position_revision,
    })
}

#[allow(clippy::too_many_arguments)]
fn resolve_page_transfer_data_source_destination_with_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    view_id: &str,
    group_key: Option<&str>,
    before_page_id: Option<&str>,
    require_access: bool,
    group_axis: TransferGroupAxis<'_>,
) -> Result<PageCopyDataSourceDestination, StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    if require_access {
        authorize_write(
            connection,
            requesting_project_id,
            &source.database_id,
            DatabaseWriteAction::Write,
            false,
        )?;
    }
    crate::library::require_project_in_library(connection, requesting_project_id, library_id)?;
    let view = view_row(connection, view_id)?
        .filter(|view| view.lifecycle == "active")
        .ok_or_else(|| not_found("Block transfer target View is unavailable"))?;
    if view.database_id != source.database_id || view.data_source_id != source.id {
        return Err(invalid(
            "Block transfer target View belongs to another Data Source",
        ));
    }
    let definition =
        super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)?;
    let group_property_id = match group_axis {
        TransferGroupAxis::Durable => view_group_property(&definition),
        TransferGroupAxis::Effective(property_id) => property_id,
    };
    let values = group_property_id
        .map(|property_id| {
            let property = active_property(connection, data_source_id, property_id)?;
            Ok::<_, StoreError>(PageCopyValueDraft {
                property_id: property_id.to_owned(),
                value: database_group_value_from_key(&property.value_type, group_key),
            })
        })
        .transpose()?
        .into_iter()
        .collect();
    let before = before_page_id
        .map(|page_id| page_copy_position_anchor(connection, view_id, data_source_id, page_id))
        .transpose()?;
    Ok(PageCopyDataSourceDestination {
        data_source_id: source.id,
        expected_data_source_revision: source.revision,
        values,
        view: Some(PageCopyViewPlacement {
            view_id: view.id,
            expected_view_revision: view.revision,
            group_key: group_key.map(str::to_owned),
            before,
        }),
    })
}

enum TransferGroupAxis<'a> {
    Durable,
    Effective(Option<&'a str>),
}

pub(crate) fn validate_page_copy_data_source_destination(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    expected_data_source_revision: i64,
) -> Result<(), StoreError> {
    validate_page_copy_data_source_destination_with_access(
        connection,
        library_id,
        requesting_project_id,
        data_source_id,
        expected_data_source_revision,
        true,
    )
}

pub(crate) fn validate_page_copy_data_source_destination_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    expected_data_source_revision: i64,
) -> Result<(), StoreError> {
    validate_page_copy_data_source_destination_with_access(
        connection,
        library_id,
        requesting_project_id,
        data_source_id,
        expected_data_source_revision,
        false,
    )
}

fn validate_page_copy_data_source_destination_with_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    data_source_id: &str,
    expected_data_source_revision: i64,
    require_access: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    require_revision(
        expected_data_source_revision,
        source.revision,
        "Target Data Source revision changed",
    )?;
    if require_access {
        authorize_write(
            connection,
            requesting_project_id,
            &source.database_id,
            DatabaseWriteAction::Write,
            false,
        )?;
    }
    let database_is_active = connection
        .query_row(
            "SELECT 1 FROM blocks WHERE id = ?1 AND library_id = ?2 \
             AND type = 'database' AND lifecycle = 'active'",
            params![source.database_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !database_is_active {
        return Err(corrupt(
            "Target Data Source has no active Database authority",
        ));
    }
    crate::library::require_project_in_library(connection, requesting_project_id, library_id)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn place_copied_page_in_data_source(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    source_page_id: &str,
    copied_page_id: &str,
    destination: &PageCopyDataSourceDestination,
    now: &str,
) -> Result<PageCopyDataSourcePlacement, StoreError> {
    place_staged_page_in_data_source_with_access(
        connection,
        library_id,
        requesting_project_id,
        Some(source_page_id),
        copied_page_id,
        destination,
        StagedPagePlacementRevisions {
            location_revision: 1,
            metadata_revision: 1,
            parent_revision: 1,
        },
        now,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn place_copied_page_in_data_source_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    source_page_id: &str,
    copied_page_id: &str,
    destination: &PageCopyDataSourceDestination,
    now: &str,
) -> Result<PageCopyDataSourcePlacement, StoreError> {
    place_staged_page_in_data_source_with_access(
        connection,
        library_id,
        requesting_project_id,
        Some(source_page_id),
        copied_page_id,
        destination,
        StagedPagePlacementRevisions {
            location_revision: 1,
            metadata_revision: 1,
            parent_revision: 1,
        },
        now,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn place_staged_page_in_data_source(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    source_page_id: Option<&str>,
    staged_page_id: &str,
    destination: &PageCopyDataSourceDestination,
    expected: StagedPagePlacementRevisions,
    now: &str,
) -> Result<PageCopyDataSourcePlacement, StoreError> {
    place_staged_page_in_data_source_with_access(
        connection,
        library_id,
        requesting_project_id,
        source_page_id,
        staged_page_id,
        destination,
        expected,
        now,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn place_staged_page_in_data_source_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    staged_page_id: &str,
    destination: &PageCopyDataSourceDestination,
    expected: StagedPagePlacementRevisions,
    now: &str,
) -> Result<PageCopyDataSourcePlacement, StoreError> {
    place_staged_page_in_data_source_with_access(
        connection,
        library_id,
        requesting_project_id,
        None,
        staged_page_id,
        destination,
        expected,
        now,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn place_staged_page_in_data_source_with_access(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    source_page_id: Option<&str>,
    staged_page_id: &str,
    destination: &PageCopyDataSourceDestination,
    expected: StagedPagePlacementRevisions,
    now: &str,
    require_access: bool,
) -> Result<PageCopyDataSourcePlacement, StoreError> {
    if destination.values.len() > 512 {
        return Err(invalid("Data Source placement values exceed their bound"));
    }
    let property_ids = destination
        .values
        .iter()
        .map(|value| value.property_id.as_str())
        .collect::<HashSet<_>>();
    if property_ids.len() != destination.values.len() {
        return Err(invalid(
            "Data Source placement Property values must be unique",
        ));
    }
    let source = require_source(connection, library_id, &destination.data_source_id)?;
    require_revision(
        destination.expected_data_source_revision,
        source.revision,
        "Target Data Source revision changed",
    )?;
    if require_access {
        authorize_write(
            connection,
            requesting_project_id,
            &source.database_id,
            DatabaseWriteAction::Write,
            false,
        )?;
    }
    let staged = connection
        .query_row(
            "SELECT block.library_id, block.placement_revision, block.metadata_revision, \
               page.parent_kind, page.parent_id, \
               EXISTS(SELECT 1 FROM library_block_placements placement \
                 WHERE placement.block_id = block.id AND placement.library_id = block.library_id) \
             FROM blocks block JOIN pages page \
               ON page.block_id = block.id AND page.library_id = block.library_id \
             WHERE block.id = ?1 AND block.type = 'page' AND block.lifecycle = 'active'",
            [staged_page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Staged Page authority disappeared"))?;
    if staged.0 != library_id
        || staged.1 != expected.location_revision
        || staged.1 != expected.parent_revision
        || staged.2 != expected.metadata_revision
        || staged.3 != "library"
        || staged.4 != library_id
        || !staged.5
    {
        return Err(corrupt("Staged Page has noncanonical initial placement"));
    }
    let source_membership = source_page_id
        .map(|source_page_id| {
            connection
                .query_row(
                    "SELECT id, data_source_id, revision FROM data_source_page_memberships \
                     WHERE page_block_id = ?1 AND removed_at IS NULL",
                    [source_page_id],
                    |row| {
                        Ok(ActiveMembership {
                            id: row.get(0)?,
                            data_source_id: row.get(1)?,
                            revision: row.get(2)?,
                        })
                    },
                )
                .optional()
        })
        .transpose()?
        .flatten();
    // A demoted Block may be promoted again as a new command. Its retired
    // membership still names the same Data Source/Page pair, just as on re-entry.
    let retired_membership = connection
        .query_row(
            "SELECT id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NOT NULL",
            params![destination.data_source_id, staged_page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let membership_id = retired_membership.clone().unwrap_or_else(|| {
        deterministic_membership_id(&destination.data_source_id, staged_page_id)
    });
    if retired_membership.is_none()
        && connection
            .query_row(
                "SELECT 1 FROM data_source_page_memberships WHERE id = ?1 \
             OR (data_source_id = ?2 AND page_block_id = ?3)",
                params![membership_id, destination.data_source_id, staged_page_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::AlreadyOwned,
            "Staged Page membership identity is already owned",
            false,
        ));
    }

    let view = destination
        .view
        .as_ref()
        .map(|placement| {
            let view = view_row(connection, &placement.view_id)?
                .filter(|view| view.lifecycle == "active")
                .ok_or_else(|| not_found("Page copy target View is unavailable"))?;
            if view.database_id != source.database_id
                || view.data_source_id != destination.data_source_id
            {
                return Err(invalid(
                    "Page copy target View belongs to another Data Source",
                ));
            }
            require_revision(
                placement.expected_view_revision,
                view.revision,
                "Page copy target View revision changed",
            )?;
            if let Some(anchor) = &placement.before {
                let anchor_revision = connection
                    .query_row(
                        &format!(
                            "SELECT COALESCE({}, 0) \
                         FROM data_source_page_memberships membership \
                         JOIN pages page ON page.block_id = membership.page_block_id \
                         JOIN blocks block ON block.id = page.block_id \
                           AND block.library_id = page.library_id \
                         {} \
                         WHERE membership.data_source_id = ?2 \
                           AND membership.page_block_id = ?3 AND membership.removed_at IS NULL \
                           AND page.parent_kind = 'data_source' AND page.parent_id = ?2 \
                           AND block.lifecycle = 'active'",
                            super::POSITION_REVISION,
                            super::view_position_joins("?1", "page.block_id")
                        ),
                        params![
                            placement.view_id,
                            destination.data_source_id,
                            anchor.page_id
                        ],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .ok_or_else(|| not_found("Page copy View anchor is unavailable"))?;
                require_revision(
                    anchor.expected_position_revision,
                    anchor_revision,
                    "Page copy View anchor changed",
                )?;
            }
            Ok(view)
        })
        .transpose()?;

    connection.execute(
        "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
        params![staged_page_id, library_id],
    )?;
    let location_revision = connection
        .query_row(
            "UPDATE blocks SET placement_revision = placement_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND library_id = ?3 AND placement_revision = ?4 \
               AND metadata_revision = ?5 RETURNING placement_revision",
            params![
                now,
                staged_page_id,
                library_id,
                expected.location_revision,
                expected.metadata_revision,
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::RevisionConflict,
                "Staged Page location changed during placement",
                true,
            )
        })?;
    let changed = connection.execute(
        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1, updated_at = ?2 \
         WHERE block_id = ?3 AND library_id = ?4",
        params![destination.data_source_id, now, staged_page_id, library_id,],
    )?;
    if changed != 1 {
        return Err(corrupt("Staged Page lost its typed parent authority"));
    }
    connection.execute(
        "INSERT INTO data_source_page_memberships( \
           id, data_source_id, page_block_id, revision, created_at, removed_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, NULL) \
         ON CONFLICT(id) DO UPDATE SET removed_at = NULL, revision = revision + 1",
        params![
            membership_id,
            destination.data_source_id,
            staged_page_id,
            now
        ],
    )?;
    ensure_database_page_key(
        connection,
        library_id,
        &source.database_id,
        staged_page_id,
        now,
    )?;
    ensure_transferred_built_in_values(
        connection,
        source_membership.as_ref(),
        &membership_id,
        &destination.data_source_id,
        now,
        None,
    )?;
    if let Some(source_membership) = source_membership
        .as_ref()
        .filter(|membership| membership.data_source_id == destination.data_source_id)
    {
        copy_same_source_property_values(connection, source_membership, &membership_id, now)?;
    }
    synchronize_membership_completion_timestamp(
        connection,
        &destination.data_source_id,
        &membership_id,
        now,
    )?;
    let parent_revision = location_revision;
    refresh_transferred_page_projection(
        connection,
        staged_page_id,
        Some(&membership_id),
        Some(&destination.data_source_id),
        now,
    )?;

    let mut effects = MutationEffects::default();
    for value in &destination.values {
        let expected_value_revision = connection
            .query_row(
                "SELECT revision FROM data_source_property_values \
                 WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
                params![destination.data_source_id, membership_id, value.property_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        set_value(
            connection,
            library_id,
            requesting_project_id,
            &DatabasePagePropertyAddress {
                page_id: staged_page_id.to_owned(),
                data_source_id: destination.data_source_id.clone(),
                property_id: value.property_id.clone(),
            },
            expected_value_revision,
            &value.value,
            now,
            &mut effects,
            false,
        )?;
    }
    if let (Some(placement), Some(_)) = (&destination.view, view) {
        let expected_position_revision = connection.query_row(
            "SELECT revision FROM database_view_page_positions WHERE view_id = ?1 AND page_block_id = ?2",
            params![placement.view_id, staged_page_id],
            |row| row.get::<_, i64>(0),
        ).optional()?.unwrap_or(0);
        position_pages(
            connection,
            library_id,
            requesting_project_id,
            &placement.view_id,
            &[DatabasePagePosition {
                page_id: staged_page_id.to_owned(),
                expected_position_revision,
            }],
            placement
                .before
                .as_ref()
                .map(|anchor| anchor.page_id.as_str()),
            now,
            &mut effects,
            false,
        )?;
    }
    effects.database_ids.insert(source.database_id.clone());
    effects.data_source_ids.insert(source.id.clone());
    effects.page_ids.insert(staged_page_id.to_owned());
    refresh_scheduled_page_indexes(connection, &effects.page_ids, now)?;
    let metadata_revision = connection.query_row(
        "SELECT metadata_revision FROM blocks WHERE id = ?1",
        [staged_page_id],
        |row| row.get::<_, i64>(0),
    )?;
    let value_revisions = destination
        .values
        .iter()
        .map(|value| {
            let revision = connection.query_row(
                "SELECT revision FROM data_source_property_values \
                 WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
                params![destination.data_source_id, membership_id, value.property_id],
                |row| row.get::<_, i64>(0),
            )?;
            Ok((value.property_id.clone(), revision))
        })
        .collect::<Result<BTreeMap<_, _>, rusqlite::Error>>()?;
    let position_revision = destination
        .view
        .as_ref()
        .map(|placement| {
            connection.query_row(
                "SELECT revision FROM database_view_page_positions \
                 WHERE view_id = ?1 AND page_block_id = ?2",
                params![placement.view_id, staged_page_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .transpose()?;
    Ok(PageCopyDataSourcePlacement {
        database_id: source.database_id,
        data_source_id: source.id,
        membership_revision: connection.query_row(
            "SELECT revision FROM data_source_page_memberships WHERE id = ?1",
            [&membership_id],
            |row| row.get(0),
        )?,
        membership_id,
        affected_view_ids: effects.view_ids.into_iter().collect(),
        location_revision,
        metadata_revision,
        parent_revision,
        value_revisions,
        position_revision,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn transfer_existing_page_for_block_transfer(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    page_id: &str,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    target: ExistingPageTransferTarget<'_>,
    now: &str,
) -> Result<ExistingPageTransferPlacement, StoreError> {
    transfer_existing_page_for_structural_move(
        connection,
        library_id,
        requesting_project_id,
        page_id,
        expected_parent_revision,
        expected_active_membership_revision,
        target,
        now,
        false,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn transfer_existing_page_for_agent_move_prevalidated(
    connection: &Connection,
    library_id: &str,
    actor_project_id: &str,
    page_id: &str,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    target: ExistingPageTransferTarget<'_>,
    now: &str,
    defer_projection_refresh: bool,
) -> Result<ExistingPageTransferPlacement, StoreError> {
    transfer_existing_page_for_structural_move(
        connection,
        library_id,
        actor_project_id,
        page_id,
        expected_parent_revision,
        expected_active_membership_revision,
        target,
        now,
        true,
        defer_projection_refresh,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_existing_page_for_structural_move(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    page_id: &str,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    target: ExistingPageTransferTarget<'_>,
    now: &str,
    preauthorized_library_scope: bool,
    defer_projection_refresh: bool,
) -> Result<ExistingPageTransferPlacement, StoreError> {
    let mut effects = MutationEffects::default();
    let same_data_source = match &target {
        ExistingPageTransferTarget::DataSource(destination) => connection
            .query_row(
                "SELECT membership.data_source_id = ?2 \
                 FROM data_source_page_memberships membership \
                 WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL",
                params![page_id, destination.data_source_id],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false),
        ExistingPageTransferTarget::Library | ExistingPageTransferTarget::Page { .. } => false,
    };
    let database_target = match &target {
        ExistingPageTransferTarget::Library => DatabaseTransferTarget::Library {
            library_id: library_id.to_owned(),
        },
        ExistingPageTransferTarget::Page { page_id } => DatabaseTransferTarget::Page {
            page_id: (*page_id).to_owned(),
        },
        ExistingPageTransferTarget::DataSource(destination) => DatabaseTransferTarget::DataSource {
            data_source_id: destination.data_source_id.clone(),
        },
    };
    if same_data_source {
        let (parent_kind, parent_id, parent_revision, membership_revision) = connection
            .query_row(
                "SELECT page.parent_kind, page.parent_id, block.placement_revision, \
                   membership.revision \
                 FROM pages page \
                 JOIN blocks block ON block.id = page.block_id \
                   AND block.library_id = page.library_id AND block.lifecycle = 'active' \
                 JOIN data_source_page_memberships membership \
                   ON membership.page_block_id = page.block_id \
                   AND membership.removed_at IS NULL \
                 WHERE page.block_id = ?1 AND page.library_id = ?2",
                params![page_id, library_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| not_found("Page is unavailable"))?;
        let DatabaseTransferTarget::DataSource { data_source_id } = &database_target else {
            return Err(corrupt("Same-Data-Source move lost its target"));
        };
        if parent_kind != "data_source" || parent_id != *data_source_id {
            return Err(corrupt(
                "Same-Data-Source Page has inconsistent parent authority",
            ));
        }
        require_revision(
            expected_parent_revision,
            parent_revision,
            "Page parent revision changed",
        )?;
        require_revision(
            expected_active_membership_revision,
            membership_revision,
            "Page active membership revision changed",
        )?;
    } else {
        transfer_page(
            connection,
            library_id,
            requesting_project_id,
            page_id,
            expected_parent_revision,
            expected_active_membership_revision,
            &database_target,
            now,
            &mut effects,
            preauthorized_library_scope,
            true,
            defer_projection_refresh,
        )?;
    }
    if let ExistingPageTransferTarget::DataSource(destination) = target {
        for value in &destination.values {
            let expected_value_revision = connection
                .query_row(
                    "SELECT property_value.revision \
                     FROM data_source_property_values property_value \
                     JOIN data_source_page_memberships membership \
                       ON membership.id = property_value.membership_id \
                     WHERE membership.page_block_id = ?1 \
                       AND membership.data_source_id = ?2 \
                       AND membership.removed_at IS NULL \
                       AND property_value.property_id = ?3",
                    params![page_id, destination.data_source_id, value.property_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            set_value(
                connection,
                library_id,
                requesting_project_id,
                &DatabasePagePropertyAddress {
                    page_id: page_id.to_owned(),
                    data_source_id: destination.data_source_id.clone(),
                    property_id: value.property_id.clone(),
                },
                expected_value_revision,
                &value.value,
                now,
                &mut effects,
                preauthorized_library_scope,
            )?;
        }
        if let Some(view) = &destination.view {
            let expected_position_revision = connection
                .query_row(
                    "SELECT revision FROM database_view_page_positions \
                     WHERE view_id = ?1 AND page_block_id = ?2",
                    params![view.view_id, page_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            position_pages(
                connection,
                library_id,
                requesting_project_id,
                &view.view_id,
                &[DatabasePagePosition {
                    page_id: page_id.to_owned(),
                    expected_position_revision,
                }],
                view.before.as_ref().map(|anchor| anchor.page_id.as_str()),
                now,
                &mut effects,
                preauthorized_library_scope,
            )?;
        }
    }
    let (location_revision, metadata_revision, parent_revision, database_id) = connection
        .query_row(
            "SELECT block.placement_revision, block.metadata_revision, \
               block.placement_revision, source.home_database_block_id \
             FROM blocks block \
             JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id \
             LEFT JOIN data_source_page_memberships membership \
               ON membership.page_block_id = page.block_id AND membership.removed_at IS NULL \
             LEFT JOIN data_sources source ON source.id = membership.data_source_id \
             WHERE block.id = ?1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
    let membership = connection
        .query_row(
            "SELECT id, data_source_id, revision FROM data_source_page_memberships \
             WHERE page_block_id = ?1 AND removed_at IS NULL",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    refresh_scheduled_page_indexes(connection, &effects.page_ids, now)?;
    effects
        .revisions
        .insert(format!("blockLocation:{page_id}"), location_revision);
    effects
        .revisions
        .insert(format!("blockMetadata:{page_id}"), metadata_revision);
    Ok(ExistingPageTransferPlacement {
        database_id,
        data_source_id: membership
            .as_ref()
            .map(|(_, data_source_id, _)| data_source_id.clone()),
        membership_id: membership.as_ref().map(|(id, _, _)| id.clone()),
        affected_database_ids: effects.database_ids.into_iter().collect(),
        affected_view_ids: effects.view_ids.into_iter().collect(),
        committed_revisions: effects.revisions,
        location_revision,
        metadata_revision,
        parent_revision,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn finalize_agent_moved_pages_in_data_source_prevalidated(
    connection: &Connection,
    library_id: &str,
    requesting_project_id: &str,
    page_ids: &[String],
    destination: &PageCopyDataSourceDestination,
    now: &str,
) -> Result<AgentMoveDataSourceFinalization, StoreError> {
    if page_ids.is_empty() || page_ids.len() > MAX_BULK_VALUES {
        return Err(invalid(format!(
            "Agent Page movement requires between 1 and {MAX_BULK_VALUES} Pages"
        )));
    }
    let mut effects = MutationEffects::default();
    for page_id in page_ids {
        active_row_membership(connection, &destination.data_source_id, page_id)?;
        for value in &destination.values {
            let expected_value_revision = connection
                .query_row(
                    "SELECT property_value.revision \
                     FROM data_source_property_values property_value \
                     JOIN data_source_page_memberships membership \
                       ON membership.id = property_value.membership_id \
                     WHERE membership.page_block_id = ?1 \
                       AND membership.data_source_id = ?2 \
                       AND membership.removed_at IS NULL \
                       AND property_value.property_id = ?3",
                    params![page_id, destination.data_source_id, value.property_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            set_value(
                connection,
                library_id,
                requesting_project_id,
                &DatabasePagePropertyAddress {
                    page_id: page_id.clone(),
                    data_source_id: destination.data_source_id.clone(),
                    property_id: value.property_id.clone(),
                },
                expected_value_revision,
                &value.value,
                now,
                &mut effects,
                true,
            )?;
        }
    }
    if let Some(placement) = &destination.view {
        let view = view_row(connection, &placement.view_id)?
            .filter(|view| view.lifecycle == "active")
            .ok_or_else(|| not_found("Agent Page-move target View is unavailable"))?;
        if view.data_source_id != destination.data_source_id {
            return Err(invalid(
                "Agent Page-move target View belongs to another Data Source",
            ));
        }
        let definition =
            super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)?;
        if let Some(property_id) = view_group_property(&definition) {
            let property = active_property(connection, &destination.data_source_id, property_id)?;
            let value =
                database_group_value_from_key(&property.value_type, placement.group_key.as_deref());
            for page_id in page_ids {
                let expected_value_revision = connection
                    .query_row(
                        "SELECT property_value.revision \
                         FROM data_source_property_values property_value \
                         JOIN data_source_page_memberships membership \
                           ON membership.id = property_value.membership_id \
                         WHERE membership.page_block_id = ?1 \
                           AND membership.data_source_id = ?2 \
                           AND membership.removed_at IS NULL \
                           AND property_value.property_id = ?3",
                        params![page_id, destination.data_source_id, property_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                set_value(
                    connection,
                    library_id,
                    requesting_project_id,
                    &DatabasePagePropertyAddress {
                        page_id: page_id.clone(),
                        data_source_id: destination.data_source_id.clone(),
                        property_id: property_id.to_owned(),
                    },
                    expected_value_revision,
                    &value,
                    now,
                    &mut effects,
                    true,
                )?;
            }
        }
        let pages = page_ids
            .iter()
            .map(|page_id| {
                let expected_position_revision = connection
                    .query_row(
                        "SELECT revision FROM database_view_page_positions \
                         WHERE view_id = ?1 AND page_block_id = ?2",
                        params![placement.view_id, page_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                Ok(DatabasePagePosition {
                    page_id: page_id.clone(),
                    expected_position_revision,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        position_pages(
            connection,
            library_id,
            requesting_project_id,
            &placement.view_id,
            &pages,
            placement
                .before
                .as_ref()
                .map(|anchor| anchor.page_id.as_str()),
            now,
            &mut effects,
            true,
        )?;
    }
    refresh_scheduled_page_indexes(connection, &effects.page_ids, now)?;
    Ok(AgentMoveDataSourceFinalization {
        affected_database_ids: effects.database_ids.into_iter().collect(),
        affected_view_ids: effects.view_ids.into_iter().collect(),
        committed_revisions: effects.revisions,
    })
}

fn database_group_value_from_key(value_type: &str, group_key: Option<&str>) -> Value {
    let Some(group_key) = group_key else {
        return Value::Null;
    };
    match value_type {
        "number" | "checkbox" => {
            serde_json::from_str(group_key).unwrap_or_else(|_| Value::String(group_key.to_owned()))
        }
        "multi_select" => match serde_json::from_str(group_key) {
            Ok(Value::Array(values)) => Value::Array(values),
            _ => Value::Array(vec![Value::String(group_key.to_owned())]),
        },
        _ => Value::String(group_key.to_owned()),
    }
}

#[allow(clippy::too_many_arguments)]
fn transfer_page(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    page_id: &str,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    target: &DatabaseTransferTarget,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
    allow_page_parent_transition: bool,
    defer_projection_refresh: bool,
) -> Result<(), StoreError> {
    validate_id(page_id, "page_id", MAX_ID_LENGTH)?;
    let page = connection
        .query_row(
            "SELECT page.library_id, page.parent_kind, page.parent_id, \
               block.placement_revision \
             FROM pages page JOIN blocks block \
               ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND block.lifecycle <> 'deleted'",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Page is unavailable"))?;
    let (page_library_id, parent_kind, _, parent_revision) = page;
    if page_library_id != library_id {
        return Err(unauthorized("Page belongs to another Library"));
    }
    crate::library::require_project_in_library(connection, project_id, library_id)?;
    if !library_scope {
        crate::library::require_page_write_access(connection, library_id, project_id, page_id)?;
    }
    if !allow_page_parent_transition
        && (parent_kind == "page" || matches!(target, DatabaseTransferTarget::Page { .. }))
    {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Page-parent transitions require Library Block/Document authority",
            false,
        ));
    }
    require_revision(
        expected_parent_revision,
        parent_revision,
        "Page parent revision changed",
    )?;
    let active_membership = connection
        .query_row(
            "SELECT id, data_source_id, revision FROM data_source_page_memberships \
             WHERE page_block_id = ?1 AND removed_at IS NULL",
            [page_id],
            |row| {
                Ok(ActiveMembership {
                    id: row.get(0)?,
                    data_source_id: row.get(1)?,
                    revision: row.get(2)?,
                })
            },
        )
        .optional()?;
    require_revision(
        expected_active_membership_revision,
        active_membership
            .as_ref()
            .map_or(0, |membership| membership.revision),
        "Page active membership revision changed",
    )?;
    let previous_source = active_membership
        .as_ref()
        .map(|membership| require_source(connection, library_id, &membership.data_source_id))
        .transpose()?;
    if let Some(source) = &previous_source {
        authorize_write(
            connection,
            project_id,
            &source.database_id,
            DatabaseWriteAction::Write,
            library_scope,
        )?;
    }
    if let Some(membership) = &active_membership {
        let relation_outcomes = super::relation::remove_membership_task_parent_edges(
            connection,
            &membership.data_source_id,
            &membership.id,
            now,
        )?;
        record_relation_outcomes(
            connection,
            library_id,
            &relation_outcomes,
            Some(page_id),
            now,
            effects,
        )?;
        let removed_revision = connection
            .query_row(
                "UPDATE data_source_page_memberships SET removed_at = ?1, revision = revision + 1 \
                 WHERE id = ?2 AND removed_at IS NULL RETURNING revision",
                params![now, membership.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| corrupt("Active Data Source membership disappeared"))?;
        effects.revisions.insert(
            format!("membership:{}:{}", membership.data_source_id, membership.id),
            removed_revision,
        );
    }
    effects
        .view_ids
        .extend(super::manual_order::forget_page(connection, page_id)?);
    connection.execute(
        "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
        params![page_id, library_id],
    )?;
    let placement_revision = connection
        .query_row(
            "UPDATE blocks SET placement_revision = placement_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND library_id = ?3 AND placement_revision = ?4 \
             RETURNING placement_revision",
            params![now, page_id, library_id, expected_parent_revision],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::RevisionConflict,
                "Page placement changed during transfer",
                true,
            )
        })?;
    let (parent_kind, parent_id) = match target {
        DatabaseTransferTarget::Library { library_id } => ("library", library_id.as_str()),
        DatabaseTransferTarget::DataSource { data_source_id } => {
            ("data_source", data_source_id.as_str())
        }
        DatabaseTransferTarget::Page { page_id } => ("page", page_id.as_str()),
    };
    let changed = connection.execute(
        "UPDATE pages SET parent_kind = ?1, parent_id = ?2, updated_at = ?3 \
         WHERE block_id = ?4 AND library_id = ?5",
        params![parent_kind, parent_id, now, page_id, library_id],
    )?;
    if changed != 1 {
        return Err(corrupt("Transferred Page lost its typed parent authority"));
    }

    let (target_membership_id, target_data_source_id) = match target {
        DatabaseTransferTarget::Library {
            library_id: target_library_id,
        } => {
            if target_library_id != library_id {
                return Err(unauthorized("A Page cannot transfer to another Library"));
            }
            crate::library::insert_library_placement(connection, library_id, page_id, None, now)?;
            crate::library::insert_creator_resource_grant(
                connection, project_id, library_id, "page", page_id, now,
            )?;
            (None, None)
        }
        DatabaseTransferTarget::DataSource { data_source_id } => {
            let target_source = require_source(connection, library_id, data_source_id)?;
            authorize_write(
                connection,
                project_id,
                &target_source.database_id,
                DatabaseWriteAction::Write,
                library_scope,
            )?;
            if active_membership
                .as_ref()
                .is_some_and(|membership| membership.data_source_id == *data_source_id)
            {
                return Err(invalid("Page already belongs to the target Data Source"));
            }
            let history = connection
                .query_row(
                    "SELECT id, revision, created_at FROM data_source_page_memberships \
                     WHERE data_source_id = ?1 AND page_block_id = ?2",
                    params![data_source_id, page_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let membership_id = history.as_ref().map_or_else(
                || deterministic_membership_id(data_source_id, page_id),
                |(id, _, _)| id.clone(),
            );
            if history.is_none() {
                let collision = connection
                    .query_row(
                        "SELECT 1 FROM data_source_page_memberships WHERE id = ?1",
                        [&membership_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if collision.is_some() {
                    return Err(StoreError::new(
                        StoreErrorCode::AlreadyOwned,
                        "Deterministic membership identity is already owned",
                        false,
                    ));
                }
            }
            let revision = history.as_ref().map_or(1, |(_, revision, _)| revision + 1);
            connection.execute(
                "INSERT INTO data_source_page_memberships(\
                   id, data_source_id, page_block_id, revision, created_at, removed_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL) \
                 ON CONFLICT(id) DO UPDATE SET data_source_id = excluded.data_source_id, \
                   page_block_id = excluded.page_block_id, revision = excluded.revision, \
                   removed_at = NULL",
                params![
                    membership_id,
                    data_source_id,
                    page_id,
                    revision,
                    history
                        .as_ref()
                        .map_or(now, |(_, _, created_at)| created_at),
                ],
            )?;
            ensure_database_page_key(
                connection,
                library_id,
                &target_source.database_id,
                page_id,
                now,
            )?;
            ensure_transferred_built_in_values(
                connection,
                active_membership.as_ref(),
                &membership_id,
                data_source_id,
                now,
                Some(effects),
            )?;
            synchronize_membership_completion_timestamp(
                connection,
                data_source_id,
                &membership_id,
                now,
            )?;
            effects.revisions.insert(
                format!("membership:{data_source_id}:{membership_id}"),
                revision,
            );
            effects.database_ids.insert(target_source.database_id);
            effects.data_source_ids.insert(data_source_id.clone());
            (Some(membership_id), Some(data_source_id.clone()))
        }
        DatabaseTransferTarget::Page {
            page_id: target_page_id,
        } => {
            connection
                .query_row(
                    "SELECT 1 FROM pages page JOIN blocks block \
                       ON block.id = page.block_id AND block.library_id = page.library_id \
                     WHERE page.block_id = ?1 AND page.library_id = ?2 \
                       AND block.lifecycle = 'active'",
                    params![target_page_id, library_id],
                    |_| Ok(()),
                )
                .optional()?
                .ok_or_else(|| not_found("Target Page is unavailable"))?;
            if !library_scope {
                crate::library::require_page_write_access(
                    connection,
                    library_id,
                    project_id,
                    target_page_id,
                )?;
            }
            effects.page_ids.insert(target_page_id.clone());
            (None, None)
        }
    };
    let parent_revision = placement_revision;
    if !defer_projection_refresh {
        refresh_transferred_page_projection(
            connection,
            page_id,
            target_membership_id.as_deref(),
            target_data_source_id.as_deref(),
            now,
        )?;
    }
    if let Some(source) = previous_source {
        touch_source(effects, &source);
    }
    effects.page_ids.insert(page_id.to_owned());
    effects
        .revisions
        .insert(format!("blockLocation:{page_id}"), parent_revision);
    Ok(())
}

fn ensure_transferred_built_in_values(
    connection: &Connection,
    source_membership: Option<&ActiveMembership>,
    target_membership_id: &str,
    target_data_source_id: &str,
    now: &str,
    mut effects: Option<&mut MutationEffects>,
) -> Result<(), StoreError> {
    let properties = connection
        .prepare(
            "SELECT id, name, value_type, config_json, rank_key, lifecycle, schema_revision, created_at \
             FROM data_source_properties WHERE data_source_id = ?1 AND lifecycle = 'active' \
             ORDER BY id",
        )?
        .query_map([target_data_source_id], |row| {
            Ok(PropertyRow {
                id: row.get(0)?,
                name: row.get(1)?,
                value_type: row.get(2)?,
                config_json: row.get(3)?,
                rank_key: row.get(4)?,
                lifecycle: row.get(5)?,
                revision: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for target_property in properties {
        if !is_built_in_property(&target_property.id) {
            continue;
        }
        let existing = connection
            .query_row(
                "SELECT 1 FROM data_source_property_values WHERE data_source_id = ?1 \
                 AND membership_id = ?2 AND property_id = ?3",
                params![
                    target_data_source_id,
                    target_membership_id,
                    target_property.id
                ],
                |_| Ok(()),
            )
            .optional()?;
        if existing.is_some() {
            continue;
        }
        let value = transfer_value(connection, source_membership, &target_property)?;
        connection.execute(
            "INSERT INTO data_source_property_values(\
               data_source_id, membership_id, property_id, value_type, value_json, revision, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![
                target_data_source_id,
                target_membership_id,
                target_property.id,
                target_property.value_type,
                serde_json::to_string(&value).map_err(|_| internal("Transferred value"))?,
                now,
            ],
        )?;
        if let Some(effects) = effects.as_deref_mut() {
            effects.revisions.insert(
                format!(
                    "value:{target_data_source_id}:{target_membership_id}:{}",
                    target_property.id
                ),
                1,
            );
        }
    }
    Ok(())
}

fn copy_same_source_property_values(
    connection: &Connection,
    source_membership: &ActiveMembership,
    target_membership_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO data_source_property_values(\
           data_source_id, membership_id, property_id, value_type, value_json, revision, updated_at\
         ) \
         SELECT value.data_source_id, ?1, value.property_id, value.value_type, value.value_json, 1, ?2 \
         FROM data_source_property_values value \
         JOIN data_source_properties property ON property.data_source_id = value.data_source_id \
           AND property.id = value.property_id AND property.lifecycle = 'active' \
         WHERE value.data_source_id = ?3 AND value.membership_id = ?4 \
           AND NOT EXISTS (\
             SELECT 1 FROM data_source_property_values existing \
             WHERE existing.data_source_id = value.data_source_id \
               AND existing.membership_id = ?1 AND existing.property_id = value.property_id\
           )",
        params![
            target_membership_id,
            now,
            source_membership.data_source_id,
            source_membership.id,
        ],
    )?;
    super::relation::copy_relation_edges(
        connection,
        &source_membership.data_source_id,
        &source_membership.id,
        target_membership_id,
        now,
    )?;
    Ok(())
}

fn transfer_value(
    connection: &Connection,
    source_membership: Option<&ActiveMembership>,
    target_property: &PropertyRow,
) -> Result<Value, StoreError> {
    let fallback = default_built_in_value(target_property)?;
    let Some(source_membership) = source_membership else {
        return Ok(fallback);
    };
    let Some(source_property) = property_row(
        connection,
        &source_membership.data_source_id,
        &target_property.id,
    )?
    else {
        return Ok(fallback);
    };
    if source_property.lifecycle != "active"
        || source_property.value_type != target_property.value_type
    {
        return Ok(fallback);
    }
    let source_value = connection
        .query_row(
            "SELECT value_json FROM data_source_property_values WHERE data_source_id = ?1 \
             AND membership_id = ?2 AND property_id = ?3",
            params![
                source_membership.data_source_id,
                source_membership.id,
                target_property.id,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| parse_json(&value, "Transferred source value"))
        .transpose()?;
    let Some(source_value) = source_value else {
        return Ok(fallback);
    };
    if target_property.id == "tags" {
        return map_tags_between_properties(&source_property, &source_value, target_property);
    }
    match normalize_value(target_property, &source_value) {
        Ok(value) => Ok(value),
        Err(error) if error.code == StoreErrorCode::InvalidInput => Ok(fallback),
        Err(error) => Err(error),
    }
}

fn default_built_in_value(property: &PropertyRow) -> Result<Value, StoreError> {
    if property.id == "tags" {
        return Ok(Value::Array(Vec::new()));
    }
    if property.id == "status" {
        let config = option_config(property)?;
        if config.options.iter().any(|option| option.id == "triage") {
            return Ok(Value::String("triage".to_owned()));
        }
    }
    Ok(Value::Null)
}

fn map_tags_between_properties(
    source_property: &PropertyRow,
    source_value: &Value,
    target_property: &PropertyRow,
) -> Result<Value, StoreError> {
    let source_value = normalize_value(source_property, source_value)?;
    let source = option_config(source_property)?;
    let target = option_config(target_property)?;
    let source_names = source
        .options
        .iter()
        .map(|option| (option.id.as_str(), option.name.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let target_ids = target
        .options
        .iter()
        .map(|option| (option.name.as_str(), option.id.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let mapped = source_value
        .as_array()
        .ok_or_else(|| corrupt("Canonical source tags value is not an array"))?
        .iter()
        .filter_map(|value| {
            value
                .as_str()
                .and_then(|option_id| source_names.get(option_id))
                .and_then(|name| target_ids.get(name))
                .map(|option_id| Value::String((*option_id).to_owned()))
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(mapped))
}

pub(crate) fn refresh_transferred_page_projection(
    connection: &Connection,
    page_id: &str,
    target_membership_id: Option<&str>,
    target_data_source_id: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    super::manual_order::join_page(connection, page_id, now)?;
    let authority = connection
        .query_row(
            "SELECT block.library_id, block.lifecycle, block.placement_revision, \
               block.metadata_revision, page.parent_kind, page.parent_id, placement.rank_key \
             FROM blocks block \
             JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id \
             LEFT JOIN library_block_placements placement \
               ON placement.block_id = block.id AND placement.library_id = block.library_id \
             WHERE block.id = ?1 AND block.type = 'page'",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Transferred Page authority disappeared"))?;
    let compatibility = match (target_membership_id, target_data_source_id) {
        (Some(membership_id), Some(data_source_id)) => {
            read_compatibility_values(connection, data_source_id, membership_id)?
        }
        (None, None) => CompatibilityValues {
            values: Map::new(),
            revisions: Map::new(),
        },
        _ => {
            return Err(corrupt(
                "Transferred Page membership projection is incomplete",
            ));
        }
    };
    let placement = match target_data_source_id {
        Some(data_source_id) => preferred_view_placement(connection, data_source_id, page_id)?,
        None => PreferredViewPlacement {
            view_id: None,
            group_key: None,
            rank_key: None,
        },
    };
    let database_id = target_data_source_id
        .map(|data_source_id| {
            connection.query_row(
                "SELECT home_database_block_id FROM data_sources WHERE id = ?1",
                [data_source_id],
                |row| row.get::<_, String>(0),
            )
        })
        .transpose()?;
    let property_revisions_json = connection
        .query_row(
            "SELECT property_revisions_json FROM page_read_model WHERE page_block_id = ?1",
            [page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Transferred Page has no read projection"))?;
    let mut property_revisions = json_object(
        &property_revisions_json,
        "Transferred Page Property revisions",
    )?;
    property_revisions.insert(
        "database".to_owned(),
        Value::Object(compatibility.revisions),
    );
    connection.execute(
        "UPDATE page_read_model SET lifecycle = ?1, parent_kind = ?2, parent_id = ?3, \
           library_rank_key = ?4, placement_revision = ?5, metadata_revision = ?6, \
           membership_id = ?7, database_block_id = ?8, view_id = ?9, \
           view_group_key = ?10, view_rank_key = ?11, database_values_json = ?12, \
           property_revisions_json = ?13, projection_version = projection_version + 1, \
           updated_at = ?14 WHERE page_block_id = ?15 AND library_id = ?16",
        params![
            authority.1,
            authority.4,
            authority.5,
            authority.6,
            authority.2,
            authority.3,
            target_membership_id,
            database_id,
            placement.view_id,
            placement.group_key,
            placement.rank_key,
            serde_json::to_string(&compatibility.values)
                .map_err(|_| internal("Transferred Page values"))?,
            serde_json::to_string(&property_revisions)
                .map_err(|_| internal("Transferred Page revisions"))?,
            now,
            page_id,
            authority.0,
        ],
    )?;
    let scheduled_start = compatibility
        .values
        .get("scheduled_start")
        .and_then(Value::as_str);
    let scheduled_end = compatibility
        .values
        .get("scheduled_end")
        .and_then(Value::as_str);
    connection.execute(
        "UPDATE scheduled_page_index SET lifecycle = ?1, scheduled_start = ?2, \
           scheduled_end = ?3, is_all_day = CASE WHEN ?2 IS NOT NULL AND ?3 IS NOT NULL \
             THEN is_all_day ELSE 0 END, source_metadata_revision = ?4, updated_at = ?5 \
         WHERE page_block_id = ?6",
        params![
            authority.1,
            scheduled_start,
            scheduled_end,
            authority.3,
            now,
            page_id,
        ],
    )?;
    Ok(())
}

fn read_compatibility_values(
    connection: &Connection,
    data_source_id: &str,
    membership_id: &str,
) -> Result<CompatibilityValues, StoreError> {
    let rows = connection
        .prepare(
            "SELECT property.id, property.name, property.value_type, property.config_json, \
               property.rank_key, property.lifecycle, property.schema_revision, property.created_at, \
               value.value_json, value.revision FROM data_source_properties property \
             LEFT JOIN data_source_property_values value ON value.data_source_id = property.data_source_id \
               AND value.property_id = property.id AND value.membership_id = ?1 \
             WHERE property.data_source_id = ?2 AND property.lifecycle = 'active' ORDER BY property.id",
        )?
        .query_map(params![membership_id, data_source_id], |row| {
            Ok((
                PropertyRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    value_type: row.get(2)?,
                    config_json: row.get(3)?,
                    rank_key: row.get(4)?,
                    lifecycle: row.get(5)?,
                    revision: row.get(6)?,
                    created_at: row.get(7)?,
                },
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = Map::new();
    let mut revisions = Map::new();
    for (property, value, revision) in rows {
        if !is_built_in_property(&property.id) {
            continue;
        }
        let (Some(value), Some(revision)) = (value, revision) else {
            continue;
        };
        let value = parse_json(&value, "Transferred compatibility value")?;
        let value = if property.id == "tags" {
            tag_compatibility_value(&property, &value)?
        } else {
            value
        };
        values.insert(property.id.clone(), value);
        revisions.insert(property.id, Value::from(revision));
    }
    Ok(CompatibilityValues { values, revisions })
}

fn preferred_view_placement(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
) -> Result<PreferredViewPlacement, StoreError> {
    let view = connection
        .query_row(
            "SELECT view.id, view.config_json FROM data_sources source \
             JOIN database_containers container ON container.block_id = source.home_database_block_id \
             JOIN database_views view ON view.database_block_id = container.block_id \
               AND view.data_source_id = source.id AND view.lifecycle = 'active' \
             WHERE source.id = ?1 ORDER BY CASE WHEN view.id = container.default_view_id \
               THEN 0 ELSE 1 END, view.rank_key, view.id LIMIT 1",
            [data_source_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((view_id, config_json)) = view else {
        return Ok(PreferredViewPlacement {
            view_id: None,
            group_key: None,
            rank_key: None,
        });
    };
    let position = connection
        .query_row(
            "SELECT rank_key FROM database_view_page_positions \
             WHERE view_id = ?1 AND page_block_id = ?2",
            params![view_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let definition = super::view_contract::decode_definition_json(&config_json).map_err(corrupt)?;
    Ok(PreferredViewPlacement {
        view_id: Some(view_id),
        group_key: derived_view_group_key(connection, data_source_id, page_id, &definition)?,
        rank_key: position,
    })
}

fn derived_view_group_key(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
    definition: &DatabaseViewDefinition,
) -> Result<Option<String>, StoreError> {
    let Some(property_id) = view_group_property(definition) else {
        return Ok(None);
    };
    let value = connection
        .query_row(
            "SELECT value.value_json FROM data_source_page_memberships membership \
             LEFT JOIN data_source_property_values value \
               ON value.data_source_id = membership.data_source_id \
               AND value.membership_id = membership.id AND value.property_id = ?3 \
             WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 \
               AND membership.removed_at IS NULL",
            params![data_source_id, page_id, property_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .map(|value| parse_json(&value, "Grouped Property value"))
        .transpose()?;
    value.as_ref().map_or(Ok(None), database_group_key)
}

fn deterministic_membership_id(data_source_id: &str, page_id: &str) -> String {
    let fingerprint = format!("{data_source_id}\0{page_id}");
    format!("membership:{}", sha256(fingerprint.as_bytes()))
}

fn is_built_in_property(property_id: &str) -> bool {
    matches!(
        property_id,
        "status"
            | "priority"
            | "estimate"
            | "tags"
            | "due_date"
            | "scheduled_start"
            | "scheduled_end"
            | "assignee"
            | "task_parent"
    )
}

#[allow(clippy::too_many_arguments)]
fn put_view(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    data_source_id: &str,
    view_id: &str,
    expected_revision: i64,
    name: &str,
    layout: DatabaseViewLayout,
    definition: &DatabaseViewDefinition,
    is_default: bool,
    before_view_id: Option<&str>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    validate_id(database_id, "database_id", MAX_ID_LENGTH)?;
    validate_id(view_id, "view_id", MAX_ID_LENGTH)?;
    let name = validate_name(name, "View name")?;
    let container = require_container(connection, library_id, database_id)?;
    if container.lifecycle != "active" {
        return Err(not_found("Database is not active"));
    }
    let source = require_source(connection, library_id, data_source_id)?;
    if source.database_id != database_id {
        return Err(not_found(
            "View Database and Data Source must share one active authority",
        ));
    }
    authorize_write(
        connection,
        project_id,
        database_id,
        DatabaseWriteAction::ManageViews,
        library_scope,
    )?;
    let existing = view_row(connection, view_id)?;
    require_revision(
        expected_revision,
        existing.as_ref().map_or(0, |view| view.revision),
        "Database View revision changed",
    )?;
    if !existing
        .as_ref()
        .is_some_and(|view| view.lifecycle == "active")
    {
        let active_count = connection.query_row(
            "SELECT count(*) FROM database_views \
             WHERE database_block_id = ?1 AND lifecycle = 'active'",
            [database_id],
            |row| row.get::<_, i64>(0),
        )?;
        ensure_collection_capacity(
            active_count,
            super::MAX_DATABASE_VIEWS,
            "Database View collection",
        )?;
    }
    if existing
        .as_ref()
        .is_some_and(|view| view.database_id != database_id)
    {
        return Err(StoreError::new(
            StoreErrorCode::AlreadyOwned,
            "Database View identity belongs to another Database",
            false,
        ));
    }
    validate_view_definition(
        connection,
        library_id,
        project_id,
        data_source_id,
        definition,
        library_scope,
    )?;
    let encoded_config =
        super::view_contract::encode_definition_json(definition).map_err(invalid)?;
    if encoded_config.len() > 262_144 {
        return Err(invalid("Database View config exceeds its byte bound"));
    }
    let existing_group = existing
        .as_ref()
        .map(|view| {
            super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)
        })
        .transpose()?
        .as_ref()
        .and_then(view_group_property)
        .map(str::to_owned);
    let next_group = view_group_property(definition).map(str::to_owned);
    let source_changed = existing
        .as_ref()
        .is_some_and(|view| view.data_source_id != data_source_id);
    let group_changed = existing.is_some() && existing_group != next_group;
    if source_changed {
        clear_view_projection(connection, view_id, now)?;
    }
    let preserve_rank = existing
        .as_ref()
        .filter(|view| view.lifecycle == "active" && before_view_id.is_none())
        .map(|view| view.rank_key.clone());
    let rank_key = preserve_rank.clone().unwrap_or_else(|| "0".repeat(32));
    let revision = existing.as_ref().map_or(1, |view| view.revision + 1);
    let created_at = existing
        .as_ref()
        .map_or(now, |view| view.created_at.as_str());
    let layout = match layout {
        DatabaseViewLayout::Board => "board",
        DatabaseViewLayout::List => "list",
    };
    connection.execute(
        "INSERT INTO database_views(\
           id, database_block_id, data_source_id, name, layout, config_json, revision, \
           rank_key, lifecycle, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10) \
         ON CONFLICT(id) DO UPDATE SET database_block_id = excluded.database_block_id, \
           data_source_id = excluded.data_source_id, name = excluded.name, \
           layout = excluded.layout, \
           config_json = excluded.config_json, revision = excluded.revision, \
           rank_key = excluded.rank_key, lifecycle = 'active', updated_at = excluded.updated_at",
        params![
            view_id,
            database_id,
            data_source_id,
            name,
            layout,
            encoded_config,
            revision,
            rank_key,
            created_at,
            now,
        ],
    )?;
    if source_changed
        || group_changed
        || existing
            .as_ref()
            .is_some_and(|view| view.lifecycle != "active")
    {
        super::manual_order::reset_view(connection, view_id)?;
    }
    if preserve_rank.is_none() {
        reorder_views(connection, database_id, view_id, before_view_id)?;
    }
    let metadata_revision = connection.query_row(
        "UPDATE database_containers SET \
           default_view_id = CASE WHEN ?1 = 1 THEN ?2 ELSE default_view_id END, \
           metadata_revision = metadata_revision + 1, updated_at = ?3 WHERE block_id = ?4 \
         RETURNING metadata_revision",
        params![i64::from(is_default), view_id, now, database_id],
        |row| row.get::<_, i64>(0),
    )?;
    if is_default
        || container.default_view_id.as_deref() == Some(view_id)
        || source_changed
        || group_changed
    {
        refresh_default_view_projection(connection, database_id, now)?;
    }
    effects.database_ids.insert(database_id.to_owned());
    effects.data_source_ids.insert(data_source_id.to_owned());
    if let Some(existing) = existing {
        effects.data_source_ids.insert(existing.data_source_id);
    }
    effects.view_ids.insert(view_id.to_owned());
    effects
        .revisions
        .insert(format!("view:{view_id}"), revision);
    effects.revisions.insert(
        format!("database:{database_id}:metadata"),
        metadata_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn duplicate_view(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    source_view_id: &str,
    expected_revision: i64,
    new_view_id: &str,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source_view = view_row(connection, source_view_id)?
        .filter(|view| view.database_id == database_id && view.lifecycle == "active")
        .ok_or_else(|| not_found("Source Database View is unavailable"))?;
    require_revision(
        expected_revision,
        source_view.revision,
        "Database View revision changed",
    )?;
    if view_row(connection, new_view_id)?.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::AlreadyOwned,
            "Duplicate Database View identity is already owned",
            false,
        ));
    }
    let definition =
        super::view_contract::decode_definition_json(&source_view.config_json).map_err(corrupt)?;
    let layout = match source_view.layout.as_str() {
        "board" => DatabaseViewLayout::Board,
        "list" => DatabaseViewLayout::List,
        _ => return Err(corrupt("Database View layout is unsupported")),
    };
    let candidate = format!("{} copy", source_view.name);
    let mut suffix = 1_u64;
    let name = loop {
        let name = if suffix == 1 {
            candidate.clone()
        } else {
            format!("{candidate} {suffix}")
        };
        let exists = connection.query_row(
            "SELECT EXISTS( \
               SELECT 1 FROM database_views \
               WHERE database_block_id = ?1 AND lifecycle = 'active' \
                 AND lower(name) = lower(?2) \
             )",
            params![database_id, name],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            break name;
        }
        suffix += 1;
    };
    let before_view_id = connection
        .query_row(
            "SELECT id FROM database_views \
             WHERE database_block_id = ?1 AND lifecycle = 'active' AND id <> ?2 \
               AND (rank_key > ?3 OR (rank_key = ?3 AND id > ?2)) \
             ORDER BY rank_key, id LIMIT 1",
            params![database_id, source_view_id, source_view.rank_key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    put_view(
        connection,
        library_id,
        project_id,
        database_id,
        &source_view.data_source_id,
        new_view_id,
        0,
        &name,
        layout,
        &definition,
        false,
        before_view_id.as_deref(),
        now,
        effects,
        library_scope,
    )
}

#[allow(clippy::too_many_arguments)]
fn change_view_layout(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    view_id: &str,
    expected_revision: i64,
    layout: DatabaseViewLayout,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let view = view_row(connection, view_id)?
        .filter(|view| view.database_id == database_id && view.lifecycle == "active")
        .ok_or_else(|| not_found("Active Database View is unavailable"))?;
    require_revision(
        expected_revision,
        view.revision,
        "Database View revision changed",
    )?;
    let current_layout = match view.layout.as_str() {
        "board" => DatabaseViewLayout::Board,
        "list" => DatabaseViewLayout::List,
        _ => return Err(corrupt("Database View layout is unsupported")),
    };
    if current_layout == layout {
        return Err(invalid("Database View already uses the requested layout"));
    }
    let mut definition =
        super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)?;
    definition.presentation.display.show_description = matches!(layout, DatabaseViewLayout::Board);
    put_view(
        connection,
        library_id,
        project_id,
        database_id,
        &view.data_source_id,
        view_id,
        expected_revision,
        &view.name,
        layout,
        &definition,
        false,
        None,
        now,
        effects,
        library_scope,
    )
}

#[allow(clippy::too_many_arguments)]
fn move_view(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    view_id: &str,
    expected_revision: i64,
    placement: &DatabaseViewPlacement,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let container = require_container(connection, library_id, database_id)?;
    if container.lifecycle != "active" {
        return Err(not_found("Database is not active"));
    }
    authorize_write(
        connection,
        project_id,
        database_id,
        DatabaseWriteAction::ManageViews,
        library_scope,
    )?;
    let view = view_row(connection, view_id)?.ok_or_else(|| not_found("View is unavailable"))?;
    if view.lifecycle != "active" || view.database_id != database_id {
        return Err(not_found("View is not active in this Database"));
    }
    require_revision(
        expected_revision,
        view.revision,
        "Database View revision changed",
    )?;
    let before_view_id = match placement {
        DatabaseViewPlacement::Before { view_id } => Some(view_id.as_str()),
        DatabaseViewPlacement::End => None,
    };
    reorder_views(connection, database_id, view_id, before_view_id)?;
    let revision = view.revision + 1;
    connection.execute(
        "UPDATE database_views SET revision = ?1, updated_at = ?2 WHERE id = ?3",
        params![revision, now, view_id],
    )?;
    let metadata_revision = connection.query_row(
        "UPDATE database_containers SET metadata_revision = metadata_revision + 1, \
         updated_at = ?1 WHERE block_id = ?2 RETURNING metadata_revision",
        params![now, database_id],
        |row| row.get::<_, i64>(0),
    )?;
    effects.database_ids.insert(database_id.to_owned());
    effects.data_source_ids.insert(view.data_source_id);
    effects.view_ids.insert(view_id.to_owned());
    effects
        .revisions
        .insert(format!("view:{view_id}"), revision);
    effects.revisions.insert(
        format!("database:{database_id}:metadata"),
        metadata_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn delete_view(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    database_id: &str,
    view_id: &str,
    expected_revision: i64,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let container = require_container(connection, library_id, database_id)?;
    let view = view_row(connection, view_id)?
        .filter(|view| view.database_id == database_id && view.lifecycle == "active")
        .ok_or_else(|| not_found("Active Database View is unavailable"))?;
    authorize_write(
        connection,
        project_id,
        database_id,
        DatabaseWriteAction::ManageViews,
        library_scope,
    )?;
    require_revision(
        expected_revision,
        view.revision,
        "Database View revision changed",
    )?;
    let fallback_view_id = connection
        .query_row(
            "SELECT id FROM database_views \
             WHERE database_block_id = ?1 AND lifecycle = 'active' AND id <> ?2 \
             ORDER BY rank_key, id LIMIT 1",
            params![database_id, view_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Conflict,
                "A Database must keep at least one active View",
                false,
            )
        })?;
    let was_default = container.default_view_id.as_deref() == Some(view_id);
    let metadata_revision = connection.query_row(
        "UPDATE database_containers SET \
           default_view_id = CASE WHEN default_view_id = ?1 THEN ?2 ELSE default_view_id END, \
           metadata_revision = metadata_revision + 1, updated_at = ?3 WHERE block_id = ?4 \
         RETURNING metadata_revision",
        params![view_id, fallback_view_id, now, database_id],
        |row| row.get::<_, i64>(0),
    )?;
    clear_view_projection(connection, view_id, now)?;
    super::manual_order::retire_view(connection, view_id)?;
    connection.execute(
        "UPDATE database_views SET lifecycle = 'deleted', revision = revision + 1, \
           updated_at = ?1 WHERE id = ?2",
        params![now, view_id],
    )?;
    if was_default {
        refresh_default_view_projection(connection, database_id, now)?;
    }
    effects.database_ids.insert(database_id.to_owned());
    effects.data_source_ids.insert(view.data_source_id);
    effects.view_ids.insert(view_id.to_owned());
    effects
        .revisions
        .insert(format!("view:{view_id}"), view.revision + 1);
    effects.revisions.insert(
        format!("database:{database_id}:metadata"),
        metadata_revision,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn position_pages(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    view_id: &str,
    pages: &[DatabasePagePosition],
    before_page_id: Option<&str>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    position_page_runs(
        connection,
        library_id,
        project_id,
        view_id,
        pages,
        &[LogicalPositionRun {
            page_ids: pages.iter().map(|page| page.page_id.clone()).collect(),
            before_page_id: before_page_id.map(str::to_owned),
        }],
        now,
        effects,
        library_scope,
    )
}

#[allow(clippy::too_many_arguments)]
fn position_page_runs(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    view_id: &str,
    pages: &[DatabasePagePosition],
    runs: &[LogicalPositionRun],
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    if pages.is_empty() || pages.len() > MAX_BULK_VALUES {
        return Err(invalid(format!(
            "View positioning requires between 1 and {MAX_BULK_VALUES} Pages"
        )));
    }
    let page_ids = pages
        .iter()
        .map(|page| page.page_id.as_str())
        .collect::<HashSet<_>>();
    if page_ids.len() != pages.len() {
        return Err(invalid("View position Page IDs must be unique"));
    }
    let run_page_ids = runs
        .iter()
        .flat_map(|run| run.page_ids.iter().map(String::as_str))
        .collect::<HashSet<_>>();
    if run_page_ids != page_ids {
        return Err(invalid("View runs must match the revision-fenced Page set"));
    }
    if runs.iter().any(|run| {
        run.before_page_id
            .as_deref()
            .is_some_and(|page_id| page_ids.contains(page_id))
    }) {
        return Err(invalid(
            "View position anchor must be outside the moved Page set",
        ));
    }
    let view = view_row(connection, view_id)?
        .filter(|view| view.lifecycle == "active")
        .ok_or_else(|| not_found("Active Database View is unavailable"))?;
    let source = require_source(connection, library_id, &view.data_source_id)?;
    if source.database_id != view.database_id {
        return Err(corrupt("Database View source authority is inconsistent"));
    }
    authorize_write(
        connection,
        project_id,
        &view.database_id,
        DatabaseWriteAction::Write,
        library_scope,
    )?;
    let definition =
        super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)?;
    let order = super::manual_order::require_ready(connection, view_id)?;
    for page in pages {
        active_row_membership(connection, &view.data_source_id, &page.page_id)?;
        let existing_revision =
            super::manual_order::position_revision(connection, &order, &page.page_id)?;
        require_revision(
            page.expected_position_revision,
            existing_revision,
            "Database View position revision changed",
        )?;
    }

    let descending = view_fractional_direction(&definition) == DatabaseViewSortDirection::Desc;
    let writes = super::manual_order::position_runs(connection, &order, runs, descending, now)?;
    for page in pages {
        let write = writes
            .get(&page.page_id)
            .ok_or_else(|| corrupt("Database View rank plan omitted a moved Page"))?;
        connection.execute(
            "UPDATE page_read_model SET view_rank_key = ?1, \
               projection_version = projection_version + 1, updated_at = ?2 \
             WHERE page_block_id = ?3 AND view_id = ?4",
            params![write.rank_key, now, page.page_id, view_id,],
        )?;
        effects.revisions.insert(
            format!("position:{view_id}:{}", page.page_id),
            write.revision,
        );
    }
    for page in pages {
        let metadata_revision = bump_page_metadata_revision(connection, &page.page_id, now)?;
        connection.execute(
            "UPDATE page_read_model SET metadata_revision = ?1, \
               projection_version = projection_version + 1, updated_at = ?2 \
             WHERE page_block_id = ?3",
            params![metadata_revision, now, page.page_id],
        )?;
        effects.page_ids.insert(page.page_id.clone());
        effects
            .revisions
            .insert(format!("page:{}:metadata", page.page_id), metadata_revision);
    }
    effects.database_ids.insert(view.database_id);
    effects.data_source_ids.insert(view.data_source_id);
    effects.view_ids.insert(view.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn set_task_parent(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    pages: &[DatabaseTaskParentPage],
    parent_page_id: Option<&str>,
    before_page_id: Option<&str>,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let source = require_source(connection, library_id, data_source_id)?;
    authorize_write(
        connection,
        project_id,
        &source.database_id,
        DatabaseWriteAction::Write,
        library_scope,
    )?;
    active_property(
        connection,
        data_source_id,
        super::property_semantics::TASK_PARENT_PROPERTY_ID,
    )?;
    let affected_values = super::relation::apply_task_parent_run(
        connection,
        data_source_id,
        pages,
        parent_page_id,
        before_page_id,
        now,
    )?;
    if affected_values.is_empty() {
        return Ok(());
    }
    record_relation_outcomes(connection, library_id, &affected_values, None, now, effects)
}

#[allow(clippy::too_many_arguments)]
fn move_list_occurrences(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    projection_project_id: Option<&str>,
    view_id: &str,
    preferences_override: &DatabaseViewPreferencesOverrideInput,
    expected_projection: &DatabaseListProjectionExpectation,
    initiator_occurrence_key: &str,
    selection: &DatabaseListMoveSelection,
    target: &DatabaseListMoveTarget,
    operation_index: u32,
    now: &str,
    effects: &mut MutationEffects,
    library_scope: bool,
) -> Result<(), StoreError> {
    let store_epoch = read_store_epoch(connection)?;
    let projection = super::window::presented_list_projection(
        connection,
        library_id,
        view_id,
        preferences_override,
        &store_epoch,
        projection_project_id,
    )?;
    let plan = super::list_drag::plan_list_occurrence_move(
        connection,
        &projection,
        expected_projection,
        initiator_occurrence_key,
        selection,
        target,
    )?;
    if plan.view_id != view_id {
        return Err(corrupt("Semantic List move crossed its View boundary"));
    }
    let source = require_source(connection, library_id, &plan.data_source_id)?;
    if source.database_id != plan.database_id {
        return Err(corrupt(
            "Semantic List move crossed its Data Source boundary",
        ));
    }
    authorize_write(
        connection,
        project_id,
        &plan.database_id,
        DatabaseWriteAction::Write,
        library_scope,
    )?;
    for edit in &plan.property_edits {
        edit_property_value(
            connection,
            library_id,
            project_id,
            edit,
            now,
            effects,
            library_scope,
        )?;
    }
    if let Some(parent_run) = &plan.parent_run {
        set_task_parent(
            connection,
            library_id,
            project_id,
            &plan.data_source_id,
            &parent_run.pages,
            parent_run.parent_page_id.as_deref(),
            parent_run.before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        )?;
    }
    if let Some(position_run) = &plan.position_run {
        position_pages(
            connection,
            library_id,
            project_id,
            &plan.view_id,
            &position_run.pages,
            position_run.before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        )?;
    }
    let undo_recipe = super::list_drag::finish_list_inverse(connection, plan.undo_recipe)?;
    effects.database_ids.insert(plan.database_id);
    effects.data_source_ids.insert(plan.data_source_id);
    effects.view_ids.insert(plan.view_id);
    effects
        .operation_outcomes
        .push(DatabaseOperationOutcome::ListOccurrenceMove {
            operation_index,
            moved_page_ids: plan.moved_page_ids,
            move_root_page_ids: plan.move_root_page_ids,
            normalized_target: plan.normalized_target,
            undo_recipe: Box::new(undo_recipe),
        });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn undo_list_occurrence_move(
    connection: &Connection,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    recipe: &DatabaseListMoveUndoRecipe,
    operation_index: u32,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    data_history::authorize_list_recipe(connection, library_id, authority, recipe)?;
    let project_id = authority.actor_project_id.as_str();
    let library_scope = authority.is_library();
    let plan = super::list_drag::plan_list_occurrence_move_undo(connection, recipe)?;
    for edit in &plan.property_edits {
        edit_property_value(
            connection,
            library_id,
            project_id,
            edit,
            now,
            effects,
            library_scope,
        )?;
    }
    for parent_run in &plan.parent_runs {
        set_task_parent(
            connection,
            library_id,
            project_id,
            &plan.data_source_id,
            &parent_run.pages,
            parent_run.parent_page_id.as_deref(),
            parent_run.before_page_id.as_deref(),
            now,
            effects,
            library_scope,
        )?;
    }
    if !plan.position_runs.is_empty() {
        let pages = plan
            .position_runs
            .iter()
            .flat_map(|run| run.pages.iter().cloned())
            .collect::<Vec<_>>();
        let runs = plan
            .position_runs
            .iter()
            .map(|run| LogicalPositionRun {
                page_ids: run.pages.iter().map(|page| page.page_id.clone()).collect(),
                before_page_id: run.before_page_id.clone(),
            })
            .collect::<Vec<_>>();
        position_page_runs(
            connection,
            library_id,
            project_id,
            &plan.view_id,
            &pages,
            &runs,
            now,
            effects,
            library_scope,
        )?;
    }
    let undo_recipe = super::list_drag::finish_list_inverse(connection, plan.undo_recipe)?;
    effects.view_ids.insert(plan.view_id);
    effects.data_source_ids.insert(plan.data_source_id);
    effects
        .operation_outcomes
        .push(DatabaseOperationOutcome::ListOccurrenceMoveUndo {
            operation_index,
            restored_page_ids: plan.restored_page_ids,
            undo_recipe: Box::new(undo_recipe),
        });
    Ok(())
}

fn presentation_override_is_empty(presentation: &DatabaseViewPresentationOverrideInput) -> bool {
    presentation.group.is_none()
        && presentation.subgroup.is_none()
        && presentation.group_direction.is_none()
        && presentation.completion.is_none()
        && presentation.hierarchy.is_none()
        && presentation.display.is_none()
}

fn rules_override_is_empty(rules: &DatabaseViewRulesOverrideInput) -> bool {
    rules.property_filters.is_none() && rules.advanced_filter.is_none() && rules.sorts.is_none()
}

#[allow(clippy::too_many_arguments)]
fn put_view_personal_preferences(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    actor_project_id: &str,
    authority_project_id: Option<&str>,
    view_id: &str,
    expected_revision: i64,
    rules_override: &DatabaseViewRulesOverrideInput,
    presentation_override: &DatabaseViewPresentationOverrideInput,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    let view = authorize_personal_view(connection, library_id, authority_project_id, view_id)?;
    let preferences_override = DatabaseViewPreferencesOverrideInput {
        rules_override: rules_override.clone(),
        presentation_override: presentation_override.clone(),
    };
    super::window::validate_preferences_override(
        connection,
        library_id,
        actor_project_id,
        authority_project_id,
        view_id,
        &preferences_override,
    )?;
    let current = connection
        .query_row(
            "SELECT preferences_json, revision \
             FROM database_view_personal_preferences \
             WHERE profile_id = ?1 AND view_id = ?2",
            params![profile_id, view_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let current_revision = current.as_ref().map(|(_, revision)| *revision).unwrap_or(0);
    require_revision(
        expected_revision,
        current_revision,
        "Database View personal preferences changed",
    )?;
    let preferences_json = serde_json::to_string(&preferences_override)
        .map_err(|_| internal("View personal preferences could not be serialized"))?;
    if current
        .as_ref()
        .is_some_and(|(stored, _)| stored == &preferences_json)
        || (current.is_none()
            && rules_override_is_empty(rules_override)
            && presentation_override_is_empty(presentation_override))
    {
        effects.revisions.insert(
            format!("view_preferences:{profile_id}:{view_id}"),
            current_revision,
        );
        return Ok(());
    }

    let revision = current_revision + 1;
    connection.execute(
        "INSERT INTO database_view_personal_preferences(\
           profile_id, view_id, preferences_json, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
         ON CONFLICT(profile_id, view_id) DO UPDATE SET \
           preferences_json = excluded.preferences_json, \
           revision = excluded.revision, updated_at = excluded.updated_at",
        params![profile_id, view_id, preferences_json, revision, now],
    )?;
    let value = DatabaseViewPersonalPreferences {
        rules_override: rules_override.clone(),
        presentation_override: presentation_override.clone(),
        revision,
    };
    effects
        .revisions
        .insert(format!("view_preferences:{profile_id}:{view_id}"), revision);
    effects.personal_preferences.insert(view.id, value);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn set_view_occurrence_disclosure(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    project_id: Option<&str>,
    view_id: &str,
    target: &DatabaseViewDisclosureTarget,
    collapsed: bool,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    validate_disclosure_target(target)?;
    let view = authorize_personal_view(connection, library_id, project_id, view_id)?;
    let (target_kind, occurrence_key) = disclosure_storage_address(target);
    let exists = connection
        .query_row(
            "SELECT 1 FROM database_view_collapsed_occurrences \
             WHERE profile_id = ?1 AND view_id = ?2 \
               AND target_kind = ?3 AND occurrence_key = ?4",
            params![profile_id, view_id, target_kind, occurrence_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists == collapsed {
        return Ok(());
    }

    if collapsed {
        let count = connection.query_row(
            "SELECT count(*) FROM database_view_collapsed_occurrences \
             WHERE profile_id = ?1 AND view_id = ?2",
            params![profile_id, view_id],
            |row| row.get::<_, i64>(0),
        )?;
        if count >= MAX_COLLAPSED_OCCURRENCES {
            let evicted = connection
                .query_row(
                    "SELECT target_kind, occurrence_key \
                     FROM database_view_collapsed_occurrences \
                     WHERE profile_id = ?1 AND view_id = ?2 \
                     ORDER BY collapsed_at, target_kind, occurrence_key LIMIT 1",
                    params![profile_id, view_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| corrupt("Collapsed occurrence bound is inconsistent"))?;
            connection.execute(
                "DELETE FROM database_view_collapsed_occurrences \
                 WHERE profile_id = ?1 AND view_id = ?2 \
                   AND target_kind = ?3 AND occurrence_key = ?4",
                params![profile_id, view_id, evicted.0, evicted.1],
            )?;
            effects.occurrence_disclosures.insert(
                (
                    view.id.clone(),
                    disclosure_target_from_storage(&evicted.0, evicted.1)?,
                ),
                false,
            );
        }
        connection.execute(
            "INSERT INTO database_view_collapsed_occurrences(\
               profile_id, view_id, target_kind, occurrence_key, collapsed_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile_id, view_id, target_kind, occurrence_key, now],
        )?;
    } else {
        connection.execute(
            "DELETE FROM database_view_collapsed_occurrences \
             WHERE profile_id = ?1 AND view_id = ?2 \
               AND target_kind = ?3 AND occurrence_key = ?4",
            params![profile_id, view_id, target_kind, occurrence_key],
        )?;
    }
    effects
        .occurrence_disclosures
        .insert((view.id, target.clone()), collapsed);
    Ok(())
}

fn authorize_personal_view(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    view_id: &str,
) -> Result<ViewRow, StoreError> {
    let view = view_row(connection, view_id)?
        .filter(|view| view.lifecycle == "active")
        .ok_or_else(|| not_found("Active Database View is unavailable"))?;
    let source = require_source(connection, library_id, &view.data_source_id)?;
    if source.database_id != view.database_id {
        return Err(corrupt("Database View source authority is inconsistent"));
    }
    let primary_database_id = project_id
        .map(|project_id| project_primary_database(connection, library_id, project_id))
        .transpose()?
        .flatten();
    authorize_required(
        connection,
        project_id,
        primary_database_id.as_deref(),
        &view.database_id,
    )?;
    Ok(view)
}

fn validate_disclosure_target(target: &DatabaseViewDisclosureTarget) -> Result<(), StoreError> {
    let occurrence_key = target.occurrence_key();
    if occurrence_key.is_empty() || occurrence_key.len() > MAX_OCCURRENCE_KEY_LENGTH {
        return Err(invalid(
            "View occurrence disclosure key violates its durable bound",
        ));
    }
    let valid_prefix = match target {
        DatabaseViewDisclosureTarget::Group { .. } => occurrence_key.starts_with("GROUP_"),
        DatabaseViewDisclosureTarget::Page { .. } => occurrence_key.starts_with("ITEM_"),
    };
    if valid_prefix {
        return Ok(());
    }
    Err(invalid(
        "View occurrence disclosure target does not match its occurrence kind",
    ))
}

fn disclosure_storage_address(target: &DatabaseViewDisclosureTarget) -> (&'static str, &str) {
    match target {
        DatabaseViewDisclosureTarget::Group { occurrence_key } => ("group", occurrence_key),
        DatabaseViewDisclosureTarget::Page { occurrence_key } => ("page", occurrence_key),
    }
}

fn disclosure_target_from_storage(
    kind: &str,
    occurrence_key: String,
) -> Result<DatabaseViewDisclosureTarget, StoreError> {
    match kind {
        "group" => Ok(DatabaseViewDisclosureTarget::Group { occurrence_key }),
        "page" => Ok(DatabaseViewDisclosureTarget::Page { occurrence_key }),
        _ => Err(corrupt("Database View disclosure target kind is invalid")),
    }
}

/// Shared semantic validation for durable Views and transient Data Source queries.
pub(super) fn validate_view_definition(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    definition: &DatabaseViewDefinition,
    library_scope: bool,
) -> Result<(), StoreError> {
    let mut filter_ids = HashSet::new();
    for filter in &definition.rules.property_filters {
        validate_id(&filter.filter_id, "filter_id", MAX_ID_LENGTH)?;
        if !filter_ids.insert(filter.filter_id.as_str()) {
            return Err(invalid("Database View property filter identities repeat"));
        }
        if !matches!(filter.clause, DatabaseViewFilter::Clause { .. }) {
            return Err(invalid(
                "Database View property filter must contain one clause",
            ));
        }
        validate_view_filter(&filter.clause, 0, &mut 0)?;
    }
    if let Some(filter) = &definition.rules.advanced_filter {
        if !matches!(filter, DatabaseViewFilter::Group { .. }) {
            return Err(invalid("Database View advanced filter must be a group"));
        }
        validate_view_filter(filter, 0, &mut 0)?;
    }
    if definition.rules.sorts.len() > MAX_VIEW_SORT_RULES {
        return Err(invalid("Database View sort exceeds its bound"));
    }
    let mut sort_fields = HashSet::new();
    for sort in &definition.rules.sorts {
        let identity = match &sort.field {
            DatabaseViewSortField::Manual => "manual".to_owned(),
            DatabaseViewSortField::Title => "title".to_owned(),
            DatabaseViewSortField::Created => "created".to_owned(),
            DatabaseViewSortField::Property { property_id } => format!("property:{property_id}"),
        };
        if !sort_fields.insert(identity) {
            return Err(invalid("Database View sort fields repeat"));
        }
    }
    if definition.presentation.conditional_colors.len() > 32 {
        return Err(invalid(
            "Database View conditional colors exceed their bound",
        ));
    }
    let mut conditional_color_ids = HashSet::new();
    for rule in &definition.presentation.conditional_colors {
        validate_id(&rule.rule_id, "conditional_color_rule_id", MAX_ID_LENGTH)?;
        if !conditional_color_ids.insert(rule.rule_id.as_str()) {
            return Err(invalid("Database View conditional color identities repeat"));
        }
        let requires_value = !matches!(
            rule.operator,
            ViewFilterOperator::IsEmpty | ViewFilterOperator::IsNotEmpty
        );
        if requires_value != rule.value.is_some() {
            return Err(invalid(
                "Database View conditional color has invalid value arity",
            ));
        }
    }
    if view_group_property(definition).is_some()
        && view_group_property(definition) == view_subgroup_property(definition)
    {
        return Err(invalid(
            "Database View group and subgroup must be different",
        ));
    }
    if !definition.presentation.hierarchy.show_sub_pages
        && definition.presentation.hierarchy.nested_sub_pages
    {
        return Err(invalid("Database View hierarchy policy is invalid"));
    }
    {
        let layout = &definition.presentation.display;
        if layout.fields.len() > MAX_VIEW_DISPLAY_PROPERTIES {
            return Err(invalid("Database View layout display is invalid"));
        }
        if layout.property_order.len() > super::MAX_DATA_SOURCE_PROPERTIES {
            return Err(invalid("Database View Property order is invalid"));
        }
        let mut identities = HashSet::new();
        for field in &layout.fields {
            let identity = match field {
                DatabaseViewField::Property { property_id } => format!("property:{property_id}"),
                DatabaseViewField::Intrinsic { field } => match field {
                    DatabaseViewIntrinsicField::PageKey => "intrinsic:page_key".to_owned(),
                    DatabaseViewIntrinsicField::CreatedAt => "intrinsic:created_at".to_owned(),
                    DatabaseViewIntrinsicField::UpdatedAt => "intrinsic:updated_at".to_owned(),
                },
            };
            if !identities.insert(identity) {
                return Err(invalid("Database View layout fields contain duplicates"));
            }
        }
        let mut ordered_properties = HashSet::new();
        for property_id in &layout.property_order {
            validate_id(property_id, "property_id", MAX_PROPERTY_ID_LENGTH)?;
            if !ordered_properties.insert(property_id) {
                return Err(invalid("Database View Property order contains duplicates"));
            }
        }
    }
    let property_ids = collect_view_property_ids(definition);
    let property_records = connection
        .prepare(
            "SELECT id, value_type FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active'",
        )?
        .query_map([data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut property_semantics = BTreeMap::new();
    for (property_id, value_type) in property_records {
        let schema = super::property_semantics::schema_from_storage(
            connection,
            data_source_id,
            &property_id,
            &value_type,
        )?;
        let capabilities = super::property_semantics::capabilities(&schema);
        property_semantics.insert(
            property_id,
            ViewPropertySemantics {
                schema,
                capabilities,
            },
        );
    }
    if !property_ids
        .iter()
        .all(|property_id| property_semantics.contains_key(property_id))
    {
        return Err(invalid(
            "Database View references a missing Data Source Property",
        ));
    }
    validate_view_property_capabilities(
        connection,
        library_id,
        project_id,
        data_source_id,
        definition,
        &property_semantics,
        library_scope,
    )
}

struct ViewPropertySemantics {
    schema: DatabasePropertySchema,
    capabilities: DatabasePropertyCapabilities,
}

fn validate_view_property_capabilities(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    data_source_id: &str,
    definition: &DatabaseViewDefinition,
    property_semantics: &BTreeMap<String, ViewPropertySemantics>,
    library_scope: bool,
) -> Result<(), StoreError> {
    let filter_context = FilterCapabilityContext {
        connection,
        library_id,
        project_id,
        data_source_id,
        property_semantics,
        library_scope,
    };
    if [
        view_group_property(definition),
        view_subgroup_property(definition),
    ]
    .into_iter()
    .flatten()
    .any(|property_id| {
        property_semantics
            .get(property_id)
            .is_some_and(|property| !property.capabilities.groupable)
    }) {
        return Err(invalid("Property cannot group a Database View"));
    }
    for rule in &definition.rules.sorts {
        let DatabaseViewSortField::Property { property_id } = &rule.field else {
            continue;
        };
        if property_semantics
            .get(property_id)
            .is_some_and(|property| !property.capabilities.sortable)
        {
            return Err(invalid("Property cannot sort a Database View"));
        }
    }
    for rule in &definition.presentation.conditional_colors {
        let property = property_semantics.get(&rule.property_id).ok_or_else(|| {
            invalid("Database View conditional color references a missing Property")
        })?;
        let operator = conditional_filter_operator(rule.operator, &property.schema)?;
        if rule.color_source == DatabaseViewConditionalColorSource::PropertyOption
            && (!matches!(
                property.schema,
                DatabasePropertySchema::Select | DatabasePropertySchema::MultiSelect
            ) || operator == ViewFilterOperator::IsEmpty)
        {
            return Err(invalid(
                "Conditional color can only match a populated option Property",
            ));
        }
        validate_filter_capabilities(
            &filter_context,
            &DatabaseViewFilter::Clause {
                property_id: rule.property_id.clone(),
                operator,
                value: rule.value.clone().map(Some),
            },
            false,
        )?;
    }
    for filter in &definition.rules.property_filters {
        validate_filter_capabilities(&filter_context, &filter.clause, true)?;
    }
    if let Some(filter) = &definition.rules.advanced_filter {
        validate_filter_capabilities(&filter_context, filter, true)?;
    }
    Ok(())
}

struct FilterCapabilityContext<'a> {
    connection: &'a Connection,
    library_id: &'a str,
    project_id: &'a str,
    data_source_id: &'a str,
    property_semantics: &'a BTreeMap<String, ViewPropertySemantics>,
    library_scope: bool,
}

fn validate_filter_capabilities(
    context: &FilterCapabilityContext<'_>,
    filter: &DatabaseViewFilter,
    allow_empty_value: bool,
) -> Result<(), StoreError> {
    let DatabaseViewFilter::Clause {
        property_id,
        operator,
        value,
    } = filter
    else {
        let DatabaseViewFilter::Group { children, .. } = filter else {
            unreachable!("Database View filter variants are exhaustive")
        };
        for child in children {
            validate_filter_capabilities(context, child, allow_empty_value)?;
        }
        return Ok(());
    };
    let property = context
        .property_semantics
        .get(property_id)
        .ok_or_else(|| invalid("Database View filter references a missing Property"))?;
    if !property.capabilities.filter_operators.contains(operator) {
        return Err(invalid("Property filter operator is unsupported"));
    }
    let value = value.as_ref().and_then(Option::as_ref);
    if allow_empty_value && super::view_contract::filter_value_is_empty(*operator, value) {
        return Ok(());
    }
    if property_id == super::property_semantics::PRIORITY_PROPERTY_ID
        && matches!(
            operator,
            ViewFilterOperator::SelectIs | ViewFilterOperator::SelectIsNot
        )
        && !value
            .and_then(Value::as_str)
            .is_some_and(super::property_semantics::is_priority_option_id)
    {
        return Err(invalid("Priority filter references a noncanonical option"));
    }
    if !filter_value_matches_operator(*operator, value) {
        return Err(invalid("Property filter value does not match its operator"));
    }
    if matches!(property.schema, DatabasePropertySchema::Relation { .. })
        && matches!(
            operator,
            ViewFilterOperator::RelationContains | ViewFilterOperator::RelationDoesNotContain
        )
    {
        let page_ids = filter_identity_values(value)?;
        let target_data_source_id = super::relation::target_data_source_id(
            context.connection,
            context.data_source_id,
            property_id,
        )?;
        authorize_relation_target_read(
            context.connection,
            context.library_id,
            context.project_id,
            &target_data_source_id,
            context.library_scope,
        )?;
        if !context.library_scope {
            for page_id in &page_ids {
                crate::library::require_page_read_access(
                    context.connection,
                    context.library_id,
                    context.project_id,
                    page_id,
                )?;
            }
        }
        super::relation::validate_active_targets(
            context.connection,
            &target_data_source_id,
            &page_ids,
        )?;
    }
    Ok(())
}

fn conditional_filter_operator(
    operator: ViewFilterOperator,
    schema: &DatabasePropertySchema,
) -> Result<ViewFilterOperator, StoreError> {
    use DatabasePropertySchema as Schema;
    use ViewFilterOperator as Typed;

    let typed = match operator {
        Typed::Equals => match schema {
            Schema::Text => Typed::TextIs,
            Schema::Number { .. } => Typed::NumberEquals,
            Schema::Checkbox => Typed::CheckboxIs,
            Schema::Select => Typed::SelectIs,
            Schema::Date { .. } | Schema::Datetime { .. } => Typed::DateIs,
            _ => {
                return Err(invalid(
                    "Conditional color operator is unsupported for its Property",
                ));
            }
        },
        Typed::NotEquals => match schema {
            Schema::Text => Typed::TextIsNot,
            Schema::Number { .. } => Typed::NumberDoesNotEqual,
            Schema::Checkbox => Typed::CheckboxIsNot,
            Schema::Select => Typed::SelectIsNot,
            Schema::Date { .. } | Schema::Datetime { .. } => Typed::DateIsNot,
            _ => {
                return Err(invalid(
                    "Conditional color operator is unsupported for its Property",
                ));
            }
        },
        Typed::Contains => match schema {
            Schema::Text => Typed::TextContains,
            Schema::MultiSelect => Typed::MultiSelectContains,
            Schema::Relation { .. } => Typed::RelationContains,
            _ => {
                return Err(invalid(
                    "Conditional color operator is unsupported for its Property",
                ));
            }
        },
        Typed::NotContains => match schema {
            Schema::Text => Typed::TextDoesNotContain,
            Schema::MultiSelect => Typed::MultiSelectDoesNotContain,
            Schema::Relation { .. } => Typed::RelationDoesNotContain,
            _ => {
                return Err(invalid(
                    "Conditional color operator is unsupported for its Property",
                ));
            }
        },
        typed => typed,
    };
    Ok(typed)
}

fn filter_value_matches_operator(operator: ViewFilterOperator, value: Option<&Value>) -> bool {
    use ViewFilterOperator as Operator;

    match operator {
        Operator::IsEmpty | Operator::IsNotEmpty => value.is_none(),
        Operator::TextIs
        | Operator::TextIsNot
        | Operator::TextContains
        | Operator::TextDoesNotContain
        | Operator::TextStartsWith
        | Operator::TextEndsWith
        | Operator::DateIs
        | Operator::DateIsNot
        | Operator::DateBefore
        | Operator::DateAfter
        | Operator::DateOnOrBefore
        | Operator::DateOnOrAfter => value.is_some_and(Value::is_string),
        Operator::NumberEquals
        | Operator::NumberDoesNotEqual
        | Operator::NumberGreaterThan
        | Operator::NumberLessThan
        | Operator::NumberGreaterThanOrEqualTo
        | Operator::NumberLessThanOrEqualTo => value.is_some_and(Value::is_number),
        Operator::CheckboxIs | Operator::CheckboxIsNot => value.is_some_and(Value::is_boolean),
        Operator::SelectIs | Operator::SelectIsNot => value
            .and_then(Value::as_str)
            .is_some_and(|identity| !identity.is_empty()),
        Operator::MultiSelectContains
        | Operator::MultiSelectDoesNotContain
        | Operator::MultiSelectContainsAll
        | Operator::RelationContains
        | Operator::RelationDoesNotContain => value
            .and_then(Value::as_array)
            .filter(|values| !values.is_empty())
            .is_some_and(|values| {
                values
                    .iter()
                    .all(|value| value.as_str().is_some_and(|identity| !identity.is_empty()))
            }),
        Operator::DateWithin => value.is_some_and(|value| {
            value.get("start").is_some_and(Value::is_string)
                && value.get("end").is_some_and(Value::is_string)
        }),
        Operator::DateRelativeTo => value.is_some_and(|value| {
            value
                .get("direction")
                .and_then(Value::as_str)
                .is_some_and(|direction| matches!(direction, "past" | "future"))
                && value
                    .get("count")
                    .and_then(Value::as_u64)
                    .is_some_and(|count| count > 0 && count <= 10_000)
                && value
                    .get("unit")
                    .and_then(Value::as_str)
                    .is_some_and(|unit| matches!(unit, "day" | "week" | "month" | "year"))
        }),
        Operator::Equals | Operator::NotEquals | Operator::Contains | Operator::NotContains => {
            false
        }
    }
}

fn filter_identity_values(value: Option<&Value>) -> Result<Vec<String>, StoreError> {
    let Some(value) = value else {
        return Err(invalid("Property membership filter requires an identity"));
    };
    if let Some(identity) = value.as_str().filter(|identity| !identity.is_empty()) {
        return Ok(vec![identity.to_owned()]);
    }
    let identities = value
        .as_array()
        .filter(|values| !values.is_empty())
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().filter(|identity| !identity.is_empty()))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(|| invalid("Property membership filter requires identities"))?;
    Ok(identities.into_iter().map(str::to_owned).collect())
}

fn validate_view_filter(
    filter: &DatabaseViewFilter,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), StoreError> {
    if depth > 8 || *nodes >= 1_024 {
        return Err(invalid("Database View filter exceeds its structural bound"));
    }
    *nodes += 1;
    match filter {
        DatabaseViewFilter::Group { children, .. } => {
            for child in children {
                validate_view_filter(child, depth + 1, nodes)?;
            }
        }
        DatabaseViewFilter::Clause {
            operator, value, ..
        } => {
            let requires_value = !matches!(
                operator,
                ViewFilterOperator::IsEmpty | ViewFilterOperator::IsNotEmpty
            );
            if requires_value != value.is_some() {
                return Err(invalid("Database View filter has invalid value arity"));
            }
        }
    }
    Ok(())
}

fn collect_view_property_ids(definition: &DatabaseViewDefinition) -> HashSet<String> {
    let mut property_ids = HashSet::new();
    for property_id in [
        view_group_property(definition),
        view_subgroup_property(definition),
    ]
    .into_iter()
    .flatten()
    {
        property_ids.insert(property_id.to_owned());
    }
    {
        let layout = &definition.presentation.display;
        for field in &layout.fields {
            if let DatabaseViewField::Property { property_id } = field {
                property_ids.insert(property_id.to_owned());
            }
        }
    }
    for rule in &definition.rules.sorts {
        if let DatabaseViewSortField::Property { property_id } = &rule.field {
            property_ids.insert(property_id.to_owned());
        }
    }
    for rule in &definition.presentation.conditional_colors {
        property_ids.insert(rule.property_id.clone());
    }
    for filter in &definition.rules.property_filters {
        collect_filter_property_ids(&filter.clause, &mut property_ids);
    }
    if let Some(filter) = &definition.rules.advanced_filter {
        collect_filter_property_ids(filter, &mut property_ids);
    }
    property_ids
}

fn collect_filter_property_ids(filter: &DatabaseViewFilter, property_ids: &mut HashSet<String>) {
    match filter {
        DatabaseViewFilter::Group { children, .. } => {
            for child in children {
                collect_filter_property_ids(child, property_ids);
            }
        }
        DatabaseViewFilter::Clause { property_id, .. } => {
            property_ids.insert(property_id.to_owned());
        }
    }
}

fn view_group_property(definition: &DatabaseViewDefinition) -> Option<&str> {
    definition
        .presentation
        .group
        .as_ref()
        .map(|group| group.property_id.as_str())
}

fn view_subgroup_property(definition: &DatabaseViewDefinition) -> Option<&str> {
    definition
        .presentation
        .subgroup
        .as_ref()
        .map(|group| group.property_id.as_str())
}

fn view_fractional_direction(definition: &DatabaseViewDefinition) -> DatabaseViewSortDirection {
    super::view_contract::fractional_order_direction(&definition.rules.sorts)
        .unwrap_or(DatabaseViewSortDirection::Asc)
}

fn active_row_membership(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT membership.id FROM data_source_page_memberships membership \
             JOIN pages page ON page.block_id = membership.page_block_id \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id \
             WHERE membership.data_source_id = ?1 AND membership.page_block_id = ?2 \
               AND membership.removed_at IS NULL AND page.parent_kind = 'data_source' \
               AND page.parent_id = ?1 AND block.lifecycle = 'active'",
            params![data_source_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Page is not an active row in the View Data Source"))
}

fn reorder_views(
    connection: &Connection,
    database_id: &str,
    view_id: &str,
    before_view_id: Option<&str>,
) -> Result<(), StoreError> {
    let items = connection
        .prepare(
            "SELECT id, rank_key FROM database_views WHERE database_block_id = ?1 \
             AND lifecycle = 'active' ORDER BY rank_key, id",
        )?
        .query_map([database_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(&items, view_id, before_view_id)
        .map_err(|error| rank_plan_error(error, "Database View placement anchor changed"))?;
    for (id, rank_key) in plan.rebalanced_rank_keys {
        connection.execute(
            "UPDATE database_views SET rank_key = ?1 WHERE database_block_id = ?2 AND id = ?3",
            params![rank_key, database_id, id],
        )?;
    }
    connection.execute(
        "UPDATE database_views SET rank_key = ?1 WHERE database_block_id = ?2 AND id = ?3",
        params![plan.rank_key, database_id, view_id],
    )?;
    Ok(())
}

fn clear_view_projection(
    connection: &Connection,
    view_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE page_read_model SET view_id = NULL, view_group_key = NULL, view_rank_key = NULL, \
           projection_version = projection_version + 1, updated_at = ?1 WHERE view_id = ?2",
        params![now, view_id],
    )?;
    Ok(())
}

fn refresh_default_view_projection(
    connection: &Connection,
    database_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let default_view = connection
        .query_row(
            "SELECT view.id, view.data_source_id, view.config_json FROM database_containers container \
             JOIN database_views view ON view.id = container.default_view_id \
             WHERE container.block_id = ?1 AND view.lifecycle = 'active'",
            [database_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let projections = connection
        .prepare(
            "SELECT projection.page_block_id, membership.data_source_id \
             FROM page_read_model projection \
             LEFT JOIN data_source_page_memberships membership \
               ON membership.id = projection.membership_id AND membership.removed_at IS NULL \
             WHERE projection.database_block_id = ?1 ORDER BY projection.page_block_id",
        )?
        .query_map([database_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (page_id, data_source_id) in projections {
        let uses_default = default_view
            .as_ref()
            .is_some_and(|(_, source_id, _)| data_source_id.as_deref() == Some(source_id));
        let position = if uses_default {
            connection
                .query_row(
                    "SELECT rank_key FROM database_view_page_positions \
                     WHERE view_id = ?1 AND page_block_id = ?2",
                    params![default_view.as_ref().map(|(id, _, _)| id), page_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            None
        };
        connection.execute(
            "UPDATE page_read_model SET view_id = ?1, view_group_key = ?2, view_rank_key = ?3, \
               projection_version = projection_version + 1, updated_at = ?4 \
             WHERE page_block_id = ?5",
            params![
                uses_default
                    .then(|| default_view.as_ref().map(|(id, _, _)| id))
                    .flatten(),
                if uses_default {
                    let (_, source_id, config_json) = default_view.as_ref().ok_or_else(|| {
                        corrupt("Default Database View projection is unavailable")
                    })?;
                    let definition = super::view_contract::decode_definition_json(config_json)
                        .map_err(corrupt)?;
                    derived_view_group_key(connection, source_id, &page_id, &definition)?
                } else {
                    None
                },
                position,
                now,
                page_id,
            ],
        )?;
    }
    Ok(())
}

fn require_container(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<ContainerRow, StoreError> {
    connection
        .query_row(
            "SELECT default_view_id, lifecycle FROM database_containers \
             WHERE block_id = ?1 AND library_id = ?2",
            params![database_id, library_id],
            |row| {
                Ok(ContainerRow {
                    default_view_id: row.get(0)?,
                    lifecycle: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Database is unavailable"))
}

fn view_row(connection: &Connection, view_id: &str) -> Result<Option<ViewRow>, StoreError> {
    connection
        .query_row(
            "SELECT id, database_block_id, data_source_id, name, layout, config_json, rank_key, \
               lifecycle, revision, created_at FROM database_views WHERE id = ?1",
            [view_id],
            |row| {
                Ok(ViewRow {
                    id: row.get(0)?,
                    database_id: row.get(1)?,
                    data_source_id: row.get(2)?,
                    name: row.get(3)?,
                    layout: row.get(4)?,
                    config_json: row.get(5)?,
                    rank_key: row.get(6)?,
                    lifecycle: row.get(7)?,
                    revision: row.get(8)?,
                    created_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

fn property_config_for_put(
    property_id: &str,
    schema: &DatabasePropertySchema,
    existing: Option<&PropertyRow>,
) -> Result<Value, StoreError> {
    let value_type = super::property_semantics::value_type(schema);
    if let Some(existing) = existing {
        if existing.value_type != value_type {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Property schema is immutable",
                false,
            ));
        }
        if matches!(value_type, "select" | "multi_select") {
            return serde_json::to_value(super::property_semantics::option_config_from_storage(
                property_id,
                value_type,
                &existing.config_json,
            )?)
            .map_err(|_| internal("Property option registry"));
        }
        match schema {
            DatabasePropertySchema::Number { format } => {
                return Ok(json!({ "format": format }));
            }
            DatabasePropertySchema::Date { date_format } => {
                return Ok(json!({ "date_format": date_format }));
            }
            DatabasePropertySchema::Datetime {
                date_format,
                time_format,
            } => {
                return Ok(json!({
                    "date_format": date_format,
                    "time_format": time_format,
                }));
            }
            _ => {}
        }
        let config = parse_json(&existing.config_json, "Property config")?;
        if config.as_object().is_none_or(|config| !config.is_empty()) {
            return Err(corrupt("Property config is not the canonical empty object"));
        }
        return Ok(config);
    }
    if matches!(value_type, "select" | "multi_select") {
        return Ok(json!({ "options": [] }));
    }
    match schema {
        DatabasePropertySchema::Number { format } => Ok(json!({ "format": format })),
        DatabasePropertySchema::Date { date_format } => Ok(json!({ "date_format": date_format })),
        DatabasePropertySchema::Datetime {
            date_format,
            time_format,
        } => Ok(json!({
            "date_format": date_format,
            "time_format": time_format,
        })),
        _ => Ok(json!({})),
    }
}

fn reorder_properties(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
    before_property_id: Option<&str>,
) -> Result<(), StoreError> {
    let items = connection
        .prepare(
            "SELECT id, rank_key FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY rank_key, id",
        )?
        .query_map([data_source_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(&items, property_id, before_property_id)
        .map_err(|error| rank_plan_error(error, "Property placement anchor changed"))?;
    let mut update = connection.prepare(
        "UPDATE data_source_properties SET rank_key = ?1 \
         WHERE data_source_id = ?2 AND id = ?3",
    )?;
    for (id, rank_key) in plan.rebalanced_rank_keys {
        update.execute(params![rank_key, data_source_id, id])?;
    }
    update.execute(params![plan.rank_key, data_source_id, property_id])?;
    Ok(())
}

fn reorder_page_layout_entries(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
    placement: &DatabasePageLayoutPlacement,
) -> Result<(), StoreError> {
    let items = connection
        .prepare(
            "SELECT entry.property_id, entry.rank_key \
             FROM data_source_page_layout_entries entry \
             JOIN data_source_properties property \
               ON property.data_source_id = entry.data_source_id \
              AND property.id = entry.property_id \
             WHERE entry.data_source_id = ?1 AND property.lifecycle = 'active' \
             ORDER BY entry.rank_key, entry.property_id",
        )?
        .query_map([data_source_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let before_property_id = match placement {
        DatabasePageLayoutPlacement::Before { property_id } => Some(property_id.as_str()),
        DatabasePageLayoutPlacement::End => None,
    };
    let plan = plan_fractional_rank(&items, property_id, before_property_id)
        .map_err(|error| rank_plan_error(error, "Page layout placement anchor changed"))?;
    let mut update = connection.prepare(
        "UPDATE data_source_page_layout_entries SET rank_key = ?1 \
         WHERE data_source_id = ?2 AND property_id = ?3",
    )?;
    for (id, rank_key) in plan.rebalanced_rank_keys {
        update.execute(params![rank_key, data_source_id, id])?;
    }
    update.execute(params![plan.rank_key, data_source_id, property_id])?;
    Ok(())
}

fn rank_plan_error(error: FractionalRankError, anchor_message: &str) -> StoreError {
    match error.code {
        FractionalRankErrorCode::AnchorNotFound => {
            StoreError::new(StoreErrorCode::RevisionConflict, anchor_message, true)
        }
        FractionalRankErrorCode::RebalanceLimit => invalid(&error.message),
    }
}

fn ensure_collection_capacity(
    active_count: i64,
    maximum: usize,
    label: &str,
) -> Result<(), StoreError> {
    if active_count < i64::try_from(maximum).unwrap_or(i64::MAX) {
        return Ok(());
    }
    Err(invalid(format!("{label} exceeds its fixed bound")))
}

fn active_view_references_property(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<bool, StoreError> {
    let configs = connection
        .prepare(
            "SELECT config_json FROM database_views \
             WHERE data_source_id = ?1 AND lifecycle = 'active'",
        )?
        .query_map([data_source_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for config in configs {
        let definition = super::view_contract::decode_definition_json(&config).map_err(corrupt)?;
        if collect_view_property_ids(&definition).contains(property_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn active_page_schedule_value(
    connection: &Connection,
    page_id: &str,
    property_id: &str,
) -> Result<Option<String>, StoreError> {
    let value_json = connection
        .query_row(
            "SELECT value.value_json FROM pages page \
             JOIN data_source_page_memberships membership \
               ON membership.page_block_id = page.block_id \
               AND membership.data_source_id = page.parent_id \
               AND membership.removed_at IS NULL \
             JOIN data_source_properties property \
               ON property.data_source_id = membership.data_source_id \
               AND property.id = ?2 AND property.lifecycle = 'active' \
             LEFT JOIN data_source_property_values value \
               ON value.data_source_id = membership.data_source_id \
               AND value.membership_id = membership.id \
               AND value.property_id = property.id \
             WHERE page.block_id = ?1 AND page.parent_kind = 'data_source' \
             LIMIT 1",
            params![page_id, property_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(value_json) = value_json else {
        return Ok(None);
    };
    let value = parse_json(&value_json, "Scheduled Page Property value")?;
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| corrupt("Scheduled Page Property value is not a string"))
}

fn refresh_scheduled_page_indexes(
    connection: &Connection,
    page_ids: &BTreeSet<String>,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in page_ids {
        let scheduled_start = active_page_schedule_value(connection, page_id, "scheduled_start")?;
        let scheduled_end = active_page_schedule_value(connection, page_id, "scheduled_end")?;
        let authority = connection
            .query_row(
                "SELECT metadata_revision, lifecycle FROM blocks WHERE id = ?1 AND type = 'page'",
                [page_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((metadata_revision, lifecycle)) = authority else {
            continue;
        };
        connection.execute(
            "UPDATE scheduled_page_index SET lifecycle = ?1, scheduled_start = ?2, scheduled_end = ?3, \
               is_all_day = CASE WHEN ?2 IS NOT NULL AND ?3 IS NOT NULL \
                 THEN is_all_day ELSE 0 END, source_metadata_revision = ?4, updated_at = ?5 \
             WHERE page_block_id = ?6",
            params![
                lifecycle,
                scheduled_start,
                scheduled_end,
                metadata_revision,
                now,
                page_id
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn repair_scheduled_page_indexes(
    connection: &Connection,
    now: &str,
) -> Result<usize, StoreError> {
    let page_ids = connection
        .prepare("SELECT page_block_id FROM scheduled_page_index ORDER BY page_block_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let repaired = page_ids.len();
    refresh_scheduled_page_indexes(connection, &page_ids, now)?;
    Ok(repaired)
}

fn option_config(
    property: &PropertyRow,
) -> Result<super::property_semantics::PropertyOptionConfig, StoreError> {
    super::property_semantics::option_config_from_storage(
        &property.id,
        &property.value_type,
        &property.config_json,
    )
}

fn persist_option_config(
    connection: &Connection,
    source: &SourceRow,
    property: &PropertyRow,
    config: &super::property_semantics::PropertyOptionConfig,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE data_source_properties SET config_json = ?1, \
           schema_revision = schema_revision + 1, updated_at = ?2 \
         WHERE data_source_id = ?3 AND id = ?4",
        params![
            serde_json::to_string(config).map_err(|_| internal("Property option registry"))?,
            now,
            source.id,
            property.id,
        ],
    )?;
    connection.execute(
        "UPDATE data_sources SET schema_revision = schema_revision + 1, updated_at = ?1 \
         WHERE id = ?2",
        params![now, source.id],
    )?;
    Ok(())
}

pub(crate) fn normalize_value(property: &PropertyRow, value: &Value) -> Result<Value, StoreError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    match property.value_type.as_str() {
        "text" => value
            .as_str()
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("Property requires a string or null value")),
        "number" => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|_| value.clone())
            .ok_or_else(|| invalid("number requires a finite number or null value")),
        "checkbox" => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| invalid("checkbox requires a boolean or null value")),
        "date" => value
            .as_str()
            .filter(|value| valid_iso_date(value))
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("date requires a valid YYYY-MM-DD value or null")),
        "datetime" => value
            .as_str()
            .filter(|value| valid_canonical_datetime(value))
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("datetime requires a canonical UTC RFC 3339 value or null")),
        "select" => {
            let option_id = value
                .as_str()
                .ok_or_else(|| invalid("select requires an option ID or null"))?;
            let config = option_config(property)?;
            if config.options.iter().any(|option| option.id == option_id) {
                return Ok(Value::String(option_id.to_owned()));
            }
            Err(invalid("select references an unknown option"))
        }
        "multi_select" => {
            let values = value
                .as_array()
                .ok_or_else(|| invalid("multi_select requires an option ID array or null"))?;
            let config = option_config(property)?;
            let known = config
                .options
                .iter()
                .map(|option| option.id.as_str())
                .collect::<HashSet<_>>();
            let mut normalized = BTreeSet::new();
            for value in values {
                let option_id = value
                    .as_str()
                    .ok_or_else(|| invalid("multi_select contains a non-string option ID"))?;
                if !known.contains(option_id) {
                    return Err(invalid("multi_select references an unknown option"));
                }
                normalized.insert(option_id.to_owned());
            }
            Ok(Value::Array(
                normalized.into_iter().map(Value::String).collect(),
            ))
        }
        _ => Err(corrupt("Stored Property has an unsupported value type")),
    }
}

#[allow(clippy::too_many_arguments)]
fn update_grouped_view_projections(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
    page_id: &str,
    value: &Value,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    let views = connection
        .prepare(
            "SELECT id, config_json FROM database_views \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (view_id, config) in views {
        let definition = super::view_contract::decode_definition_json(&config).map_err(corrupt)?;
        if view_group_property(&definition) != Some(property_id) {
            continue;
        }
        let group_key = database_group_key(value)?;
        connection.execute(
            "UPDATE page_read_model SET view_group_key = ?1, \
               projection_version = projection_version + 1, updated_at = ?2 \
             WHERE page_block_id = ?3 AND view_id = ?4",
            params![group_key, now, page_id, view_id],
        )?;
        effects.view_ids.insert(view_id.clone());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn refresh_value_projection(
    connection: &Connection,
    page_id: &str,
    property_id: &str,
    value: &Value,
    value_revision: i64,
    metadata_revision: i64,
    property: &PropertyRow,
    now: &str,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT database_values_json, property_revisions_json \
             FROM page_read_model WHERE page_block_id = ?1",
            [page_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((values_json, revisions_json)) = row else {
        return Ok(());
    };
    let mut values = json_object(&values_json, "Page Database values")?;
    let mut revisions = json_object(&revisions_json, "Page Property revisions")?;
    let projected_value = if property.id == "tags" {
        tag_compatibility_value(property, value)?
    } else {
        value.clone()
    };
    values.insert(property_id.to_owned(), projected_value);
    let database = revisions
        .entry("database".to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| corrupt("Page Database revision projection is not an object"))?;
    database.insert(property_id.to_owned(), Value::from(value_revision));
    connection.execute(
        "UPDATE page_read_model SET metadata_revision = ?1, database_values_json = ?2, \
           property_revisions_json = ?3, projection_version = projection_version + 1, \
           updated_at = ?4 WHERE page_block_id = ?5",
        params![
            metadata_revision,
            serde_json::to_string(&values).map_err(|_| internal("Page Database values"))?,
            serde_json::to_string(&revisions).map_err(|_| internal("Page Property revisions"))?,
            now,
            page_id,
        ],
    )?;
    Ok(())
}

fn refresh_tag_projections(
    connection: &Connection,
    data_source_id: &str,
    config: &super::property_semantics::PropertyOptionConfig,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    let rows = connection
        .prepare(
            "SELECT membership.page_block_id, value.value_json \
             FROM data_source_property_values value \
             JOIN data_source_page_memberships membership \
               ON membership.id = value.membership_id \
               AND membership.data_source_id = value.data_source_id \
             WHERE value.data_source_id = ?1 AND value.property_id = 'tags' \
               AND membership.removed_at IS NULL",
        )?
        .query_map([data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let names = config
        .options
        .iter()
        .map(|option| (option.id.as_str(), option.name.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    for (page_id, value_json) in rows {
        let value = parse_json(&value_json, "Tags value")?;
        let Some(option_ids) = value.as_array() else {
            return Err(corrupt("Stored tags value is not an array"));
        };
        let projected = option_ids
            .iter()
            .map(|value| {
                let option_id = value
                    .as_str()
                    .ok_or_else(|| corrupt("Stored tags option is invalid"))?;
                names
                    .get(option_id)
                    .map(|name| Value::String((*name).to_owned()))
                    .ok_or_else(|| corrupt("Stored tags value references an unknown option"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let Some(values_json) = connection
            .query_row(
                "SELECT database_values_json FROM page_read_model WHERE page_block_id = ?1",
                [&page_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            continue;
        };
        let mut values = json_object(&values_json, "Page Database values")?;
        if values.get("tags") == Some(&Value::Array(projected.clone())) {
            continue;
        }
        values.insert("tags".to_owned(), Value::Array(projected));
        let metadata_revision = bump_page_metadata_revision(connection, &page_id, now)?;
        connection.execute(
            "UPDATE page_read_model SET metadata_revision = ?1, \
               database_values_json = ?2, projection_version = projection_version + 1, \
               updated_at = ?3 WHERE page_block_id = ?4",
            params![
                metadata_revision,
                serde_json::to_string(&values).map_err(|_| internal("Page Database values"))?,
                now,
                page_id,
            ],
        )?;
        effects.page_ids.insert(page_id.clone());
        effects
            .revisions
            .insert(format!("page:{page_id}:metadata"), metadata_revision);
    }
    Ok(())
}

fn bump_page_metadata_revision(
    connection: &Connection,
    page_id: &str,
    now: &str,
) -> Result<i64, StoreError> {
    let metadata_revision = connection
        .query_row(
            "UPDATE blocks SET metadata_revision = metadata_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND type = 'page' RETURNING metadata_revision",
            params![now, page_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Database row Page disappeared during metadata commit"))?;
    Ok(metadata_revision)
}

fn tag_compatibility_value(property: &PropertyRow, value: &Value) -> Result<Value, StoreError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let config = option_config(property)?;
    let names = config
        .options
        .iter()
        .map(|option| (option.id.as_str(), option.name.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let values = value
        .as_array()
        .ok_or_else(|| corrupt("Canonical tags value is not an array"))?;
    values
        .iter()
        .map(|value| {
            let option_id = value
                .as_str()
                .ok_or_else(|| corrupt("Canonical tags option is invalid"))?;
            names
                .get(option_id)
                .map(|name| Value::String((*name).to_owned()))
                .ok_or_else(|| corrupt("Canonical tags value references an unknown option"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn database_group_key(value: &Value) -> Result<Option<String>, StoreError> {
    if value.is_null() || value.as_str() == Some("") || value.as_array().is_some_and(Vec::is_empty)
    {
        return Ok(None);
    }
    if let Some(value) = value.as_str() {
        return Ok(Some(value.to_owned()));
    }
    serde_json::to_string(value)
        .map(Some)
        .map_err(|_| internal("Database group key"))
}

#[allow(clippy::too_many_arguments)]
fn seal_commit(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    request: &ModuleApplyRequest<Vec<DatabaseIntent>>,
    request_hash: &str,
    authority: &DatabaseMutationAuthority,
    now: &str,
    effects: MutationEffects,
) -> Result<
    SealedOutcome<crate::ModuleWriterResult<DatabaseCommitValue, DatabaseReceipt>>,
    StoreError,
> {
    let connection = scope.connection();
    let store_epoch = scope.store_epoch();
    let (page_data_source_ids, page_database_ids) = page_detail_dependency_ids(&request.intent);
    let page_data_source_ids = effects
        .data_source_ids
        .intersection(&page_data_source_ids)
        .cloned()
        .collect::<Vec<_>>();
    let page_database_ids = effects
        .database_ids
        .intersection(&page_database_ids)
        .cloned()
        .collect::<Vec<_>>();
    let database_ids = effects.database_ids.into_iter().collect::<Vec<_>>();
    let data_source_ids = effects.data_source_ids.into_iter().collect::<Vec<_>>();
    let page_ids = effects.page_ids.into_iter().collect::<Vec<_>>();
    let view_ids = effects.view_ids.into_iter().collect::<Vec<_>>();
    let committed_revisions = effects.revisions;
    let operation_outcomes = effects.operation_outcomes;
    let personal_view_changes =
        effects
            .personal_preferences
            .into_iter()
            .map(|(view_id, value)| DatabasePersonalViewChange::Preferences { view_id, value })
            .chain(effects.occurrence_disclosures.into_iter().map(
                |((view_id, target), collapsed)| DatabasePersonalViewChange::OccurrenceDisclosure {
                    view_id,
                    target,
                    collapsed,
                },
            ))
            .collect::<Vec<_>>();
    let operation_kinds = request
        .intent
        .iter()
        .map(database_intent_kind)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let block_ids = page_ids
        .iter()
        .chain(&database_ids)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let payload = json!({
        "module": MODULE_NAME,
        "kind": "database_changed",
        "projectId": authority.project_id,
        "version": request.contract_version,
        "operationCount": request.intent.len(),
        "operationKinds": operation_kinds,
        "requestHash": request_hash,
        "databaseIds": database_ids,
        "dataSourceIds": data_source_ids,
        "pageIds": page_ids,
        "viewIds": view_ids,
        "personalViewChanges": personal_view_changes,
        "committedRevisions": committed_revisions,
    });
    let event_payload = CoreModuleEventPayload::Database(DatabaseEvent {
        kind: DatabaseEventKind::DatabaseChanged,
        project_id: authority.project_id.clone(),
        database_ids: database_ids.clone(),
        data_source_ids: data_source_ids.clone(),
        page_ids: page_ids.clone(),
        view_ids: view_ids.clone(),
        personal_view_changes: personal_view_changes.clone(),
    });
    let projection_impact =
        expand_database_coordinates(connection, impact_for_payload(&event_payload)?)?;
    let payload_json =
        serde_json::to_string(&payload).map_err(|_| internal("Database event payload"))?;
    let authorization_before = scope.authorization_before()?;
    super::record_local_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &projection_impact,
        &authorization_before,
    )?;
    super::record_page_detail_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &page_data_source_ids,
        &page_database_ids,
    )?;
    let event_sequence = append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: &authority.actor_project_id,
            store_epoch,
            kind: "database.changed",
            operation_id: Some(&request.operation_id),
            block_ids: &block_ids,
            document_ids: &[],
            database_block_ids: &database_ids,
            payload_json: &payload_json,
            projection_impact: &projection_impact,
            committed_at: now,
        },
        scope.evidence(),
    )?;
    let receipt = DatabaseReceipt {
        mutation: ModuleMutationReceipt {
            operation_id: request.operation_id.clone(),
            duplicate: false,
        },
        affected_database_ids: database_ids.clone(),
        affected_data_source_ids: data_source_ids.clone(),
        affected_page_ids: page_ids.clone(),
        affected_view_ids: view_ids.clone(),
        operation_kinds,
        operation_outcomes,
        committed_revisions,
        commit_seq: scope.commit_seq(),
        committed_at: now.to_owned(),
    };
    let committed = crate::ModuleWriterResult {
        value: DatabaseCommitValue {
            operation_count: u32::try_from(request.intent.len())
                .map_err(|_| internal("Database operation count"))?,
        },
        receipt,
        commit_seq: scope.commit_seq(),
        event_sequence,
        store_epoch: StoreEpoch(store_epoch.to_owned()),
    };
    Ok(scope.seal(
        committed,
        ReceiptMetadata {
            operation_kind: "apply",
            event_sequence: Some(event_sequence),
            committed_at: now,
        },
    ))
}

fn require_source(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<SourceRow, StoreError> {
    let source = connection
        .query_row(
            "SELECT id, home_database_block_id, lifecycle, schema_revision \
             FROM data_sources WHERE id = ?1 AND library_id = ?2",
            params![data_source_id, library_id],
            |row| {
                Ok(SourceRow {
                    id: row.get(0)?,
                    database_id: row.get(1)?,
                    lifecycle: row.get(2)?,
                    revision: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Data Source is unavailable"))?;
    if source.lifecycle != "active" {
        return Err(not_found("Data Source is not active"));
    }
    Ok(source)
}

fn authorize_relation_target_read(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    target_data_source_id: &str,
    library_scope: bool,
) -> Result<(), StoreError> {
    let target = require_source(connection, library_id, target_data_source_id)?;
    if library_scope {
        return Ok(());
    }
    let primary =
        super::authorization::project_primary_database(connection, library_id, project_id)?;
    if super::authorization::authorize_database(
        connection,
        project_id,
        primary.as_deref(),
        &target.database_id,
    )? {
        return Ok(());
    }
    Err(not_found("Relation target is unavailable"))
}

fn property_row(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<Option<PropertyRow>, StoreError> {
    connection
        .query_row(
            "SELECT id, name, value_type, config_json, rank_key, lifecycle, schema_revision, created_at \
             FROM data_source_properties WHERE data_source_id = ?1 AND id = ?2",
            params![data_source_id, property_id],
            |row| {
                Ok(PropertyRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    value_type: row.get(2)?,
                    config_json: row.get(3)?,
                    rank_key: row.get(4)?,
                    lifecycle: row.get(5)?,
                    revision: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn active_property(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<PropertyRow, StoreError> {
    let property = property_row(connection, data_source_id, property_id)?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    if property.lifecycle != "active" {
        return Err(not_found("Property is not active"));
    }
    Ok(property)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DatabaseWriteAction {
    Write,
    ManageSchema,
    ManageViews,
    ManageNamespace,
}

fn authorize_write(
    connection: &Connection,
    project_id: &str,
    database_id: &str,
    action: DatabaseWriteAction,
    library_scope: bool,
) -> Result<(), StoreError> {
    if library_scope {
        return Ok(());
    }
    let project = connection
        .query_row(
            "SELECT database_block_id, lifecycle FROM projects WHERE id = ?1",
            [project_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| unauthorized("Project is unavailable"))?;
    if project.1 != "active" {
        return Err(unauthorized("Project is read-only"));
    }
    let primary = project.0.or(connection
        .query_row(
            "SELECT database_block_id FROM project_database_bindings \
                 WHERE project_id = ?1 AND lifecycle = 'active'",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?);
    if primary.as_deref() == Some(database_id) {
        return Ok(());
    }
    if action != DatabaseWriteAction::Write {
        return Err(unauthorized(
            "Database administration requires the Project's primary Database",
        ));
    }
    let direct = connection
        .query_row(
            "SELECT 1 FROM project_resource_grants WHERE project_id = ?1 \
             AND root_kind = 'database' AND root_id = ?2 AND access = 'read_write' \
             AND lifecycle = 'active'",
            params![project_id, database_id],
            |_| Ok(()),
        )
        .optional()?;
    if direct.is_some() {
        return Ok(());
    }
    let document_id = connection
        .query_row(
            "SELECT containing.document_id FROM blocks block \
             JOIN document_block_index containing ON containing.block_id = block.id \
             WHERE block.id = ?1 AND block.type = 'database'",
            [database_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(document_id) = document_id else {
        return Err(unauthorized("Project cannot mutate this Database"));
    };
    let owner_page_id = connection
        .query_row(
            "SELECT page.block_id FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.document_id = ?1 AND block.lifecycle <> 'deleted'",
            [document_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Embedded Database has no owning Page"))?;
    let inherited = connection
        .query_row(
            "WITH RECURSIVE ancestors(page_id) AS (\
               SELECT ?2 UNION ALL SELECT page.parent_id FROM pages page JOIN ancestors current \
                 ON page.block_id = current.page_id WHERE page.parent_kind = 'page'\
             ) SELECT 1 FROM project_resource_grants grant_row JOIN ancestors \
               ON grant_row.root_id = ancestors.page_id \
             WHERE grant_row.project_id = ?1 AND grant_row.root_kind = 'page' \
               AND grant_row.access = 'read_write' AND grant_row.lifecycle = 'active' LIMIT 1",
            params![project_id, owner_page_id],
            |_| Ok(()),
        )
        .optional()?;
    if inherited.is_some() {
        return Ok(());
    }
    Err(unauthorized("Project cannot mutate this Database"))
}

fn mutation_authority(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
) -> Result<DatabaseMutationAuthority, StoreError> {
    if let Some(project_id) = context.project_id.as_ref() {
        let project_id = connection
            .query_row(
                "SELECT id FROM projects \
                 WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                params![project_id.0, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| unauthorized("Bound Project is not active in this Library"))?;
        return Ok(DatabaseMutationAuthority {
            actor_project_id: project_id.clone(),
            project_id: Some(project_id),
        });
    }
    if !is_trusted_library_database_context(context) {
        return Err(unauthorized(
            "Database mutations require a Project or trusted Library scope",
        ));
    }
    let actor_project_id =
        crate::library::resolve_library_actor_project_id(connection, library_id)?;
    Ok(DatabaseMutationAuthority {
        actor_project_id,
        project_id: None,
    })
}

fn assert_identity(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let valid = connection
        .query_row(
            "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
            params![library_id, profile_id],
            |_| Ok(()),
        )
        .optional()?;
    if valid.is_some() {
        return Ok(());
    }
    Err(unauthorized(
        "bound Database identity is not present in this Profile store",
    ))
}

fn touch_source(effects: &mut MutationEffects, source: &SourceRow) {
    effects.database_ids.insert(source.database_id.clone());
    effects.data_source_ids.insert(source.id.clone());
}

fn validate_id(value: &str, label: &str, maximum: usize) -> Result<(), StoreError> {
    if !value.trim().is_empty() && value.len() <= maximum {
        return Ok(());
    }
    Err(invalid(format!(
        "{label} must contain between 1 and {maximum} bytes"
    )))
}

fn validate_name<'a>(value: &'a str, label: &str) -> Result<&'a str, StoreError> {
    let value = value.trim();
    if !value.is_empty() && value.len() <= MAX_NAME_LENGTH {
        return Ok(value);
    }
    Err(invalid(format!(
        "{label} must contain between 1 and {MAX_NAME_LENGTH} bytes"
    )))
}

fn require_revision(expected: i64, actual: i64, message: &str) -> Result<(), StoreError> {
    if expected == actual {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::RevisionConflict,
        format!("{message}: expected {expected}, current {actual}"),
        true,
    ))
}

fn valid_iso_date(value: &str) -> bool {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=maximum).contains(&day)
}

fn valid_canonical_datetime(value: &str) -> bool {
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    if !valid_iso_date(date) || !time.ends_with('Z') {
        return false;
    }
    let time = &time[..time.len() - 1];
    let Some((hour, rest)) = time.split_once(':') else {
        return false;
    };
    let Some((minute, second)) = rest.split_once(':') else {
        return false;
    };
    let (second, fraction) = second
        .split_once('.')
        .map_or((second, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    hour.len() == 2
        && minute.len() == 2
        && second.len() == 2
        && hour.parse::<u32>().is_ok_and(|value| value < 24)
        && minute.parse::<u32>().is_ok_and(|value| value < 60)
        && second.parse::<u32>().is_ok_and(|value| value < 60)
        && fraction.is_none_or(|value| {
            !value.is_empty() && value.len() <= 9 && value.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn json_object(value: &str, label: &str) -> Result<Map<String, Value>, StoreError> {
    parse_json(value, label)?
        .as_object()
        .cloned()
        .ok_or_else(|| corrupt(format!("{label} is not an object")))
}

fn parse_json(value: &str, label: &str) -> Result<Value, StoreError> {
    serde_json::from_str(value).map_err(|_| corrupt(format!("{label} is invalid JSON")))
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{collect_view_property_ids, ensure_collection_capacity};

    #[test]
    fn fixed_schema_collection_allows_the_last_slot_and_rejects_growth() {
        assert!(ensure_collection_capacity(199, 200, "schema").is_ok());
        let error = ensure_collection_capacity(200, 200, "schema")
            .expect_err("the fixed collection bound must reject another identity");
        assert_eq!(error.code, super::StoreErrorCode::InvalidInput);
    }

    #[test]
    fn view_property_references_ignore_filter_values() {
        let definition = super::super::view_contract::decode_definition_value(json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 6,
            "rules": {
                "propertyFilters": [],
                "advancedFilter": {
                    "kind": "group",
                    "operator": "and",
                    "children": [{
                        "kind": "clause",
                        "propertyId": "status",
                        "operator": "select_is",
                        "value": "due_date"
                    }]
                },
                "sorts": []
            },
            "presentation": {
                "group": null,
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "display": { "fields": [], "showEmptyGroups": false }
            }
        }))
        .expect("valid View config");
        let property_ids = collect_view_property_ids(&definition);

        assert!(property_ids.contains("status"));
        assert!(!property_ids.contains("due_date"));
    }
}
