//! Resolve a declarative script inside its receipt-protected atomic mutation.
use super::*;
use nodex_core_contracts::database::*;
use nodex_core_contracts::database_configuration::{
    ConfigurationSort, DatabaseConfigurationOperation as Operation, DatabaseConfigurationScript,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    authority: &DatabaseMutationAuthority,
    source_id: &str,
    script: &DatabaseConfigurationScript,
    operation_index: u32,
    now: &str,
    effects: &mut MutationEffects,
) -> Result<(), StoreError> {
    if script.if_schema_revision < 1
        || script.operations.is_empty()
        || script.operations.len() > 100
    {
        return Err(invalid(
            "Configuration requires between 1 and 100 operations",
        ));
    }
    let operation_count: usize = script
        .operations
        .iter()
        .map(|operation| match operation {
            Operation::AddProperty { options, .. } => 1 + options.len(),
            _ => 1,
        })
        .sum();
    if operation_count > 4096 {
        return Err(invalid("Configuration exceeds 4096 semantic operations"));
    }
    let source = require_source(connection, library_id, source_id)?;
    authorize_write(
        connection,
        authority.actor_project_id.as_deref(),
        &source.database_id,
        DatabaseWriteAction::ManageSchema,
        authority.is_library(),
    )?;
    require_revision(
        script.if_schema_revision,
        source.revision,
        "Data Source schema revision changed",
    )?;
    for operation in &script.operations {
        let intents = resolve(connection, library_id, source_id, operation)?;
        for intent in intents {
            apply_intent(
                connection,
                profile_id,
                library_id,
                authority,
                &intent,
                operation_index,
                now,
                effects,
            )?;
        }
    }
    Ok(())
}

