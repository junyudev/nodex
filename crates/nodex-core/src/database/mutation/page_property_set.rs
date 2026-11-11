//! Resolve agent-facing selectors and take before/after observations inside the writer transaction.
use super::*;
use nodex_core_contracts::library::LibraryPageCopyValue;

/// Resolve each selector once and keep its spelling for canonical-key conflicts.
fn unique_selectors<'a, T>(
    connection: &Connection,
    source_id: &str,
    items: impl IntoIterator<Item = (&'a str, T)>,
) -> Result<Vec<(String, T)>, StoreError> {
    let mut spellings = BTreeMap::new();
    items
        .into_iter()
        .map(|(selector, value)| {
            let id = configuration::property_id(connection, source_id, selector)?;
            if let Some(previous) = spellings.insert(id.clone(), selector) {
                return Err(invalid(format!(
                    "Property selectors {previous:?} and {selector:?} both name {id:?}"
                )));
            }
            Ok((id, value))
        })
        .collect()
}

pub(crate) fn resolve_values(
    connection: &Connection,
    source_id: &str,
    values: &[LibraryPageCopyValue],
) -> Result<Vec<LibraryPageCopyValue>, StoreError> {
    unique_selectors(
        connection,
        source_id,
        values
            .iter()
            .map(|input| (input.property_id.as_str(), &input.value)),
    )?
    .into_iter()
    .map(|(property_id, input)| {
        let property = active_property(connection, source_id, &property_id)?;
        let option = |selector: &str| {
            configuration::resolve_option(&property, selector)
                .map(|option| Value::String(option.id))
        };
        let value = match (property.value_type.as_str(), input) {
            ("select", Value::String(selector)) => option(selector)?,
            ("multi_select", Value::Array(selectors)) => Value::Array(
                selectors
                    .iter()
                    .map(|selector| {
                        option(
                            selector
                                .as_str()
                                .ok_or_else(|| invalid("Multi-select options must be strings"))?,
                        )
                    })
                    .collect::<Result<_, _>>()?,
            ),
            _ => input.clone(),
        };
        Ok(LibraryPageCopyValue { property_id, value })
    })
    .collect()
}

