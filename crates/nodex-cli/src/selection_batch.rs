//! Freeze SQL-selected identities into revision-fenced semantic Property edits.
use crate::{
    error::{CliError, CliErrorCode},
    runtime::{CommandOutput, unwrap_library},
};
use clap::Args;
use nodex_core_contracts::database::{
    DatabasePagePropertyAddress, DatabasePropertyValueEdit, DatabasePropertyValueInput,
    DatabasePropertyValueMutation,
};
use nodex_core_contracts::library::{LibraryPageDataSourceContext, LibraryRead, LibraryReadValue};
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Clone, Debug, PartialEq, Args)]
#[command(group(clap::ArgGroup::new("batch_values").required(true).args(["values", "set"])))]
pub struct PrepareBatchArgs {
    /// SQL JSON output containing page_id and data_source_id columns.
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
    targets: Vec<(String, String)>,
    values: BTreeMap<String, DatabasePropertyValueInput>,
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
fn targets(selection: Selection) -> Result<Vec<(String, String)>, CliError> {
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
    let mut targets = BTreeSet::new();
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
        targets.insert((id(page)?, id(source)?));
    }
    if targets.is_empty() || targets.len() > 4096 {
        return Err(invalid("Selection requires 1–4096 distinct targets"));
    }
    Ok(targets.into_iter().collect())
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
    for (page_id, data_source_id) in prepared.targets {
        let snapshot = unwrap_library(client.library_read(
            Some(project_id),
            LibraryRead::PageDetail {
                page_id: page_id.clone(),
            },
        ))?;
        let LibraryReadValue::PageDetail { value } = snapshot.value else {
            return Err(invalid("Unexpected Page detail result"));
        };
        let LibraryPageDataSourceContext::Member {
            membership,
            properties,
            values,
            ..
        } = value.data_source_context
        else {
            return Err(invalid("Selected Page no longer belongs to a Data Source"));
        };
        if membership.data_source_id != data_source_id {
            return Err(invalid(
                "Selected Page changed its Data Source; select again",
            ));
        }
        let mut property_ids = BTreeSet::new();
        for (selector, replacement) in &prepared.values {
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
            let revision = match values.get(&property.property_id) {
                Some(record) => record
                    .get("revision")
                    .and_then(serde_json::Value::as_i64)
                    .ok_or_else(|| invalid("Page Property revision is missing"))?,
                None => 0,
            };
            edits.push(DatabasePropertyValueMutation {
                address: DatabasePagePropertyAddress {
                    page_id: page_id.clone(),
                    data_source_id: data_source_id.clone(),
                    property_id: property.property_id.clone(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision: revision,
                    value: replacement.clone(),
                },
            });
        }
    }
    serde_json::to_value(BatchEdits { edits })
        .map(CommandOutput::Json)
        .map_err(|error| invalid(error.to_string()))
}
fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freezes_unique_targets_and_rejects_ambiguous_or_aggregated_results() {
        let selection = serde_json::from_value(serde_json::json!({"columns":["page_id","data_source_id"],"rows":[["page-a","source-a"],["page-a","source-a"]]})).unwrap();
        assert_eq!(
            targets(selection).unwrap(),
            vec![("page-a".into(), "source-a".into())]
        );
        for selection in [
            serde_json::json!({"columns":["count"],"rows":[[10]]}),
            serde_json::json!({"columns":["page_id","page_id","data_source_id"],"rows":[["a","b","s"]]}),
        ] {
            assert!(targets(serde_json::from_value(selection).unwrap()).is_err());
        }
    }
}