fn resolve(
    connection: &Connection,
    library_id: &str,
    source_id: &str,
    operation: &Operation,
) -> Result<Vec<DatabaseIntent>, StoreError> {
    let source = require_source(connection, library_id, source_id)?;
    let mut intents = Vec::new();
    match operation {
        Operation::AddProperty {
            name,
            schema,
            options,
        } => {
            if options.iter().collect::<BTreeSet<_>>().len() != options.len() {
                return Err(invalid("Property option names must be unique"));
            }
            if options.len() > 100 {
                return Err(invalid("A Property supports at most 100 options"));
            }
            if !options.is_empty()
                && !matches!(
                    schema,
                    DatabasePropertySchema::Select | DatabasePropertySchema::MultiSelect
                )
            {
                return Err(invalid("Only select Properties accept options"));
            }
            ensure_new_name(
                connection,
                "data_source_properties",
                "data_source_id",
                source_id,
                name,
            )?;
            let property_id = fresh_id("p_")?;
            intents.push(DatabaseIntent::PutProperty {
                data_source_id: source_id.into(),
                property_id: property_id.clone(),
                expected_data_source_revision: source.revision,
                expected_property_revision: 0,
                name: name.clone(),
                schema: schema.clone(),
                before_property_id: None,
            });
            for (index, name) in options.iter().enumerate() {
                intents.push(DatabaseIntent::PutOption {
                    data_source_id: source_id.into(),
                    property_id: property_id.clone(),
                    option_id: fresh_id("o_")?,
                    name: name.clone(),
                    color: None,
                    expected_property_revision: index as i64 + 1,
                });
            }
        }
        Operation::RenameProperty { property, name } => {
            let property_id = property_id(connection, source_id, property)?;
            let current = active_property(connection, source_id, &property_id)?;
            let schema = super::super::property_semantics::schema_from_storage(
                connection,
                source_id,
                &property_id,
                &current.value_type,
            )?;
            intents.push(DatabaseIntent::PutProperty {
                data_source_id: source_id.into(),
                property_id,
                expected_data_source_revision: source.revision,
                expected_property_revision: current.revision,
                name: name.clone(),
                schema,
                before_property_id: None,
            });
        }
        Operation::ChangePropertyType { property, schema } => {
            let property_id = property_id(connection, source_id, property)?;
            let current = active_property(connection, source_id, &property_id)?;
            intents.push(DatabaseIntent::ChangePropertyType {
                data_source_id: source_id.into(),
                property_id,
                expected_data_source_revision: source.revision,
                expected_property_revision: current.revision,
                schema: schema.clone(),
            });
        }
        Operation::AddOption {
            property,
            name,
            color,
        } => {
            let property_id = property_id(connection, source_id, property)?;
            let current = active_property(connection, source_id, &property_id)?;
            if option_config(&current)?
                .options
                .iter()
                .any(|option| option.name == *name)
            {
                return Err(invalid("An option with this name already exists"));
            }
            intents.push(DatabaseIntent::PutOption {
                data_source_id: source_id.into(),
                property_id,
                option_id: fresh_id("o_")?,
                expected_property_revision: current.revision,
                name: name.clone(),
                color: color.clone(),
            });
        }
        Operation::RenameOption {
            property,
            option,
            name,
        } => {
            let property_id = property_id(connection, source_id, property)?;
            let current = active_property(connection, source_id, &property_id)?;
            let target = resolve_option(&current, option)?;
            intents.push(DatabaseIntent::PutOption {
                data_source_id: source_id.into(),
                property_id,
                option_id: target.id.clone(),
                expected_property_revision: current.revision,
                name: name.clone(),
                color: target.color.clone(),
            });
        }
        Operation::CreateView {
            name,
            layout,
            filter,
            group_by,
            sorts,
        } => {
            ensure_new_name(
                connection,
                "database_views",
                "data_source_id",
                source_id,
                name,
            )?;
            let definition = DatabaseViewDefinition {
                rules: DatabaseViewRules {
                    advanced_filter: resolve_saved_filter(connection, source_id, filter.as_ref())?,
                    sorts: resolve_sorts(connection, source_id, sorts)?,
                    ..Default::default()
                },
                presentation: DatabaseViewPresentation {
                    group: resolve_group(connection, source_id, group_by.as_deref())?,
                    subgroup: None,
                    group_direction: DatabaseViewSortDirection::Asc,
                    completion: DatabaseViewCompletion {
                        range: DatabaseViewCompletedRange::All,
                        order_by_recency: false,
                    },
                    hierarchy: DatabaseViewHierarchy {
                        show_sub_pages: true,
                        nested_sub_pages: false,
                    },
                    display: DatabaseViewLayoutDisplay {
                        fields: vec![],
                        property_order: vec![],
                        show_empty_groups: false,
                        show_description: true,
                    },
                    conditional_colors: vec![],
                },
            };
            intents.push(DatabaseIntent::PutView {
                database_id: source.database_id,
                data_source_id: source_id.into(),
                view_id: fresh_id("view_")?,
                expected_revision: 0,
                name: name.clone(),
                layout: *layout,
                definition,
                is_default: false,
                before_view_id: None,
            });
        }
        Operation::UpdateView {
            view,
            if_revision,
            name,
            filter,
            sorts,
            group_by,
        } => {
            let view_id = resolve_id(
                connection,
                "database_views",
                "data_source_id",
                source_id,
                view,
            )?;
            let (current_name, layout, config, is_default) = connection.query_row("SELECT v.name, v.layout, v.config_json, v.id = c.default_view_id FROM database_views v JOIN database_containers c ON c.block_id = v.database_block_id WHERE v.id = ?1", [&view_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,bool>(3)?)))?;
            let mut definition =
                super::super::view_contract::decode_definition_json(&config).map_err(invalid)?;
            if let Some(filter) = filter {
                definition.rules.advanced_filter =
                    resolve_saved_filter(connection, source_id, filter.as_ref())?;
                definition.rules.property_filters.clear();
            }
            if let Some(sorts) = sorts {
                definition.rules.sorts = resolve_sorts(connection, source_id, sorts)?;
            }
            if let Some(group) = group_by {
                definition.presentation.group =
                    resolve_group(connection, source_id, group.as_deref())?;
            }
            let layout = match layout.as_str() {
                "board" => DatabaseViewLayout::Board,
                "list" => DatabaseViewLayout::List,
                _ => return Err(internal("Unknown View layout")),
            };
            intents.push(DatabaseIntent::PutView {
                database_id: source.database_id,
                data_source_id: source_id.into(),
                view_id,
                expected_revision: *if_revision,
                name: name.clone().unwrap_or(current_name),
                layout,
                definition,
                is_default,
                before_view_id: None,
            });
        }
    }
    Ok(intents)
}

