//! Whole-gesture scalar and rank inverses. Preparation observes canonical
//! before-images inside the same transaction as the writes. Replay validates
//! every post-image before applying any inverse through the normal writers.

use super::property_value_history::{current_property_state, scalar_type};
use super::*;
use nodex_core_contracts::database::{
    DatabaseDataEditPositionRun, DatabaseDataEditPositionState, DatabaseDataEditPropertyState,
    DatabaseDataEditUndoRecipe, DatabasePropertyType,
};

const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn encoded_size(value: &impl Serialize) -> Result<usize, StoreError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| invalid("Database history cannot be encoded"))
}

#[derive(Default)]
struct DataEditTargets<'a> {
    sources: BTreeSet<&'a str>,
    views: BTreeSet<&'a str>,
}

impl<'a> DataEditTargets<'a> {
    fn include_list_recipe(&mut self, recipe: &'a DatabaseListMoveUndoRecipe) {
        self.sources.insert(&recipe.data_source_id);
        self.views.insert(&recipe.view_id);
    }

    fn include_recipe(&mut self, recipe: &'a DatabaseDataEditUndoRecipe) {
        self.sources.extend(
            recipe
                .property_states
                .iter()
                .map(|state| state.address.data_source_id.as_str()),
        );
        for state in &recipe.position_states {
            self.sources.insert(&state.data_source_id);
            self.views.insert(&state.view_id);
        }
    }

