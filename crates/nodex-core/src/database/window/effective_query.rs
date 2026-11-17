//! Database-owned effective occurrences for one authorized Query observation.
use super::*;
use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::AgentExecutionAuthorization;
use nodex_core_contracts::database::{
    DatabaseDisplayedViewSelection, DatabaseEffectiveViewCoordinate, DatabaseObservedOccurrence,
    DatabaseObservedRowCondition,
};
use nodex_core_contracts::query::DatabaseDisplayedViewQueryCoverage;

pub(crate) struct EffectiveProjection {
    pub rows: Vec<Value>,
    pub rules_fingerprint: String,
    pub coverage: DatabaseDisplayedViewQueryCoverage,
    pub total_occurrences: usize,
}

pub(crate) struct EffectiveViewRequest<'a> {
    pub view_search: &'a ViewSearchRegistry,
    pub store_epoch: &'a str,
    pub authorization: &'a AgentExecutionAuthorization,
    pub coordinate: &'a DatabaseEffectiveViewCoordinate,
    pub projection_property_ids: Option<&'a [String]>,
    pub selection: &'a DatabaseDisplayedViewSelection,
}

pub(crate) fn project(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    request: EffectiveViewRequest<'_>,
    charge: &impl Fn(usize, usize) -> Result<(), StoreError>,
) -> Result<EffectiveProjection, StoreError> {
    let EffectiveViewRequest {
        view_search,
        store_epoch,
        authorization,
        coordinate,
        projection_property_ids,
        selection,
    } = request;
    validate_coordinate(coordinate, selection)?;
    crate::library::agent_execution::validate_execution(
        connection,
        context,
        library_id,
        authorization,
    )?;
    let mut view = resolve_coordinate(connection, context, library_id, coordinate)?;
    super::super::relation::validate_agent_view_filter_read_access(
        connection,
        context,
        library_id,
        authorization,
        &view.data_source_id,
        &super::super::view_contract::effective_filter(&view.config.rules),
    )?;
    search::prepare_authorized(
        connection,
        library_id,
        store_epoch,
        commit_head,
        &mut view,
        ViewSearchRequest {
            query: &coordinate.search_query,
            registry: view_search,
        },
    )?;
    let relation_ids = connection
        .prepare_cached(
            "SELECT id FROM data_source_properties WHERE data_source_id = ?1
         AND lifecycle = 'active' AND value_type = 'relation'",
        )?
        .query_map([&view.data_source_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let requested = projection_property_ids
        .map(|ids| {
            resolve_agent_projection_property_ids(connection, &view.data_source_id, Some(ids))
        })
        .transpose()?;
    let mut projected_property_ids = projected_property_ids(&view.config)?;
    // Ordinary View row hydration includes Relation previews, even when the Property is not a card field.
    projected_property_ids.extend(relation_ids);
    let output_property_ids = requested.unwrap_or_else(|| projected_property_ids.clone());
    let matched = if view.search.is_some() {
        let rows = sorted_rows(
            connection,
            &view,
            None,
            &projected_property_ids,
            None,
            MAX_LIST_PROJECTION_MODELS + 1,
        )?
        .into_iter()
        .map(|row| row.summary)
        .collect::<Vec<_>>();
        if rows.len() > MAX_LIST_PROJECTION_MODELS {
            return Err(invalid("Displayed View projection exceeds its model bound"));
        }
        charge(rows.len(), encoded_len(&rows)?)?;
        rows
    } else {
        complete_filtered_view_rows_with(
            connection,
            library_id,
            commit_head,
            &view,
            &projected_property_ids,
            &|rows| charge(rows.len(), encoded_len(rows)?),
        )?
    };
    // Board cards are flat Page/group occurrences. List retains its canonical hierarchy.
    let board = view.layout == DatabaseViewLayout::Board;
    if board {
        view.config.presentation.hierarchy.show_sub_pages = true;
        view.config.presentation.hierarchy.nested_sub_pages = false;
    }
    let graph = build_occurrence_graph(connection, &view, matched, board)?;
    let mut occurrences = graph
        .rows
        .into_iter()
        .filter(|row| matches!(row, DatabaseListProjectionRow::Page { .. }))
        .collect::<Vec<_>>();
    charge(occurrences.len(), encoded_len(&occurrences)?)?;
    let mut summaries = occurrences
        .iter()
        .filter_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. } => {
                Some((summary.page_id.clone(), summary.as_ref().clone()))
            }
            _ => None,
        })
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect::<Vec<_>>();
    let extra_ids = output_property_ids
        .difference(&projected_property_ids)
        .cloned()
        .collect::<BTreeSet<_>>();
    hydrate_additional_values(
        connection,
        &view.data_source_id,
        &extra_ids,
        &mut summaries,
        charge,
    )?;
    let relation_inputs = super::super::relation_projection::hydrate_agent_row_previews(
        connection,
        library_id,
        &view.data_source_id,
        &mut summaries,
    )?;
    charge(relation_inputs, encoded_len(&summaries)?)?;
    let summaries = summaries
        .into_iter()
        .map(|summary| (summary.page_id.clone(), summary))
        .collect::<BTreeMap<_, _>>();
    for occurrence in &mut occurrences {
        if let DatabaseListProjectionRow::Page { summary, .. } = occurrence {
            **summary = summaries
                .get(&summary.page_id)
                .ok_or_else(|| corrupt("Displayed row lost its authority"))?
                .clone();
        }
    }
    let total_occurrences = occurrences.len();
    let occurrence_coordinates = occurrences
        .iter()
        .enumerate()
        .filter_map(|(index, row)| match row {
            DatabaseListProjectionRow::Page {
                occurrence_key,
                summary,
                group_path,
                ..
            } => Some((
                (group_path.clone(), summary.page_id.clone()),
                (occurrence_key.clone(), index),
            )),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    let selected = match selection {
        DatabaseDisplayedViewSelection::Effective { .. } => occurrences,
        DatabaseDisplayedViewSelection::Observed {
            occurrences: observed,
        } => select_observed(
            connection,
            &view.data_source_id,
            occurrences,
            observed,
            view.layout,
            charge,
        )?,
    };
    let mut rows = Vec::with_capacity(selected.len());
    for occurrence in selected {
        let DatabaseListProjectionRow::Page {
            occurrence_key,
            mut summary,
            group_path,
            ancestor_page_ids,
            depth,
            transient_kind,
            ..
        } = occurrence
        else {
            continue;
        };
        let parent = ancestor_page_ids
            .last()
            .and_then(|id| occurrence_coordinates.get(&(group_path.clone(), id.clone())))
            .map(|(key, _)| key.clone());
        let ordinal = occurrence_coordinates
            .get(&(group_path.clone(), summary.page_id.clone()))
            .map(|(_, index)| *index)
            .ok_or_else(|| corrupt("Displayed occurrence coordinate is unavailable"))?;
        summary
            .database_values
            .retain(|id, _| output_property_ids.contains(id));
        summary
            .database_value_revisions
            .retain(|id, _| output_property_ids.contains(id));
        rows.push(json!({
            "occurrence_id": occurrence_key, "page_id": summary.page_id, "page_key": summary.page_key,
            "title": summary.title, "description_preview": summary.description_preview,
            "group_key": group_path.first().cloned().flatten(), "subgroup_key": group_path.get(1).cloned().flatten(),
            "group_path": group_path, "ancestor_page_ids": ancestor_page_ids, "parent_occurrence_id": parent,
            "ordinal": ordinal, "depth": depth, "transient_kind": transient_kind,
            "metadata_revision": summary.metadata_revision, "parent_revision": summary.parent_revision,
            "document_id": summary.document_id, "document_generation": summary.document_generation, "document_head_seq": summary.document_head_seq,
            "membership_id": summary.membership_id, "membership_revision": summary.membership_revision,
            "values": summary.database_values, "value_revisions": summary.database_value_revisions,
            "rank_key": summary.rank_key, "position_revision": summary.position_revision,
        }));
    }
    charge(0, encoded_len(&rows)?)?;
    let coverage = match selection {
        DatabaseDisplayedViewSelection::Effective { limit: None } => {
            DatabaseDisplayedViewQueryCoverage::EffectiveComplete
        }
        DatabaseDisplayedViewSelection::Effective { limit: Some(limit) } => {
            DatabaseDisplayedViewQueryCoverage::EffectiveLimited { limit: *limit }
        }
        DatabaseDisplayedViewSelection::Observed { .. } => {
            DatabaseDisplayedViewQueryCoverage::Observed
        }
    };
    let rules_fingerprint =
        cursor::query_fingerprint(&(coordinate, &view.config, &view.completion_cutoff))?;
    Ok(EffectiveProjection {
        rows,
        rules_fingerprint,
        coverage,
        total_occurrences,
    })
}

fn validate_coordinate(
    coordinate: &DatabaseEffectiveViewCoordinate,
    selection: &DatabaseDisplayedViewSelection,
) -> Result<(), StoreError> {
    for id in [
        &coordinate.database_id,
        &coordinate.data_source_id,
        &coordinate.view_id,
    ] {
        validate_identity(id, "Displayed View identity")?;
    }
    if coordinate.expected_view_revision < 0
        || coordinate.expected_schema_revision < 0
        || coordinate
            .expected_preferences_revision
            .is_some_and(|value| value < 0)
        || coordinate.search_query.len() > 16_384
    {
        return Err(invalid("Displayed View coordinate is invalid"));
    }
    match selection {
        DatabaseDisplayedViewSelection::Effective { limit: Some(limit) }
            if *limit == 0 || *limit > 10_000 =>
        {
            return Err(invalid("Displayed View limit must be between 1 and 10000"));
        }
        DatabaseDisplayedViewSelection::Observed { occurrences } if occurrences.len() > 200 => {
            return Err(invalid(
                "Displayed View observation exceeds 200 occurrences",
            ));
        }
        _ => (),
    }
    Ok(())
}

fn resolve_coordinate(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    coordinate: &DatabaseEffectiveViewCoordinate,
) -> Result<ResolvedView, StoreError> {
    let saved = resolve_saved_view(connection, library_id, &coordinate.view_id)?;
    let schema_revision: i64 = connection.query_row(
        "SELECT schema_revision FROM data_sources WHERE id = ?1 AND library_id = ?2",
        params![coordinate.data_source_id, library_id],
        |row| row.get(0),
    )?;
    if saved.database_id != coordinate.database_id
        || saved.data_source_id != coordinate.data_source_id
        || saved.revision != coordinate.expected_view_revision
        || schema_revision != coordinate.expected_schema_revision
    {
        return Err(stale());
    }
    let mut current = saved.clone();
    if let Some(revision) = coordinate.expected_preferences_revision {
        let preferences = super::super::read::view_personal_preferences(
            connection,
            &crate::infrastructure::actors::requesting_member(connection, context)?,
            &coordinate.view_id,
        )?;
        if preferences.revision != revision {
            return Err(stale());
        }
        apply_definition_override(
            &mut current.config,
            &DatabaseViewPreferencesOverrideInput {
                rules_override: preferences.rules_override,
                presentation_override: preferences.presentation_override,
            },
        )?;
    }
    refresh_effective_presentation(connection, &mut current)?;
    let mut captured = saved;
    apply_definition_override(&mut captured.config, &coordinate.preferences_override)?;
    refresh_effective_presentation(connection, &mut captured)?;
    if current.config != captured.config {
        return Err(stale());
    }
    captured.exact_primary_board_config = false;
    Ok(captured)
}

fn hydrate_additional_values(
    connection: &Connection,
    source: &str,
    properties: &BTreeSet<String>,
    summaries: &mut [DatabaseRowSummary],
    charge: &impl Fn(usize, usize) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    if properties.is_empty() || summaries.is_empty() {
        return Ok(());
    }
    let memberships = summaries
        .iter()
        .map(|summary| summary.membership_id.as_str())
        .collect::<Vec<_>>();
    let indexes = summaries
        .iter()
        .enumerate()
        .map(|(index, summary)| (summary.membership_id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let mut statement = connection.prepare("SELECT value.membership_id,value.property_id,value.value_json,value.revision FROM data_source_property_values value JOIN json_each(?2) selected ON selected.value=value.membership_id JOIN json_each(?3) property ON property.value=value.property_id WHERE value.data_source_id=?1")?;
    let mut cursor = statement.query(params![
        source,
        serde_json::to_string(&memberships)
            .map_err(|_| invalid("Displayed memberships cannot encode"))?,
        serde_json::to_string(properties)
            .map_err(|_| invalid("Displayed Properties cannot encode"))?
    ])?;
    while let Some(row) = cursor.next()? {
        let membership: String = row.get(0)?;
        let property: String = row.get(1)?;
        let value: String = row.get(2)?;
        charge(0, membership.len() + property.len() + value.len())?;
        let summary = &mut summaries[*indexes
            .get(&membership)
            .ok_or_else(|| corrupt("Displayed membership is unavailable"))?];
        summary.database_values.insert(
            property.clone(),
            serde_json::from_str(&value)
                .map_err(|_| corrupt("Displayed Property value is invalid"))?,
        );
        summary
            .database_value_revisions
            .insert(property, row.get(3)?);
    }
    Ok(())
}

fn matches_condition(
    summary: &DatabaseRowSummary,
    condition: &DatabaseObservedRowCondition,
    value_revisions: &BTreeMap<String, i64>,
) -> bool {
    summary.metadata_revision == condition.metadata_revision
        && summary.parent_revision == condition.parent_revision
        && summary.document_id == condition.document_id
        && summary.document_generation == condition.document_generation
        && summary.document_head_seq == condition.document_head_seq
        && summary.membership_id == condition.membership_id
        && summary.membership_revision == condition.membership_revision
        && summary.position_revision == condition.position_revision
        && summary.rank_key == condition.rank_key
        && condition
            .database_value_revisions
            .iter()
            .all(|(id, revision)| value_revisions.get(id).copied().unwrap_or(0) == *revision)
}

fn select_observed(
    connection: &Connection,
    source: &str,
    rows: Vec<DatabaseListProjectionRow>,
    observed: &[DatabaseObservedOccurrence],
    layout: DatabaseViewLayout,
    charge: &impl Fn(usize, usize) -> Result<(), StoreError>,
) -> Result<Vec<DatabaseListProjectionRow>, StoreError> {
    let by_coordinate = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| match row {
            DatabaseListProjectionRow::Page {
                occurrence_key,
                summary,
                group_path,
                ancestor_page_ids,
                ..
            } => Some((
                (
                    summary.page_id.clone(),
                    group_path.clone(),
                    ancestor_page_ids.clone(),
                    (layout == DatabaseViewLayout::List).then(|| occurrence_key.clone()),
                ),
                index,
            )),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    // The mounted row may contain more Properties than this query returns. Validate
    // their current revisions without loading hidden values or Relation previews.
    let mut revisions = connection.prepare(
        "SELECT value.property_id, value.revision FROM data_source_property_values value \
         JOIN json_each(?3) observed ON observed.value = value.property_id \
         WHERE value.data_source_id = ?1 AND value.membership_id = ?2",
    )?;
    let mut selected = BTreeSet::new();
    for occurrence in observed {
        if occurrence.group_path.len() > 2
            || occurrence.ancestor_page_ids.len() > 128
            || occurrence.condition.database_value_revisions.len()
                > super::super::MAX_DATA_SOURCE_PROPERTIES
        {
            return Err(invalid("Displayed occurrence condition exceeds its bound"));
        }
        let mut group_path = occurrence.group_path.clone();
        group_path.resize(2, None);
        let coordinate = (
            occurrence.page_id.clone(),
            group_path,
            occurrence.ancestor_page_ids.clone(),
            occurrence.occurrence_key.clone(),
        );
        let index = by_coordinate.get(&coordinate).ok_or_else(stale)?;
        let DatabaseListProjectionRow::Page { summary, .. } = &rows[*index] else {
            return Err(stale());
        };
        let properties = occurrence
            .condition
            .database_value_revisions
            .keys()
            .collect::<Vec<_>>();
        let mut cursor = revisions.query(params![
            source,
            summary.membership_id,
            serde_json::to_string(&properties)
                .map_err(|_| invalid("Observed Properties cannot encode"))?
        ])?;
        let mut value_revisions = BTreeMap::new();
        while let Some(row) = cursor.next()? {
            let property: String = row.get(0)?;
            let revision: i64 = row.get(1)?;
            charge(1, property.len() + std::mem::size_of::<i64>())?;
            value_revisions.insert(property, revision);
        }
        if !selected.insert(*index)
            || !matches_condition(summary, &occurrence.condition, &value_revisions)
        {
            return Err(stale());
        }
    }
    Ok(rows
        .into_iter()
        .enumerate()
        .filter_map(|(index, row)| selected.contains(&index).then_some(row))
        .collect())
}

fn encoded_len(value: &(impl Serialize + ?Sized)) -> Result<usize, StoreError> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|_| invalid("Displayed View projection cannot encode"))
}

fn stale() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "Displayed View rules or rows changed; observe the tab again",
        false,
    )
}