/// Configuration commits complete filters, while the desktop can retain inactive drafts.
/// Both use the same expression, typed operators and final PutView validation.
fn resolve_saved_filter(
    connection: &Connection,
    source_id: &str,
    filter: Option<&DatabaseViewFilter>,
) -> Result<Option<DatabaseViewFilter>, StoreError> {
    let Some(filter) = filter else {
        return Ok(None);
    };
    // Bound traversal before resolving selectors, using the canonical structural guard.
    validate_view_filter(filter, 0, &mut 0)?;
    let resolved = resolve_filter(connection, source_id, filter)?;
    let group = match resolved {
        DatabaseViewFilter::Group { .. } => resolved,
        clause => DatabaseViewFilter::Group {
            operator: DatabaseViewFilterGroupOperator::And,
            children: vec![clause],
        },
    };
    Ok(Some(group))
}

fn resolve_filter(
    connection: &Connection,
    source_id: &str,
    filter: &DatabaseViewFilter,
) -> Result<DatabaseViewFilter, StoreError> {
    match filter {
        DatabaseViewFilter::Group { operator, children } => {
            if children.is_empty() {
                return Err(invalid(
                    "Saved filter groups require conditions; use filter:null to clear filters",
                ));
            }
            Ok(DatabaseViewFilter::Group {
                operator: *operator,
                children: children
                    .iter()
                    .map(|child| resolve_filter(connection, source_id, child))
                    .collect::<Result<_, _>>()?,
            })
        }
        DatabaseViewFilter::Clause {
            property_id: selector,
            operator,
            value,
        } => {
            let operand = value.as_ref().and_then(Option::as_ref);
            if super::super::view_contract::filter_value_is_empty(*operator, operand)
                || !filter_value_matches_operator(*operator, operand)
            {
                return Err(invalid(
                    "Saved filter requires a complete value matching its typed operator",
                ));
            }
            let property_id = property_id(connection, source_id, selector)?;
            let property = active_property(connection, source_id, &property_id)?;
            let schema = super::super::property_semantics::schema_from_storage(
                connection,
                source_id,
                &property_id,
                &property.value_type,
            )?;
            if !super::super::property_semantics::capabilities(&schema)
                .filter_operators
                .contains(operator)
            {
                return Err(invalid("Property filter operator is unsupported"));
            }
            let value = resolve_filter_value(&property, *operator, value)?;
            Ok(DatabaseViewFilter::Clause {
                property_id,
                operator: *operator,
                value,
            })
        }
    }
}

fn resolve_filter_value(
    property: &PropertyRow,
    operator: DatabaseViewFilterOperator,
    value: &Option<Option<Value>>,
) -> Result<Option<Option<Value>>, StoreError> {
    use DatabaseViewFilterOperator as Operator;
    let Some(Some(value)) = value else {
        return Ok(value.clone());
    };
    let option_id = |value: &Value| {
        let selector = value
            .as_str()
            .ok_or_else(|| invalid("Option selector must be a string"))?;
        resolve_option(property, selector).map(|option| Value::String(option.id))
    };
    let resolved = match operator {
        Operator::SelectIs | Operator::SelectIsNot => option_id(value)?,
        Operator::MultiSelectContains
        | Operator::MultiSelectDoesNotContain
        | Operator::MultiSelectContainsAll => {
            let values = value
                .as_array()
                .ok_or_else(|| invalid("Option selectors must be an array"))?;
            Value::Array(values.iter().map(option_id).collect::<Result<_, _>>()?)
        }
        _ => value.clone(),
    };
    Ok(Some(Some(resolved)))
}

