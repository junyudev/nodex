use nodex_core_contracts::database::{
    DatabaseViewCompletion, DatabaseViewDefinition, DatabaseViewField, DatabaseViewFilter,
    DatabaseViewFilterGroupOperator, DatabaseViewFilterOperator, DatabaseViewGroup,
    DatabaseViewHierarchy, DatabaseViewLayout, DatabaseViewLayoutDisplay, DatabaseViewNullOrder,
    DatabaseViewPresentation, DatabaseViewRules, DatabaseViewSort, DatabaseViewSortDirection,
    DatabaseViewSortField,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const VIEW_SCHEMA_KEY: &str = "nodex.database-view";
const VIEW_SCHEMA_VERSION: u32 = 6;
pub(super) const MAX_VIEW_SORT_RULES: usize = 128;

/// Storage envelope for the durable typed View definition. Schema markers
/// version the SQLite JSON encoding; they are not part of the domain command.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredViewDefinition {
    schema_key: String,
    schema_version: u32,
    rules: DatabaseViewRules,
    presentation: nodex_core_contracts::database::DatabaseViewPresentation,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredViewDefinitionV5 {
    schema_key: String,
    schema_version: u32,
    filter: DatabaseViewFilter,
    presentation: LegacyDatabaseViewPresentationV5,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDatabaseViewPresentationV5 {
    sort: Vec<DatabaseViewSort>,
    group: Option<DatabaseViewGroup>,
    subgroup: Option<DatabaseViewGroup>,
    group_direction: DatabaseViewSortDirection,
    completion: DatabaseViewCompletion,
    hierarchy: DatabaseViewHierarchy,
    display: DatabaseViewLayoutDisplay,
    #[serde(default)]
    conditional_colors: Vec<nodex_core_contracts::database::DatabaseViewConditionalColorRule>,
}

/// Published Store v142 owns this exact v4 envelope. Migration validation must
/// decode that source grammar before the v143 step upgrades it to the current
/// single-layout definition.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStoredViewDefinitionV4 {
    schema_key: String,
    schema_version: u32,
    filter: DatabaseViewFilter,
    presentation: LegacyDatabaseViewPresentationV4,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDatabaseViewPresentationV4 {
    sort: Vec<DatabaseViewSort>,
    group: Option<DatabaseViewGroup>,
    subgroup: Option<DatabaseViewGroup>,
    group_direction: DatabaseViewSortDirection,
    completion: DatabaseViewCompletion,
    hierarchy: DatabaseViewHierarchy,
    layouts: LegacyDatabaseViewLayoutsV4,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyDatabaseViewLayoutsV4 {
    board: LegacyDatabaseViewLayoutDisplayV4,
    list: LegacyDatabaseViewLayoutDisplayV4,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDatabaseViewLayoutDisplayV4 {
    fields: Vec<DatabaseViewField>,
    show_empty_groups: bool,
    #[serde(default = "default_show_description")]
    show_description: bool,
}

pub(crate) struct DatabaseViewValidationProjection {
    pub filter: DatabaseViewFilter,
    pub group: Option<DatabaseViewGroup>,
}

fn default_show_description() -> bool {
    true
}

impl LegacyStoredViewDefinitionV4 {
    fn decode(value: &str) -> Result<Self, String> {
        let stored = serde_json::from_str::<Self>(value)
            .map_err(|_| "Legacy Database View definition is invalid".to_owned())?;
        if stored.schema_key != VIEW_SCHEMA_KEY || stored.schema_version != 4 {
            return Err("Legacy Database View storage schema is unsupported".to_owned());
        }
        Ok(stored)
    }

    fn into_validation_projection(self) -> DatabaseViewValidationProjection {
        DatabaseViewValidationProjection {
            filter: self.filter,
            group: self.presentation.group,
        }
    }

    fn into_v5_definition(self, layout: DatabaseViewLayout) -> StoredViewDefinitionV5 {
        let LegacyDatabaseViewPresentationV4 {
            sort,
            group,
            subgroup,
            group_direction,
            completion,
            hierarchy,
            layouts,
        } = self.presentation;
        let display = match layout {
            DatabaseViewLayout::Board => layouts.board,
            DatabaseViewLayout::List => layouts.list,
        };
        let property_order = display
            .fields
            .iter()
            .filter_map(|field| match field {
                DatabaseViewField::Property { property_id } => Some(property_id.clone()),
                DatabaseViewField::Intrinsic { .. } => None,
            })
            .collect();
        StoredViewDefinitionV5 {
            schema_key: VIEW_SCHEMA_KEY.to_owned(),
            schema_version: 5,
            filter: self.filter,
            presentation: LegacyDatabaseViewPresentationV5 {
                sort,
                group,
                subgroup,
                group_direction,
                completion,
                hierarchy,
                display: DatabaseViewLayoutDisplay {
                    fields: display.fields,
                    property_order,
                    show_empty_groups: display.show_empty_groups,
                    show_description: display.show_description,
                },
                conditional_colors: Vec::new(),
            },
        }
    }
}

impl StoredViewDefinitionV5 {
    fn decode(value: &str) -> Result<Self, String> {
        let stored = serde_json::from_str::<Self>(value)
            .map_err(|_| "Legacy Database View definition is invalid".to_owned())?;
        if stored.schema_key != VIEW_SCHEMA_KEY || stored.schema_version != 5 {
            return Err("Legacy Database View storage schema is unsupported".to_owned());
        }
        Ok(stored)
    }

    fn into_current_definition(
        self,
        property_type: &impl Fn(&str) -> Option<String>,
    ) -> Result<DatabaseViewDefinition, String> {
        let filter = upgrade_v5_filter(self.filter, property_type)?;
        let LegacyDatabaseViewPresentationV5 {
            sort,
            group,
            subgroup,
            group_direction,
            completion,
            hierarchy,
            display,
            conditional_colors,
        } = self.presentation;
        let advanced_filter = match filter {
            DatabaseViewFilter::Group {
                operator: DatabaseViewFilterGroupOperator::And,
                children,
            } if children.is_empty() => None,
            group @ DatabaseViewFilter::Group { .. } => Some(group),
            clause @ DatabaseViewFilter::Clause { .. } => Some(DatabaseViewFilter::Group {
                operator: DatabaseViewFilterGroupOperator::And,
                children: vec![clause],
            }),
        };
        Ok(DatabaseViewDefinition {
            rules: DatabaseViewRules {
                property_filters: Vec::new(),
                advanced_filter,
                sorts: sort,
            },
            presentation: DatabaseViewPresentation {
                group,
                subgroup,
                group_direction,
                completion,
                hierarchy,
                display,
                conditional_colors,
            },
        })
    }
}

fn upgrade_v5_filter(
    filter: DatabaseViewFilter,
    property_type: &impl Fn(&str) -> Option<String>,
) -> Result<DatabaseViewFilter, String> {
    match filter {
        DatabaseViewFilter::Group { operator, children } => Ok(DatabaseViewFilter::Group {
            operator,
            children: children
                .into_iter()
                .map(|child| upgrade_v5_filter(child, property_type))
                .collect::<Result<Vec<_>, _>>()?,
        }),
        DatabaseViewFilter::Clause {
            property_id,
            operator,
            mut value,
        } => {
            let value_type = property_type(&property_id)
                .ok_or_else(|| "Legacy Database View filter Property is unavailable".to_owned())?;
            let operator = upgrade_legacy_filter_operator(operator, &value_type)?;
            if matches!(value_type.as_str(), "multi_select" | "relation") {
                value = match value {
                    Some(Some(Value::String(identity))) => {
                        Some(Some(serde_json::json!([identity])))
                    }
                    other => other,
                };
            }
            Ok(DatabaseViewFilter::Clause {
                property_id,
                operator,
                value,
            })
        }
    }
}

fn upgrade_legacy_filter_operator(
    operator: DatabaseViewFilterOperator,
    value_type: &str,
) -> Result<DatabaseViewFilterOperator, String> {
    use DatabaseViewFilterOperator as Current;
    let upgraded = match (operator, value_type) {
        (Current::IsEmpty, _) => Current::IsEmpty,
        (Current::IsNotEmpty, _) => Current::IsNotEmpty,
        (Current::Equals, "text") => Current::TextIs,
        (Current::NotEquals, "text") => Current::TextIsNot,
        (Current::Contains, "text") => Current::TextContains,
        (Current::NotContains, "text") => Current::TextDoesNotContain,
        (Current::Equals, "number") => Current::NumberEquals,
        (Current::NotEquals, "number") => Current::NumberDoesNotEqual,
        (Current::Equals, "checkbox") => Current::CheckboxIs,
        (Current::NotEquals, "checkbox") => Current::CheckboxIsNot,
        (Current::Equals, "select") => Current::SelectIs,
        (Current::NotEquals, "select") => Current::SelectIsNot,
        (Current::Equals | Current::Contains, "multi_select") => Current::MultiSelectContainsAll,
        (Current::NotEquals | Current::NotContains, "multi_select") => {
            Current::MultiSelectDoesNotContain
        }
        (Current::Equals, "date" | "datetime") => Current::DateIs,
        (Current::NotEquals, "date" | "datetime") => Current::DateIsNot,
        (Current::Contains, "relation") => Current::RelationContains,
        (Current::NotContains, "relation") => Current::RelationDoesNotContain,
        _ => return Err("Legacy Database View filter operator is incompatible".to_owned()),
    };
    Ok(upgraded)
}

impl StoredViewDefinition {
    fn from_definition(definition: &DatabaseViewDefinition) -> Self {
        Self {
            schema_key: VIEW_SCHEMA_KEY.to_owned(),
            schema_version: VIEW_SCHEMA_VERSION,
            rules: definition.rules.clone(),
            presentation: definition.presentation.clone(),
        }
    }

    fn into_definition(self) -> Result<DatabaseViewDefinition, String> {
        if self.schema_key != VIEW_SCHEMA_KEY || self.schema_version != VIEW_SCHEMA_VERSION {
            return Err("Database View storage schema is unsupported".to_owned());
        }
        Ok(DatabaseViewDefinition {
            rules: self.rules,
            presentation: self.presentation,
        })
    }
}

pub(super) fn encode_definition_json(
    definition: &DatabaseViewDefinition,
) -> Result<String, String> {
    serde_json::to_string(&StoredViewDefinition::from_definition(definition))
        .map_err(|_| "Database View definition cannot be encoded".to_owned())
}

pub(crate) fn decode_definition_json(value: &str) -> Result<DatabaseViewDefinition, String> {
    serde_json::from_str::<StoredViewDefinition>(value)
        .map_err(|_| "Database View definition is invalid".to_owned())?
        .into_definition()
}

pub(crate) fn decode_definition_validation_json(
    value: &str,
) -> Result<DatabaseViewValidationProjection, String> {
    let definition = decode_definition_json(value)?;
    Ok(DatabaseViewValidationProjection {
        filter: effective_filter(&definition.rules),
        group: definition.presentation.group,
    })
}

pub(crate) fn decode_legacy_definition_validation_json(
    value: &str,
) -> Result<DatabaseViewValidationProjection, String> {
    Ok(LegacyStoredViewDefinitionV4::decode(value)?.into_validation_projection())
}

pub(crate) fn decode_v5_definition_validation_json(
    value: &str,
) -> Result<DatabaseViewValidationProjection, String> {
    let definition = StoredViewDefinitionV5::decode(value)?;
    Ok(DatabaseViewValidationProjection {
        filter: definition.filter,
        group: definition.presentation.group,
    })
}

pub(crate) fn upgrade_legacy_definition_json(
    value: &str,
    layout: DatabaseViewLayout,
) -> Result<String, String> {
    serde_json::to_string(&LegacyStoredViewDefinitionV4::decode(value)?.into_v5_definition(layout))
        .map_err(|_| "Legacy Database View definition cannot be encoded".to_owned())
}

pub(crate) fn upgrade_v5_definition_json(
    value: &str,
    property_type: &impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let definition =
        StoredViewDefinitionV5::decode(value)?.into_current_definition(property_type)?;
    encode_definition_json(&definition)
}

pub(crate) fn upgrade_v5_filter_value(
    value: Value,
    property_type: &impl Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    let filter = serde_json::from_value::<DatabaseViewFilter>(value)
        .map_err(|_| "Legacy Database View filter is invalid".to_owned())?;
    serde_json::to_value(upgrade_v5_filter(filter, property_type)?)
        .map_err(|_| "Database View filter cannot be encoded".to_owned())
}

pub(crate) fn effective_filter(rules: &DatabaseViewRules) -> DatabaseViewFilter {
    let mut children = rules
        .property_filters
        .iter()
        .filter_map(|filter| effective_filter_node(&filter.clause))
        .collect::<Vec<_>>();
    if let Some(advanced) = &rules.advanced_filter {
        children.extend(effective_filter_node(advanced));
    }
    DatabaseViewFilter::Group {
        operator: DatabaseViewFilterGroupOperator::And,
        children,
    }
}

fn effective_filter_node(filter: &DatabaseViewFilter) -> Option<DatabaseViewFilter> {
    match filter {
        DatabaseViewFilter::Clause {
            operator, value, ..
        } if filter_value_is_empty(*operator, value.as_ref().and_then(Option::as_ref)) => None,
        DatabaseViewFilter::Clause { .. } => Some(filter.clone()),
        DatabaseViewFilter::Group { operator, children } => {
            let children = children
                .iter()
                .filter_map(effective_filter_node)
                .collect::<Vec<_>>();
            (!children.is_empty()).then_some(DatabaseViewFilter::Group {
                operator: *operator,
                children,
            })
        }
    }
}

pub(crate) fn filter_value_is_empty(
    operator: DatabaseViewFilterOperator,
    value: Option<&Value>,
) -> bool {
    if matches!(
        operator,
        DatabaseViewFilterOperator::IsEmpty | DatabaseViewFilterOperator::IsNotEmpty
    ) {
        return false;
    }
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(value)) => value.is_empty(),
        Some(Value::Array(values)) => values.is_empty(),
        Some(Value::Object(range)) if operator == DatabaseViewFilterOperator::DateWithin => {
            range
                .get("start")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || range
                    .get("end")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
        }
        _ => false,
    }
}

pub(super) fn decode_definition_value(value: Value) -> Result<DatabaseViewDefinition, String> {
    serde_json::from_value::<StoredViewDefinition>(value)
        .map_err(|_| "Database View definition is invalid".to_owned())?
        .into_definition()
}

/// The View-global fractional rank is the stable final order for an empty or
/// Property-only sort tuple. An explicit Manual rule may place that rank at a
/// deliberate point in a larger tuple and owns its direction.
pub(crate) fn fractional_order_direction(
    sort: &[DatabaseViewSort],
) -> Option<DatabaseViewSortDirection> {
    if let Some(manual) = sort
        .iter()
        .find(|rule| rule.field == DatabaseViewSortField::Manual)
    {
        return Some(manual.direction);
    }
    sort.iter()
        .all(|rule| matches!(rule.field, DatabaseViewSortField::Property { .. }))
        .then_some(DatabaseViewSortDirection::Asc)
}

/// The one View definition whose row order and group semantics can be shared
/// by primary Board writes and exact singleton projection patches.
pub(crate) fn is_exact_primary_board_definition(definition: &DatabaseViewDefinition) -> bool {
    let has_empty_filter =
        definition.rules.property_filters.is_empty() && definition.rules.advanced_filter.is_none();
    let has_manual_sort = matches!(
        definition.rules.sorts.as_slice(),
        [rule]
            if rule.field == DatabaseViewSortField::Manual
                && rule.direction == DatabaseViewSortDirection::Asc
                && rule.nulls == DatabaseViewNullOrder::Last
    );
    let has_status_group = definition.presentation.group.as_ref()
        == Some(&DatabaseViewGroup {
            property_id: "status".to_owned(),
        });
    has_empty_filter && has_manual_sort && has_status_group
}

pub(crate) fn is_exact_primary_board_config(config: &Value) -> bool {
    decode_definition_value(config.clone())
        .is_ok_and(|definition| is_exact_primary_board_definition(&definition))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::{
        decode_definition_json, decode_definition_value, effective_filter, encode_definition_json,
        upgrade_v5_definition_json,
    };

    fn stored_definition() -> Value {
        json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 6,
            "rules": {
                "propertyFilters": [],
                "advancedFilter": null,
                "sorts": [{
                    "field": { "kind": "manual" },
                    "direction": "asc",
                    "nulls": "last"
                }]
            },
            "presentation": {
                "group": { "propertyId": "status" },
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "display": { "fields": [], "showEmptyGroups": false }
            }
        })
    }

    fn stored_v5_definition() -> Value {
        json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 5,
            "filter": {
                "kind": "group",
                "operator": "and",
                "children": [
                    {
                        "kind": "clause",
                        "propertyId": "status",
                        "operator": "equals",
                        "value": "build"
                    },
                    {
                        "kind": "clause",
                        "propertyId": "tags",
                        "operator": "contains",
                        "value": "tag-a"
                    }
                ]
            },
            "presentation": {
                "sort": [{
                    "field": { "kind": "created" },
                    "direction": "desc",
                    "nulls": "last"
                }],
                "group": null,
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "display": { "fields": [], "showEmptyGroups": false }
            }
        })
    }

    #[test]
    fn storage_envelope_round_trips_a_strict_typed_definition() {
        let definition =
            decode_definition_value(stored_definition()).expect("typed View definition");
        let encoded = encode_definition_json(&definition).expect("storage encoding");
        let round_tripped = decode_definition_json(&encoded).expect("round-tripped definition");

        assert_eq!(round_tripped, definition);
    }

    #[test]
    fn storage_envelope_rejects_unknown_fields_and_versions() {
        let mut unsupported = stored_definition();
        unsupported["schemaVersion"] = json!(5);
        assert!(decode_definition_value(unsupported).is_err());

        let mut unknown = stored_definition();
        unknown["rules"]["extra"] = json!(true);
        assert!(decode_definition_value(unknown).is_err());
    }

    #[test]
    fn effective_filter_prunes_incomplete_quick_and_advanced_drafts() {
        let mut stored = stored_definition();
        stored["rules"]["propertyFilters"] = json!([{
            "filterId": "filter-empty-number",
            "clause": {
                "kind": "clause",
                "propertyId": "estimate",
                "operator": "number_equals",
                "value": null
            }
        }]);
        stored["rules"]["advancedFilter"] = json!({
            "kind": "group",
            "operator": "or",
            "children": [
                {
                    "kind": "clause",
                    "propertyId": "due",
                    "operator": "date_within",
                    "value": { "start": "2026-08-01", "end": "" }
                },
                {
                    "kind": "clause",
                    "propertyId": "status",
                    "operator": "select_is",
                    "value": "build"
                }
            ]
        });
        let definition = decode_definition_value(stored).expect("draft View definition");

        assert_eq!(
            serde_json::to_value(effective_filter(&definition.rules)).expect("effective filter"),
            json!({
                "kind": "group",
                "operator": "and",
                "children": [{
                    "kind": "group",
                    "operator": "or",
                    "children": [{
                        "kind": "clause",
                        "propertyId": "status",
                        "operator": "select_is",
                        "value": "build"
                    }]
                }]
            })
        );
    }

    #[test]
    fn v5_upgrade_types_operators_and_membership_values() {
        let encoded =
            upgrade_v5_definition_json(&stored_v5_definition().to_string(), &|property_id| {
                match property_id {
                    "status" => Some("select".to_owned()),
                    "tags" => Some("multi_select".to_owned()),
                    _ => None,
                }
            })
            .expect("upgrade v5 definition");
        let upgraded = serde_json::from_str::<Value>(&encoded).expect("v6 JSON");

        assert_eq!(upgraded["schemaVersion"], 6);
        assert_eq!(
            upgraded["rules"]["advancedFilter"]["children"][0]["operator"],
            "select_is"
        );
        assert_eq!(
            upgraded["rules"]["advancedFilter"]["children"][1]["operator"],
            "multi_select_contains_all"
        );
        assert_eq!(
            upgraded["rules"]["advancedFilter"]["children"][1]["value"],
            json!(["tag-a"])
        );
        assert_eq!(upgraded["rules"]["sorts"][0]["field"]["kind"], "created");
    }
}