fn membership(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<(String, i64), StoreError> {
    connection
        .query_row(
            "SELECT membership.data_source_id, membership.revision
         FROM data_source_page_memberships membership
         JOIN pages page ON page.block_id = membership.page_block_id
              AND page.parent_kind = 'data_source' AND page.parent_id = membership.data_source_id
         JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id
         WHERE page.block_id = ?1 AND page.library_id = ?2
              AND block.lifecycle = 'active' AND membership.removed_at IS NULL",
            params![page_id, library_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            not_found(format!(
                "Page {page_id:?} has no active Data Source membership"
            ))
        })
}

fn resolve_page(
    connection: &Connection,
    library_id: &str,
    selector: &str,
) -> Result<String, StoreError> {
    validate_id(selector, "Page ID or key", MAX_ID_LENGTH)?;
    if connection
        .query_row(
            "SELECT 1 FROM pages WHERE block_id = ?1 AND library_id = ?2",
            params![selector, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(selector.to_owned());
    }
    let candidates = super::super::page_key::resolve_page_key_matches_in_library(
        connection, library_id, selector,
    )?;
    match candidates.as_slice() {
        [page] => Ok(page.page_block_id.clone()),
        [] => Err(not_found(format!("No Page matches {selector:?}"))),
        _ => Err(invalid(format!(
            "Page key {selector:?} is ambiguous. Use its Page ID."
        ))),
    }
}

pub(super) fn compile(
    connection: &Connection,
    library_id: &str,
    updates: &[DatabasePagePropertyUpdate],
) -> Result<Vec<DatabasePropertyValueMutation>, StoreError> {
    let count = updates.iter().try_fold(0usize, |count, update| {
        if update.page_ids.is_empty() || update.values.is_empty() {
            return Err(invalid(
                "Each update requires at least one Page and one Property",
            ));
        }
        if !update.expected_value_revisions.is_empty() && update.page_ids.len() != 1 {
            return Err(invalid(
                "Value revision fences require exactly one Page per update",
            ));
        }
        Ok(count.saturating_add(update.page_ids.len().saturating_mul(update.values.len())))
    })?;
    if count == 0 || count > MAX_BULK_VALUES {
        return Err(invalid(format!(
            "Set Page Properties requires 1–{MAX_BULK_VALUES} edits"
        )));
    }
    let mut edits = Vec::with_capacity(count);
    let mut edited = BTreeMap::new();
    for update in updates {
        let mut resolved_by_source = BTreeMap::new();
        for selector in &update.page_ids {
            let page_id = resolve_page(connection, library_id, selector)?;
            let (data_source_id, membership_revision) =
                membership(connection, library_id, &page_id)?;
            let values = match resolved_by_source.entry(data_source_id.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    require_source(connection, library_id, &data_source_id)?;
                    entry.insert(resolve_values(connection, &data_source_id, &update.values)?)
                }
            };
            let revisions: BTreeMap<_, _> = unique_selectors(
                connection,
                &data_source_id,
                update
                    .expected_value_revisions
                    .iter()
                    .map(|(selector, revision)| (selector.as_str(), *revision)),
            )?
            .into_iter()
            .collect();
            if revisions
                .keys()
                .any(|id| !values.iter().any(|value| &value.property_id == id))
            {
                return Err(invalid(
                    "Each value revision fence must name a Property in the update",
                ));
            }
            for (value, input) in values.iter().zip(&update.values) {
                if let Some(previous) = edited.insert(
                    (page_id.clone(), value.property_id.clone()),
                    input.property_id.as_str(),
                ) {
                    return Err(invalid(format!(
                        "Property selectors {previous:?} and {:?} both edit {:?} on Page {page_id:?}",
                        input.property_id, value.property_id
                    )));
                }
                let (property, _, revision) = property_value_history::current_property_state(
                    connection,
                    &data_source_id,
                    &page_id,
                    &value.property_id,
                )?;
                if property.value_type == "relation" {
                    return Err(invalid(
                        "Relation Properties use typed Relation edits in `nodex page properties apply`",
                    ));
                }
                let normalized = normalize_value(&property, &value.value)?;
                let typed = property_value_history::input_from_value(&property, &normalized)?;
                let expected_value_revision = revisions
                    .get(&value.property_id)
                    .map_or(revision, |expected| *expected);
                edits.push(DatabasePropertyValueMutation {
                    expected_membership_revision: Some(membership_revision),
                    address: DatabasePagePropertyAddress {
                        page_id: page_id.clone(),
                        data_source_id: data_source_id.clone(),
                        property_id: value.property_id.clone(),
                    },
                    edit: DatabasePropertyValueEdit::Replace {
                        expected_value_revision,
                        value: typed,
                    },
                });
            }
        }
    }
    Ok(edits)
}

pub(super) fn observe(
    connection: &Connection,
    library_id: &str,
    intents: &[DatabaseIntent],
) -> Result<Vec<DatabasePagePropertyResult>, StoreError> {
    let [DatabaseIntent::EditPropertyValues { edits }] = intents else {
        return Err(internal("Expected resolved Property edits"));
    };
    let mut pages = Vec::<DatabasePagePropertyResult>::new();
    let mut page_indexes = BTreeMap::new();
    for edit in edits {
        let address = &edit.address;
        let index = match page_indexes.entry(&address.page_id) {
            std::collections::btree_map::Entry::Occupied(entry) => *entry.get(),
            std::collections::btree_map::Entry::Vacant(entry) => {
                let index = pages.len();
                let page_key = super::super::page_key::current_page_key_for_page(
                    connection,
                    library_id,
                    &address.page_id,
                )?;
                pages.push(DatabasePagePropertyResult {
                    page_id: address.page_id.clone(),
                    page_key,
                    data_source_id: address.data_source_id.clone(),
                    membership_revision: membership(connection, library_id, &address.page_id)?.1,
                    values: Vec::new(),
                });
                *entry.insert(index)
            }
        };
        require_source(connection, library_id, &address.data_source_id)?;
        let (before, _) = receipt_value(
            connection,
            library_id,
            &address.data_source_id,
            &address.page_id,
            &address.property_id,
        )?;
        pages[index].values.push(DatabasePagePropertyChange {
            property_id: address.property_id.clone(),
            before,
            after: Value::Null,
            value_revision: 0,
        });
    }
    Ok(pages)
}

pub(super) fn finish(
    connection: &Connection,
    library_id: &str,
    mut pages: Vec<DatabasePagePropertyResult>,
) -> Result<Vec<DatabasePagePropertyResult>, StoreError> {
    for page in &mut pages {
        for change in &mut page.values {
            let (after, revision) = receipt_value(
                connection,
                library_id,
                &page.data_source_id,
                &page.page_id,
                &change.property_id,
            )?;
            change.after = after;
            change.value_revision = revision;
        }
    }
    Ok(pages)
}

fn receipt_value(
    connection: &Connection,
    library_id: &str,
    source_id: &str,
    page_id: &str,
    property_id: &str,
) -> Result<(Value, i64), StoreError> {
    let (property, value, revision) = property_value_history::current_property_state(
        connection,
        source_id,
        page_id,
        property_id,
    )?;
    if property.value_type != "relation" {
        return Ok((property_value_input_json(&value)?, revision));
    }
    let membership_id = active_row_membership(connection, source_id, page_id)?;
    let targets = connection
        .prepare(
            "SELECT edge.target_page_block_id FROM data_source_relation_edges edge
         JOIN pages page ON page.block_id = edge.target_page_block_id AND page.library_id = ?4
         JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id
         WHERE edge.source_data_source_id = ?1 AND edge.source_membership_id = ?2
           AND edge.property_id = ?3 AND block.lifecycle = 'active'
         ORDER BY edge.target_page_block_id",
        )?
        .query_map(
            params![source_id, membership_id, property_id, library_id],
            |row| row.get::<_, String>(0).map(Value::String),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((Value::Array(targets), revision))
}

pub(crate) fn validate_agent_receipt_size(
    pages: &[DatabasePagePropertyResult],
) -> Result<(), StoreError> {
    // Reserve space for both MCP representations and escaped JSON in the text representation.
    const MAX_PROPERTY_RECEIPT_BYTES: usize = 128 * 1024;
    let bytes = serde_json::to_vec(pages)
        .map_err(|_| internal("Page Property receipt cannot be encoded"))?;
    if bytes.len() > MAX_PROPERTY_RECEIPT_BYTES {
        return Err(invalid(
            "The Property receipt would be too large. Set fewer values per call.",
        ));
    }
    Ok(())
}
