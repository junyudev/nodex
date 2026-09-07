//! Freeze SQL-selected identities into revision-fenced semantic Property edits.
use crate::{
    error::{CliError, CliErrorCode},
    runtime::{CommandOutput, unwrap_database},
};
use clap::Args;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::database::{
    DatabasePagePropertyAddress, DatabasePropertyValueEdit, DatabasePropertyValueInput,
    DatabasePropertyValueMutation, DatabaseRead, DatabaseReadValue,
};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Clone, Debug, PartialEq, Args)]
#[command(group(clap::ArgGroup::new("batch_values").required(true).args(["values", "set"])))]
pub struct PrepareBatchArgs {
    /// SQL JSON output containing identities, membership_revision and value_revisions.
    #[arg(long)]
    pub selection: PathBuf,
    /// JSON object mapping Property IDs or names to typed replacement values.
    #[arg(long)]
    pub values: Option<PathBuf>,
    /// Repeat NAME=JSON for typed replacement values without a separate file.
    #[arg(long)]
    pub set: Vec<String>,
    #[arg(skip)]
    pub prepared: Option<PreparedSelection>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSelection {
    targets: Vec<ObservedTarget>,
    values: BTreeMap<String, DatabasePropertyValueInput>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedTarget {
    page_id: String,
    data_source_id: String,
    membership_revision: i64,
    value_revisions: BTreeMap<String, i64>,
}
pub(crate) type Selection = nodex_core_contracts::sql::SqlResult;
pub(crate) type SelectionInput = crate::input_document::InputDocument<Selection>;
#[derive(Serialize, utoipa::ToSchema)]
pub(crate) struct BatchEdits {
    pub edits: Vec<DatabasePropertyValueMutation>,
}

pub(crate) fn prepare(args: &mut PrepareBatchArgs) -> Result<(), CliError> {
    if args.selection.as_os_str() == "-"
        && args
            .values
            .as_ref()
            .is_some_and(|path| path.as_os_str() == "-")
    {
        return Err(invalid(
            "Only one of --selection and --values can read stdin",
        ));
    }
    let selection =
        crate::input::read_json::<SelectionInput>(&args.selection, "SQL selection")?.into_inner();
    let values: BTreeMap<String, DatabasePropertyValueInput> = if let Some(path) = &args.values {
        crate::input::read_json(path, "Batch Property values")?
    } else {
        let mut values = BTreeMap::new();
        for assignment in &args.set {
            let (name, json) = assignment
                .split_once('=')
                .ok_or_else(|| invalid("--set requires NAME=JSON"))?;
            if name.trim().is_empty() {
                return Err(invalid("--set requires a Property name or ID"));
            }
            let value = crate::input::decode_json(json.as_bytes(), "Typed Property value")?;
            if values.insert(name.to_owned(), value).is_some() {
                return Err(invalid("--set repeats a Property selector"));
            }
        }
        values
    };
    let targets = targets(selection)?;
    if values.is_empty() || targets.len().saturating_mul(values.len()) > 4096 {
        return Err(invalid("Batch requires 1–4096 Property edits"));
    }
    let replacement_bytes = serde_json::to_vec(&values)
        .map_err(|error| invalid(error.to_string()))?
        .len();
    if replacement_bytes.saturating_mul(targets.len()) > crate::input::MAX_JSON_BYTES {
        return Err(invalid(
            "Expanded batch replacements exceed 2 MiB; reduce the selected targets",
        ));
    }
    args.prepared = Some(PreparedSelection { targets, values });
    Ok(())
}
fn targets(selection: Selection) -> Result<Vec<ObservedTarget>, CliError> {
    let column = |name: &str| {
        let matches = selection
            .columns
            .iter()
            .enumerate()
            .filter(|(_, value)| value.as_str() == name)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(invalid(format!(
                "Selection requires exactly one {name} column"
            )));
        }
        Ok(matches[0])
    };
    let page = column("page_id")?;
    let source = column("data_source_id")?;
    let membership = column("membership_revision")?;
    let revisions = column("value_revisions")?;
    let mut targets = BTreeMap::new();
    for row in selection.rows {
        if row.len() != selection.columns.len() {
            return Err(invalid("Selection row does not match columns"));
        }
        let id = |index: usize| {
            row[index]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid("Selection identities must be nonempty strings"))
        };
        let membership_revision = row[membership]
            .as_i64()
            .filter(|revision| *revision > 0)
            .ok_or_else(|| invalid("Selection membership_revision must be a positive integer"))?;
        let revision_value = match &row[revisions] {
            serde_json::Value::String(json) => serde_json::from_str(json)
                .map_err(|_| invalid("Selection value_revisions must be a JSON object"))?,
            value => value.clone(),
        };
        let value_revisions: BTreeMap<String, i64> = serde_json::from_value(revision_value)
            .map_err(|_| {
                invalid("Selection value_revisions must map Property IDs to integer revisions")
            })?;
        if value_revisions
            .iter()
            .any(|(id, revision)| id.trim().is_empty() || *revision < 0)
        {
            return Err(invalid(
                "Selection Property IDs must be nonempty and revisions nonnegative",
            ));
        }
        let target = ObservedTarget {
            page_id: id(page)?,
            data_source_id: id(source)?,
            membership_revision,
            value_revisions,
        };
        let key = (target.page_id.clone(), target.data_source_id.clone());
        if let Some(previous) = targets.insert(key, target.clone())
            && previous != target
        {
            return Err(invalid(
                "Duplicate selection target has conflicting observed revisions",
            ));
        }
    }
    if targets.is_empty() || targets.len() > 4096 {
        return Err(invalid("Selection requires 1–4096 distinct targets"));
    }
    Ok(targets.into_values().collect())
}
pub(crate) fn execute(
    client: &CoreClient,
    project_id: &str,
    args: PrepareBatchArgs,
) -> Result<CommandOutput, CliError> {
    let prepared = args
        .prepared
        .ok_or_else(|| invalid("Batch selection was not prepared"))?;
    let mut edits = Vec::new();
    let mut schemas = BTreeMap::new();
    for target in prepared.targets {
        if let std::collections::btree_map::Entry::Vacant(entry) =
            schemas.entry(target.data_source_id.clone())
        {
            entry.insert(load_properties(client, project_id, &target.data_source_id)?);
        }
        edits.extend(prepare_target_edits(
            &target,
            &schemas[&target.data_source_id],
            &prepared.values,
        )?);
    }
    serde_json::to_value(BatchEdits { edits })
        .map(CommandOutput::Json)
        .map_err(|error| invalid(error.to_string()))
}
fn load_properties(
    client: &CoreClient,
    project_id: &str,
    source_id: &str,
) -> Result<Vec<nodex_core_contracts::database::DatabasePropertyDescriptor>, CliError> {
    let mut properties = Vec::new();
    let mut after = None;
    loop {
        let snapshot = unwrap_database(client.database_read(
            Some(project_id),
            DatabaseRead::PropertyWindow {
                data_source_id: source_id.to_owned(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            },
        ))?;
        let DatabaseReadValue::PropertyWindow { properties: window } = snapshot.value else {
            return Err(invalid("Unexpected Property catalog result"));
        };
        properties.extend(window.items);
        if properties.len() > 4096 {
            return Err(invalid(
                "Source schema exceeds the batch preparation budget",
            ));
        }
        after = window.next_cursor;
        if after.is_none() {
            return Ok(properties);
        }
    }
}
fn prepare_target_edits(
    target: &ObservedTarget,
    properties: &[nodex_core_contracts::database::DatabasePropertyDescriptor],
    values: &BTreeMap<String, DatabasePropertyValueInput>,
) -> Result<Vec<DatabasePropertyValueMutation>, CliError> {
    let mut edits = Vec::new();
    let mut property_ids = BTreeSet::new();
    for (selector, replacement) in values {
        let exact = properties
            .iter()
            .find(|property| property.property_id == *selector);
        let names = properties
            .iter()
            .filter(|property| property.name == *selector)
            .collect::<Vec<_>>();
        let property = exact
            .or_else(|| {
                if names.len() == 1 {
                    Some(names[0])
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                invalid(format!(
                    "Property {selector} is missing or ambiguous; use its ID"
                ))
            })?;
        if !property_ids.insert(property.property_id.clone()) {
            return Err(invalid(
                "Batch addresses the same Property through multiple selectors",
            ));
        }
        let revision = observed_value_revision(&target.value_revisions, &property.property_id)?;
        edits.push(DatabasePropertyValueMutation {
            expected_membership_revision: Some(target.membership_revision),
            address: DatabasePagePropertyAddress {
                page_id: target.page_id.clone(),
                data_source_id: target.data_source_id.clone(),
                property_id: property.property_id.clone(),
            },
            edit: DatabasePropertyValueEdit::Replace {
                expected_value_revision: revision,
                value: replacement.clone(),
            },
        });
    }
    Ok(edits)
}
fn observed_value_revision(
    revisions: &BTreeMap<String, i64>,
    property_id: &str,
) -> Result<i64, CliError> {
    revisions.get(property_id).copied().ok_or_else(|| invalid(format!(
        "Selection has no observed revision for Property {property_id}; query value_revisions again"
    )))
}
fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection(rows: serde_json::Value) -> Selection {
        serde_json::from_value(serde_json::json!({
            "columns": ["page_id", "data_source_id", "membership_revision", "value_revisions"],
            "rows": rows,
            "snapshot": "observation-test", "returned_count": 1
        }))
        .unwrap()
    }
    #[test]
    fn deduplicates_only_identical_observations() {
        let rows = serde_json::json!([["a","s",1,{"p":0}],["a","s",1,{"p":0}]]);
        assert_eq!(targets(selection(rows)).unwrap().len(), 1);
        for rows in [
            serde_json::json!([["a","s",1,{"p":0}],["a","s",2,{"p":0}]]),
            serde_json::json!([["a","s",1,{"p":0}],["a","s",1,{"p":1}]]),
        ] {
            assert!(targets(selection(rows)).is_err());
        }
    }
    #[test]
    fn rejects_missing_or_invalid_observations() {
        for row in [
            serde_json::json!(["a","s",0,{"p":0}]),
            serde_json::json!(["a","s",1,{"p":-1}]),
            serde_json::json!(["a", "s", 1, null]),
            serde_json::json!(["a","s",1,{"p":1.5}]),
        ] {
            assert!(targets(selection(serde_json::json!([row]))).is_err());
        }
        let mut missing = selection(serde_json::json!([]));
        missing.columns.pop();
        assert!(targets(missing).is_err());
        assert!(observed_value_revision(&BTreeMap::new(), "p").is_err());
    }
    #[test]
    fn accepts_sql_json_text_and_preserves_zero_revision() {
        let targets = targets(selection(serde_json::json!([["a", "s", 1, "{\"p\":0}"]]))).unwrap();
        assert_eq!(
            observed_value_revision(&targets[0].value_revisions, "p").unwrap(),
            0
        );
    }
}