fn resolve_option(
    property: &PropertyRow,
    selector: &str,
) -> Result<super::super::property_semantics::PropertyOption, StoreError> {
    let options = option_config(property)?.options;
    if let Some(exact) = options.iter().find(|candidate| candidate.id == selector) {
        return Ok(exact.clone());
    }
    let mut matches = options
        .into_iter()
        .filter(|candidate| candidate.name == selector);
    match (matches.next(), matches.next()) {
        (Some(option), None) => Ok(option),
        _ => Err(invalid(
            "Option selector is missing or ambiguous; use its stable ID",
        )),
    }
}

fn resolve_sorts(
    connection: &Connection,
    source_id: &str,
    sorts: &[ConfigurationSort],
) -> Result<Vec<DatabaseViewSort>, StoreError> {
    sorts
        .iter()
        .map(|sort| {
            Ok(DatabaseViewSort {
                field: match sort.property.as_str() {
                    "manual" => DatabaseViewSortField::Manual,
                    "title" => DatabaseViewSortField::Title,
                    "created" => DatabaseViewSortField::Created,
                    selector => DatabaseViewSortField::Property {
                        property_id: property_id(connection, source_id, selector)?,
                    },
                },
                direction: sort.direction,
                nulls: DatabaseViewNullOrder::Last,
            })
        })
        .collect()
}
fn resolve_group(
    connection: &Connection,
    source_id: &str,
    selector: Option<&str>,
) -> Result<Option<DatabaseViewGroup>, StoreError> {
    selector
        .map(|selector| {
            property_id(connection, source_id, selector)
                .map(|property_id| DatabaseViewGroup { property_id })
        })
        .transpose()
}
fn property_id(
    connection: &Connection,
    source_id: &str,
    selector: &str,
) -> Result<String, StoreError> {
    resolve_id(
        connection,
        "data_source_properties",
        "data_source_id",
        source_id,
        selector,
    )
}
// Table and scope arguments are private fixed literals, never script input.
fn resolve_id(
    connection: &Connection,
    table: &str,
    scope: &str,
    source_id: &str,
    selector: &str,
) -> Result<String, StoreError> {
    let mut statement = connection.prepare(&format!("SELECT id FROM {table} WHERE {scope} = ?1 AND lifecycle = 'active' AND (id = ?2 OR name = ?2) ORDER BY id = ?2 DESC"))?;
    let ids = statement
        .query_map(params![source_id, selector], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if ids.first().is_some_and(|id| id == selector) || ids.len() == 1 {
        return Ok(ids[0].clone());
    }
    Err(invalid(
        "Selector is missing or ambiguous; use its stable ID",
    ))
}
fn ensure_new_name(
    connection: &Connection,
    table: &str,
    scope: &str,
    source_id: &str,
    name: &str,
) -> Result<(), StoreError> {
    // Match the semantic mutation's persisted name, including whitespace normalization.
    let name = validate_name(name, "Configuration entry name")?;
    let exists: bool = connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {scope} = ?1 AND lifecycle = 'active' AND name = ?2)"), params![source_id, name], |row| row.get(0))?;
    if exists {
        return Err(invalid(
            "A configuration entry with this name already exists",
        ));
    }
    Ok(())
}
fn fresh_id(prefix: &str) -> Result<String, StoreError> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes)
        .map_err(|_| internal("Configuration identity generation failed"))?;
    Ok(format!(
        "{prefix}{}",
        base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
    ))
}