    /// Resolve only ownership metadata before authorizing the complete set.
    /// No value, schema, membership or order comparison may precede this gate.
    fn authorize(
        self,
        connection: &Connection,
        library_id: &str,
        authority: &DatabaseMutationAuthority,
    ) -> Result<(), StoreError> {
        let mut databases = BTreeSet::new();
        for source_id in self.sources {
            databases.insert(require_source(connection, library_id, source_id)?.database_id);
        }
        for view_id in self.views {
            let (database_id, source_id) = connection
                .query_row(
                    "SELECT database_block_id, data_source_id FROM database_views \
                     WHERE id = ?1 AND lifecycle = 'active'",
                    [view_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| not_found("History View is no longer active"))?;
            let source = require_source(connection, library_id, &source_id)?;
            databases.insert(database_id);
            databases.insert(source.database_id);
        }
        for database_id in databases {
            authorize_write(
                connection,
                &authority.actor_project_id,
                &database_id,
                DatabaseWriteAction::Write,
                authority.is_library(),
            )?;
        }
        Ok(())
    }
}

/// Inverse evidence addresses existing resources. Authorize all replay targets
/// before any intent in a mixed batch can reveal a content-dependent conflict.
pub(super) fn authorize_replays(
    connection: &Connection,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    intents: &[DatabaseIntent],
) -> Result<(), StoreError> {
    let mut targets = DataEditTargets::default();
    for intent in intents {
        match intent {
            DatabaseIntent::ReverseDataEdit { recipe } => targets.include_recipe(recipe),
            DatabaseIntent::UndoListOccurrenceMove { recipe } => {
                targets.include_list_recipe(recipe)
            }
            _ => {}
        }
    }
    targets.authorize(connection, library_id, authority)
}

pub(super) fn authorize_list_recipe(
    connection: &Connection,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    recipe: &DatabaseListMoveUndoRecipe,
) -> Result<(), StoreError> {
    let mut targets = DataEditTargets::default();
    targets.include_list_recipe(recipe);
    targets.authorize(connection, library_id, authority)
}

fn position_state(
    connection: &Connection,
    view_id: &str,
    selected: &HashSet<&str>,
) -> Result<DatabaseDataEditPositionState, StoreError> {
    let view = view_row(connection, view_id)?
        .filter(|view| view.lifecycle == "active")
        .ok_or_else(|| not_found("History View is no longer active"))?;
    let definition =
        super::super::view_contract::decode_definition_json(&view.config_json).map_err(corrupt)?;
    let order = super::super::manual_order::require_ready(connection, view_id)?;
    let runs = super::super::manual_order::capture_runs(
        connection,
        &order,
        selected,
        view_fractional_direction(&definition) == DatabaseViewSortDirection::Desc,
    )?
    .into_iter()
    .map(|run| DatabaseDataEditPositionRun {
        page_ids: run.page_ids,
        before_page_id: run.before_page_id,
    })
    .collect::<Vec<_>>();
    Ok(DatabaseDataEditPositionState {
        view_id: view.id,
        data_source_id: view.data_source_id,
        direction: view_fractional_direction(&definition),
        before_runs: runs.clone(),
        after_runs: runs,
    })
}

pub(super) fn capture(
    connection: &Connection,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    intents: &[DatabaseIntent],
) -> Result<Option<DatabaseDataEditUndoRecipe>, StoreError> {
    let mut properties = BTreeMap::new();
    let mut positions = BTreeMap::<&str, HashSet<&str>>::new();
    for intent in intents {
        match intent {
            DatabaseIntent::EditPropertyValues { edits } => {
                for edit in edits {
                    if !matches!(
                        &edit.edit,
                        DatabasePropertyValueEdit::Replace { .. }
                            | DatabasePropertyValueEdit::PatchSet {
                                delta: DatabasePropertySetDelta::MultiSelect { .. }
                            }
                    ) {
                        return Ok(None);
                    }
                    let address = &edit.address;
                    properties.insert(
                        (
                            &address.data_source_id,
                            &address.page_id,
                            &address.property_id,
                        ),
                        address,
                    );
                }
            }
            DatabaseIntent::PositionPage {
                view_id, page_id, ..
            } => {
                positions.entry(view_id).or_default().insert(page_id);
            }
            DatabaseIntent::PositionPages { view_id, pages, .. } => {
                positions
                    .entry(view_id)
                    .or_default()
                    .extend(pages.iter().map(|page| page.page_id.as_str()));
            }
            _ => return Ok(None),
        }
        if properties.len() + positions.values().map(HashSet::len).sum::<usize>() > MAX_BULK_VALUES
        {
            return Ok(None);
        }
    }
    // Mixed creation/schema batches establish their targets during execution;
    // only complete scalar/order gestures have a capturable before-image.
    DataEditTargets {
        sources: properties
            .values()
            .map(|address| address.data_source_id.as_str())
            .collect(),
        views: positions.keys().copied().collect(),
    }
    .authorize(connection, library_id, authority)?;
    let mut recipe = DatabaseDataEditUndoRecipe {
        property_states: Vec::new(),
        position_states: Vec::new(),
    };
    let mut bytes = 0;
    for address in properties.values() {
        let property = active_property(connection, &address.data_source_id, &address.property_id)?;
        let Some(property_type) = scalar_type(&property) else {
            return Ok(None);
        };
        let (_, value, _) = current_property_state(
            connection,
            &address.data_source_id,
            &address.page_id,
            &address.property_id,
        )?;
        let state = DatabaseDataEditPropertyState {
            address: (*address).clone(),
            property_type,
            before_value: value.clone(),
            after_value: value,
        };
        bytes += encoded_size(&state)?;
        if bytes > MAX_HISTORY_BYTES {
            return Ok(None);
        }
        recipe.property_states.push(state);
    }
    for (view_id, selected) in positions {
        let state = position_state(connection, view_id, &selected)?;
        bytes += encoded_size(&state)?;
        if bytes > MAX_HISTORY_BYTES {
            return Ok(None);
        }
        recipe.position_states.push(state);
    }
    Ok(Some(recipe))
}

fn selected_pages(state: &DatabaseDataEditPositionState) -> HashSet<&str> {
    state
        .before_runs
        .iter()
        .flat_map(|run| run.page_ids.iter().map(String::as_str))
        .collect()
}

pub(super) fn finish(
    connection: &Connection,
    captured: Option<DatabaseDataEditUndoRecipe>,
    operation_count: usize,
) -> Result<Option<DatabaseOperationOutcome>, StoreError> {
    let Some(mut recipe) = captured else {
        return Ok(None);
    };
    let mut bytes = 0;
    for state in &mut recipe.property_states {
        let (_, value, _) = current_property_state(
            connection,
            &state.address.data_source_id,
            &state.address.page_id,
            &state.address.property_id,
        )?;
        state.after_value = value;
        bytes += encoded_size(state)?;
        if bytes > MAX_HISTORY_BYTES {
            return Ok(None);
        }
    }
    recipe
        .property_states
        .retain(|state| state.before_value != state.after_value);
    for state in &mut recipe.position_states {
        state.after_runs =
            position_state(connection, &state.view_id, &selected_pages(state))?.after_runs;
        bytes += encoded_size(state)?;
        if bytes > MAX_HISTORY_BYTES {
            return Ok(None);
        }
    }
    recipe
        .position_states
        .retain(|state| state.before_runs != state.after_runs);
    if encoded_size(&recipe)? > MAX_HISTORY_BYTES {
        return Ok(None);
    }
    let changed = !recipe.property_states.is_empty() || !recipe.position_states.is_empty();
    Ok(Some(DatabaseOperationOutcome::DataEdit {
        operation_index: 0,
        operation_count: u32::try_from(operation_count)
            .map_err(|_| invalid("Database history operation count"))?,
        undo_recipe: changed.then(|| Box::new(recipe)),
    }))
}

fn validate_runs(runs: &[DatabaseDataEditPositionRun]) -> Result<HashSet<&str>, StoreError> {
    let mut ids = HashSet::new();
    for run in runs {
        if run.page_ids.is_empty() {
            return Err(invalid("History position run cannot be empty"));
        }
        for id in &run.page_ids {
            validate_id(id, "History Page", MAX_ID_LENGTH)?;
            if !ids.insert(id.as_str()) {
                return Err(invalid("History position repeats a Page"));
            }
        }
        if let Some(id) = &run.before_page_id {
            validate_id(id, "History anchor", MAX_ID_LENGTH)?;
        }
    }
    if ids.is_empty() || ids.len() > MAX_BULK_VALUES {
        return Err(invalid("History position scope exceeds its bound"));
    }
    if runs.iter().any(|run| {
        run.before_page_id
            .as_deref()
            .is_some_and(|id| ids.contains(id))
    }) {
        return Err(invalid(
            "History anchors must be outside the affected Page set",
        ));
    }
    Ok(ids)
}

pub(super) fn validate(recipe: &DatabaseDataEditUndoRecipe) -> Result<(), StoreError> {
    if recipe.property_states.len() > MAX_BULK_VALUES
        || recipe.position_states.len() > MAX_OPERATIONS
        || encoded_size(recipe)? > MAX_HISTORY_BYTES
    {
        return Err(invalid("Database history exceeds its bounded gesture size"));
    }
    let mut addresses = HashSet::new();
    for state in &recipe.property_states {
        let address = &state.address;
        validate_id(
            &address.data_source_id,
            "History Data Source",
            MAX_ID_LENGTH,
        )?;
        validate_id(&address.page_id, "History Page", MAX_ID_LENGTH)?;
        validate_id(
            &address.property_id,
            "History Property",
            MAX_PROPERTY_ID_LENGTH,
        )?;
        if state.property_type == DatabasePropertyType::Relation
            || !addresses.insert((
                &address.data_source_id,
                &address.page_id,
                &address.property_id,
            ))
        {
            return Err(invalid(
                "History Property addresses are invalid or duplicated",
            ));
        }
    }
    let mut count = addresses.len();
    let mut views = HashSet::new();
    for state in &recipe.position_states {
        validate_id(&state.view_id, "History View", MAX_ID_LENGTH)?;
        validate_id(&state.data_source_id, "History Data Source", MAX_ID_LENGTH)?;
        if !views.insert(&state.view_id) {
            return Err(invalid("History View positions are duplicated"));
        }
        let before = validate_runs(&state.before_runs)?;
        let after = validate_runs(&state.after_runs)?;
        if before != after {
            return Err(invalid("History position images contain different Pages"));
        }
        count += before.len();
    }
    if count == 0 || count > MAX_BULK_VALUES {
        return Err(invalid(
            "Database history has an invalid affected identity count",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reverse(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    recipe: &DatabaseDataEditUndoRecipe,
    operation_index: u32,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    validate(recipe)?;
    let mut targets = DataEditTargets::default();
    targets.include_recipe(recipe);
    targets.authorize(connection, library_id, authority)?;
    let mut operations = Vec::new();
    let mut edits = Vec::new();
    let mut positions = Vec::new();
    for state in &recipe.property_states {
        let address = &state.address;
        let (property, value, revision) = current_property_state(
            connection,
            &address.data_source_id,
            &address.page_id,
            &address.property_id,
        )?;
        if scalar_type(&property) != Some(state.property_type) || value != state.after_value {
            return Err(conflict(
                "A Property changed after this edit and cannot be undone safely",
            ));
        }
        edits.push(DatabasePropertyValueMutation {
            address: address.clone(),
            edit: DatabasePropertyValueEdit::Replace {
                expected_value_revision: revision,
                value: state.before_value.clone(),
            },
        });
    }
    if !edits.is_empty() {
        operations.push(DatabaseIntent::EditPropertyValues { edits });
    }
    for state in &recipe.position_states {
        let current = position_state(connection, &state.view_id, &selected_pages(state))?;
        if current.data_source_id != state.data_source_id
            || current.direction != state.direction
            || current.after_runs != state.after_runs
        {
            return Err(conflict(
                "The affected Page order or View changed and cannot be undone safely",
            ));
        }
        let order = super::super::manual_order::require_ready(connection, &state.view_id)?;
        let pages = state
            .before_runs
            .iter()
            .flat_map(|run| &run.page_ids)
            .map(|page_id| {
                let revision =
                    super::super::manual_order::position_revision(connection, &order, page_id)?;
                Ok(DatabasePagePosition {
                    page_id: page_id.clone(),
                    expected_position_revision: revision,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let runs = state
            .before_runs
            .iter()
            .map(|run| LogicalPositionRun {
                page_ids: run.page_ids.clone(),
                before_page_id: run.before_page_id.clone(),
            })
            .collect::<Vec<_>>();
        positions.push((&state.view_id, pages, runs));
    }
    // All post-images have passed. Normal writers still recheck current write
    // authority, membership, schema/options and anchors in this transaction.
    for operation in operations {
        apply_intent(
            connection, profile_id, library_id, authority, &operation, 0, now, effects,
        )?;
    }
    for (view_id, pages, runs) in positions {
        position_page_runs(
            connection,
            library_id,
            &authority.actor_project_id,
            view_id,
            &pages,
            &runs,
            now,
            effects,
            authority.is_library(),
        )?;
    }
    let mut inverse = recipe.clone();
    for state in &mut inverse.property_states {
        std::mem::swap(&mut state.before_value, &mut state.after_value);
    }
    for state in &mut inverse.position_states {
        std::mem::swap(&mut state.before_runs, &mut state.after_runs);
    }
    effects
        .operation_outcomes
        .push(DatabaseOperationOutcome::DataEdit {
            operation_index,
            operation_count: 1,
            undo_recipe: Some(Box::new(inverse)),
        });
    Ok(())
}
