//! Canonical scalar value snapshots shared by data and List history compilers.

use super::*;
use nodex_core_contracts::database::DatabasePropertyType;

pub(crate) fn scalar_type(property: &PropertyRow) -> Option<DatabasePropertyType> {
    Some(match property.value_type.as_str() {
        "text" => DatabasePropertyType::Text,
        "number" => DatabasePropertyType::Number,
        "checkbox" => DatabasePropertyType::Checkbox,
        "select" => DatabasePropertyType::Select,
        "multi_select" => DatabasePropertyType::MultiSelect,
        "date" => DatabasePropertyType::Date,
        "datetime" => DatabasePropertyType::Datetime,
        _ => return None,
    })
}

pub(crate) fn input_from_value(
    property: &PropertyRow,
    value: &Value,
) -> Result<DatabasePropertyValueInput, StoreError> {
    if value.is_null() {
        return Ok(DatabasePropertyValueInput::Empty);
    }
    match scalar_type(property) {
        Some(DatabasePropertyType::Text) => {
            value
                .as_str()
                .map(|value| DatabasePropertyValueInput::Text {
                    value: value.to_owned(),
                })
        }
        Some(DatabasePropertyType::Number) => value
            .as_f64()
            .map(|value| DatabasePropertyValueInput::Number { value }),
        Some(DatabasePropertyType::Checkbox) => value
            .as_bool()
            .map(|value| DatabasePropertyValueInput::Checkbox { value }),
        Some(DatabasePropertyType::Select) => {
            value
                .as_str()
                .map(|option_id| DatabasePropertyValueInput::Select {
                    option_id: option_id.to_owned(),
                })
        }
        Some(DatabasePropertyType::MultiSelect) => value
            .as_array()
            .and_then(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .map(|option_ids| DatabasePropertyValueInput::MultiSelect { option_ids }),
        Some(DatabasePropertyType::Date) => {
            value
                .as_str()
                .map(|value| DatabasePropertyValueInput::Date {
                    value: value.to_owned(),
                })
        }
        Some(DatabasePropertyType::Datetime) => {
            value
                .as_str()
                .map(|value| DatabasePropertyValueInput::Datetime {
                    value: value.to_owned(),
                })
        }
        _ => return Err(invalid("This Property type has no scalar history inverse")),
    }
    .ok_or_else(|| corrupt("A Database Property value is invalid"))
}

pub(crate) fn current_property_state(
    connection: &Connection,
    data_source_id: &str,
    page_id: &str,
    property_id: &str,
) -> Result<(PropertyRow, DatabasePropertyValueInput, i64), StoreError> {
    let property = active_property(connection, data_source_id, property_id)?;
    let membership_id = active_row_membership(connection, data_source_id, page_id)?;
    let row = connection.query_row(
        "SELECT value_json, revision FROM data_source_property_values WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
        params![data_source_id, membership_id, property_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    ).optional()?;
    let (raw, revision) = match row {
        Some((json, revision)) => (parse_json(&json, "Database Property value")?, revision),
        None => (Value::Null, 0),
    };
    let input = input_from_value(&property, &raw)?;
    Ok((property, input, revision))
}
