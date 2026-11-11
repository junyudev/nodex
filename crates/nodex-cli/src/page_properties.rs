use crate::cli::MutationArgs;
use crate::data_source::stable_id;
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, CompactReceipt, map_client_error, map_core_error, resolve_page_selector,
    selected_project, unwrap_library,
};
use clap::{Args, Subcommand};
use nodex_core_contracts::database::{
    DatabaseIntent, DatabasePagePropertyResult, DatabasePagePropertyUpdate,
    DatabasePropertyValueMutation,
};
use nodex_core_contracts::library::LibraryPageCopyValue;
use nodex_core_contracts::{DATABASE_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch};
use nodex_core_protocol::{ResponseEnvelope, client::CoreClient};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct PagePropertiesArgs {
    #[command(subcommand)]
    pub command: PagePropertiesCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum PagePropertiesCommand {
    /// Freeze SQL result targets and observed Property revisions into an apply document.
    PrepareBatch(crate::selection_batch::PrepareBatchArgs),
    /// Atomically apply typed Property edits from JSON.
    Apply {
        /// Typed Property edits JSON or a prepare-batch result; - reads stdin.
        #[arg(long, default_value = "-")]
        input: PathBuf,
        #[arg(skip)]
        prepared: Option<PropertyApplyInput>,
        #[command(flatten)]
        mutation: MutationArgs,
    },
    /// Set Properties on one or several Pages atomically.
    Set(PropertySetArgs),
}
#[derive(Clone, Debug, PartialEq, Args)]
pub struct PropertySetArgs {
    /// Page IDs, Page keys, or uniquely resolvable title paths.
    #[arg(value_name = "PAGE", conflicts_with = "selection")]
    pub pages: Vec<String>,
    /// SQL JSON result containing a page_id or page_key column; - reads stdin.
    #[arg(long)]
    pub selection: Option<PathBuf>,
    #[command(flatten)]
    pub values: PropertyValuesArgs,
    /// member:<id>, me, agent:<instance>/<model>[/<effort>], or none.
    #[arg(long)]
    pub assignee: Option<String>,
    /// Member identity (member:<id>) or me.
    #[arg(long)]
    pub owner: Option<String>,
    /// Whether an Agent Assignee starts on its own once its prerequisites are Done.
    #[arg(long, value_name = "true|false")]
    pub auto_start: Option<bool>,
    #[arg(skip)]
    pub(crate) prepared: Option<PreparedSet>,
    /// Optional value revision when setting one Property on one Page.
    #[arg(long)]
    pub if_revision: Option<i64>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}
impl PropertySetArgs {
    fn edits_work(&self) -> bool {
        self.assignee.is_some() || self.owner.is_some() || self.auto_start.is_some()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedSet {
    pages: Vec<String>,
    values: Vec<LibraryPageCopyValue>,
}

#[derive(Clone, Debug, PartialEq, Args)]
pub struct PropertyValuesArgs {
    /// Replace a Property value. Use NAME=VALUE. Arrays, numbers and booleans use JSON.
    #[arg(long, value_name = "PROPERTY=VALUE")]
    pub set: Vec<String>,
    /// Clear a Property value.
    #[arg(long, value_name = "PROPERTY")]
    pub clear: Vec<String>,
}

impl PropertyValuesArgs {
    pub(crate) fn values(&self) -> Result<Vec<LibraryPageCopyValue>, CliError> {
        self.set
            .iter()
            .map(|assignment| {
                let (property, value) = property_assignment(assignment)?;
                let value = if value == "null" {
                    serde_json::Value::String(value.to_owned())
                } else {
                    serde_json::from_str(value)
                        .unwrap_or_else(|_| serde_json::Value::String(value.to_owned()))
                };
                Ok(LibraryPageCopyValue {
                    property_id: stable_id(&property)?,
                    value,
                })
            })
            .chain(self.clear.iter().map(|property| {
                Ok(LibraryPageCopyValue {
                    property_id: stable_id(property)?,
                    value: serde_json::Value::Null,
                })
            }))
            .collect()
    }
}

fn property_assignment(input: &str) -> Result<(String, &str), CliError> {
    let invalid_assignment = || {
        invalid(
            "--set expects PROPERTY=VALUE, for example --set Status=done. Use a JSON string for a Property name containing '='.",
        )
    };
    if input.starts_with('"') {
        let mut property = serde_json::Deserializer::from_str(input).into_iter::<String>();
        let selector = property
            .next()
            .ok_or_else(invalid_assignment)?
            .map_err(|_| invalid_assignment())?;
        let value = input[property.byte_offset()..]
            .strip_prefix('=')
            .ok_or_else(invalid_assignment)?;
        return Ok((selector, value));
    }
    input
        .split_once('=')
        .map(|(property, value)| (property.to_owned(), value))
        .ok_or_else(invalid_assignment)
}

#[derive(serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
enum PropertyBatchStatus {
    Committed,
    Duplicate,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct PropertyBatchReceipt {
    status: PropertyBatchStatus,
    operation_id: String,
    commit_seq: i64,
    pages: Vec<DatabasePagePropertyResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<nodex_core_contracts::database::DatabaseCommitValue>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PropertyApplyInput {
    #[schema(min_items = 1, max_items = 4096)]
    pub edits: Vec<DatabasePropertyValueMutation>,
}

pub(crate) type PropertyApplyDocument = crate::input_document::InputDocument<PropertyApplyInput>;

pub(crate) fn prepare(args: &mut PagePropertiesArgs) -> Result<(), CliError> {
    match &mut args.command {
        PagePropertiesCommand::PrepareBatch(args) => return crate::selection_batch::prepare(args),
        PagePropertiesCommand::Apply {
            input, prepared, ..
        } => {
            *prepared = Some(read_property_edits(input)?);
        }
        PagePropertiesCommand::Set(args) => {
            let values = args.values.values()?;
            if values.is_empty() && !args.edits_work() {
                return Err(invalid(
                    "Use `nodex page properties set PAGE --set PROPERTY=VALUE`, for example `nodex page properties set NODEX-4 --set Status=done`.",
                ));
            }
            let pages = match &args.selection {
                Some(path) => selection_pages(path)?,
                None => args.pages.clone(),
            };
            if pages.is_empty() {
                return Err(invalid("Specify at least one Page or use --selection FILE"));
            }
            args.prepared = Some(PreparedSet { pages, values });
        }
    }
    Ok(())
}
fn read_property_edits(path: &Path) -> Result<PropertyApplyInput, CliError> {
    use crate::input::{MAX_JSON_BYTES, decode_json, read_bytes, with_schema_hint};
    const LABEL: &str = "Property edits";
    let bytes = read_bytes(path, MAX_JSON_BYTES, LABEL)?;
    let shape: serde_json::Value = decode_json(&bytes, LABEL)?;
    crate::input_document::decode(&bytes, &shape, LABEL).map_err(|error| {
        with_schema_hint(
            refine_edit_kind_error(&shape, error),
            "page properties apply",
        )
    })
}

fn refine_edit_kind_error(shape: &serde_json::Value, error: CliError) -> CliError {
    use nodex_core_contracts::database::{DatabasePropertySetDelta, DatabasePropertyValueInput};
    let Some(path) = error.path.as_deref() else {
        return error;
    };
    let (payload, path_without_result) = path
        .strip_prefix("result.")
        .map_or((shape, path), |path| (&shape["result"], path));
    let Some(index) = path_without_result
        .strip_prefix("edits[")
        .and_then(|path| path.strip_suffix("].edit"))
        .and_then(|index| index.parse::<usize>().ok())
    else {
        return error;
    };
    let edit = &payload["edits"][index]["edit"];
    let (field, nested_error) = match edit["kind"].as_str() {
        Some("replace") => (
            "value",
            DatabasePropertyValueInput::deserialize(&edit["value"]).err(),
        ),
        Some("patch_set") => (
            "delta",
            DatabasePropertySetDelta::deserialize(&edit["delta"]).err(),
        ),
        _ => ("", None),
    };
    if let Some(nested) =
        nested_error.filter(|nested| nested.to_string().starts_with("unknown variant"))
    {
        let field_path = format!("{path}.{field}.kind");
        let message = if field == "value" && edit[field]["kind"] == "relation" {
            "Relation values use replace_one_relation, patch_set, or clear_many_relation.".into()
        } else {
            nested.to_string()
        };
        return invalid(&format!("{field_path}: {message}")).at_path(field_path);
    }
    if error.message.contains("unknown variant") && field.is_empty() {
        let field_path = format!("{path}.kind");
        return error.at_path(field_path);
    }
    error
}

pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: PagePropertiesArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let (command, mut intent, mutation, resolve_selectors) = match args.command {
        PagePropertiesCommand::PrepareBatch(args) => {
            return crate::selection_batch::execute(client, &project.id, args);
        }
        PagePropertiesCommand::Apply {
            prepared, mutation, ..
        } => (
            "page properties apply",
            DatabaseIntent::ApplyPagePropertyEdits {
                edits: prepared
                    .ok_or_else(|| internal("Property edits input was not prepared"))?
                    .edits,
            },
            mutation,
            false,
        ),
        PagePropertiesCommand::Set(args) => {
            let PreparedSet {
                pages: page_selectors,
                values,
            } = args
                .prepared
                .clone()
                .ok_or_else(|| internal("Page Property values were not prepared"))?;
            if args.edits_work() {
                if page_selectors.len() != 1 || !values.is_empty() {
                    return Err(invalid(
                        "Set Owner, Assignee and Start automatically on one Page separately from Data Source Properties",
                    ));
                }
                return set_work(client, &project.id, &page_selectors[0], args);
            }
            let expected_value_revisions = match args.if_revision {
                Some(revision) if page_selectors.len() == 1 && values.len() == 1 => {
                    [(values[0].property_id.clone(), revision)].into()
                }
                Some(_) => {
                    return Err(invalid(
                        "--if-revision requires exactly one Page and one Property",
                    ));
                }
                None => Default::default(),
            };
            (
                "page properties set",
                DatabaseIntent::SetPageProperties {
                    updates: vec![DatabasePagePropertyUpdate {
                        page_ids: page_selectors,
                        values,
                        expected_value_revisions,
                    }],
                    authorization: None,
                },
                args.mutation,
                args.selection.is_none(),
            )
        }
    };
    crate::page_mutation::validate_return_fields(&mutation.r#return)?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(&project.id),
        command,
        mutation.idempotency_key.as_deref(),
        (&intent, resolve_selectors),
        Some(nodex_core_contracts::ModuleName::Database),
    )?;
    let committed = match admitted.replay {
        Some(replay) => serde_json::from_value(replay.result).map_err(internal)?,
        None => {
            if resolve_selectors
                && let DatabaseIntent::SetPageProperties { updates, .. } = &mut intent
            {
                for update in updates {
                    update.page_ids = update
                        .page_ids
                        .iter()
                        .map(|selector| resolve_page_selector(client, &project.id, selector))
                        .collect::<Result<_, _>>()?;
                }
            }
            apply_database_intent(client, &project.id, admitted.operation_id, intent)?
        }
    };
    let receipt = committed.receipt();
    serde_json::to_value(PropertyBatchReceipt {
        status: if receipt.mutation.duplicate {
            PropertyBatchStatus::Duplicate
        } else {
            PropertyBatchStatus::Committed
        },
        operation_id: receipt.mutation.operation_id.clone(),
        commit_seq: committed.commit_cursor(),
        pages: receipt.page_properties.clone(),
        commit: mutation
            .r#return
            .iter()
            .any(|field| field == "commit")
            .then(|| committed.outcome().clone()),
    })
    .map(CommandOutput::Json)
    .map_err(internal)
}

fn apply_database_intent(
    client: &CoreClient,
    project_id: &str,
    operation_id: String,
    intent: DatabaseIntent,
) -> Result<
    nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::database::DatabaseCommitValue,
        nodex_core_contracts::database::DatabaseReceipt,
    >,
    CliError,
> {
    let response = client
        .database_apply(
            Some(project_id),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![intent],
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => Ok(committed),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn selection_pages(path: &Path) -> Result<Vec<String>, CliError> {
    let document: serde_json::Value = crate::input_document::read(path, "Page selection")?;
    if document.is_array() {
        return serde_json::from_value(document).map_err(|error| {
            invalid(&format!(
                "Page selection must be a list of Page IDs or keys: {error}"
            ))
        });
    }
    let selection: crate::selection_batch::Selection =
        serde_json::from_value(document).map_err(|error| {
            invalid(&format!(
                "Expected a SQL result with Page identities: {error}"
            ))
        })?;
    let column = ["page_id", "page_key"]
        .into_iter()
        .find_map(|name| selection.columns.iter().position(|column| column == name))
        .ok_or_else(|| invalid("SQL selection requires a page_id or page_key column"))?;
    let mut seen = std::collections::HashSet::new();
    selection
        .rows
        .iter()
        .filter_map(
            |row| match row.get(column).and_then(serde_json::Value::as_str) {
                Some(page) if !page.trim().is_empty() => {
                    seen.insert(page).then(|| Ok(page.to_owned()))
                }
                _ => Some(Err(invalid(
                    "SQL selection Page identities must be nonempty strings",
                ))),
            },
        )
        .collect()
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

fn invalid(message: &str) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}
const OWNER_FORMS: &str = "Owner requires member:<id> or me";
const ASSIGNEE_FORMS: &str =
    "Assignee requires member:<id>, me, agent:<instance>/<model>[/<effort>] or none";

fn member_reference(value: &str, me: &str, forms: &str) -> Result<String, CliError> {
    if value == "me" {
        return Ok(me.to_owned());
    }
    value
        .strip_prefix("member:")
        .ok_or_else(|| invalid(forms))
        .and_then(stable_id)
}
fn assignee_reference(
    value: &str,
    me: &str,
) -> Result<Option<nodex_core_contracts::library::PageAssignee>, CliError> {
    use nodex_core_contracts::library::PageAssignee;
    if value == "none" {
        return Ok(None);
    }
    if let Some(agent) = value.strip_prefix("agent:") {
        let parts = agent.split('/').collect::<Vec<_>>();
        if !(2..=3).contains(&parts.len())
            || parts
                .iter()
                .any(|v| v.is_empty() || v.trim() != *v || v.chars().any(char::is_control))
        {
            return Err(invalid(ASSIGNEE_FORMS));
        }
        return Ok(Some(PageAssignee::Agent {
            instance_id: parts[0].to_owned(),
            model: parts[1].to_owned(),
            effort: parts.get(2).map(|v| (*v).to_owned()),
        }));
    }
    if !value.starts_with("member:") && value != "me" && value.contains('/') {
        // An Agent named without its prefix reads naturally; say exactly what to write.
        return Err(invalid(&format!("{ASSIGNEE_FORMS}; use agent:{value}")));
    }
    Ok(Some(PageAssignee::Member {
        member_id: member_reference(value, me, ASSIGNEE_FORMS)?,
    }))
}
/// Applies the Owner, Assignee and Start automatically flags to the observed Page work.
fn edit_work(
    mut work: nodex_core_contracts::library::PageWork,
    args: &PropertySetArgs,
    me: &str,
) -> Result<nodex_core_contracts::library::PageWork, CliError> {
    if let Some(owner) = &args.owner {
        work.owner = member_reference(owner, me, OWNER_FORMS)?;
    }
    if let Some(assignee) = &args.assignee {
        let assignee = assignee_reference(assignee, me)?;
        // Consent belongs to one assignment: changing the Assignee clears it in Core.
        if args.auto_start == Some(true) && work.assignee.is_some() && work.assignee != assignee {
            return Err(invalid(
                "Changing the Assignee clears Start automatically; set --auto-start in a separate command",
            ));
        }
        work.assignee = assignee;
    }
    if let Some(auto_start) = args.auto_start {
        work.auto_start = auto_start;
    }
    Ok(work)
}
fn set_work(
    client: &CoreClient,
    project: &str,
    page: &str,
    args: PropertySetArgs,
) -> Result<CommandOutput, CliError> {
    use nodex_core_contracts::library::*;
    crate::page_mutation::validate_return_fields(&args.mutation.r#return)?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(project),
        "page properties set",
        args.mutation.idempotency_key.as_deref(),
        (
            page,
            args.if_revision,
            &args.owner,
            &args.assignee,
            args.auto_start,
            "work",
        ),
        Some(nodex_core_contracts::ModuleName::Library),
    )?;
    if let Some(replay) = admitted.replay {
        return work_output(serde_json::from_value(replay.result).map_err(internal)?);
    }
    let page = resolve_page_selector(client, project, page)?;
    let LibraryReadValue::LocalMember { value: me } =
        unwrap_library(client.library_read(None, LibraryRead::LocalMember))?.value
    else {
        return Err(internal("unexpected local Member"));
    };
    let LibraryReadValue::PageDetail { value: detail } = unwrap_library(client.library_read(
        Some(project),
        LibraryRead::PageDetail {
            page_id: page.to_owned(),
        },
    ))?
    .value
    else {
        return Err(internal("unexpected Page detail"));
    };
    let property = detail
        .intrinsic_properties
        .iter()
        .find(|p| p.key == "work")
        .ok_or_else(|| internal("Page work is absent"))?;
    let work = edit_work(
        serde_json::from_value(property.value.clone()).map_err(internal)?,
        &args,
        &me.id,
    )?;
    let response = client
        .library_apply(
            Some(project),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                operation_id: admitted.operation_id,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: LibraryIntent::ApplyBlockPropertyMutation {
                    mutation: Box::new(LibraryBlockPropertyMutation {
                        actor: serde_json::json!({"kind":"person"}),
                        client_session_id: None,
                        fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                            block_id: page.to_owned(),
                            property_key: "work".to_owned(),
                            expected_revision: args.if_revision.unwrap_or(property.revision),
                            value: serde_json::to_value(work).map_err(internal)?,
                        }],
                    }),
                },
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => work_output(committed),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

fn work_output(
    committed: nodex_core_contracts::ApplyResponse<
        nodex_core_contracts::library::LibraryCommitValue,
        nodex_core_contracts::library::LibraryReceipt,
    >,
) -> Result<CommandOutput, CliError> {
    use nodex_core_contracts::library::*;
    if let Some(LibraryBlockPropertyMutationReceipt {
        outcome: LibraryBlockPropertyMutationOutcome::Rejected { error },
    }) = &committed.outcome().block_property_mutation
    {
        let code = if error.code == LibraryBlockPropertyMutationErrorCode::PropertyConflict {
            CliErrorCode::EtagConflict
        } else {
            CliErrorCode::InvalidInput
        };
        return Err(CliError::new(code, &error.message));
    }
    let duplicate = committed.receipt().mutation.duplicate;
    crate::runtime::compact_receipt(committed, duplicate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use nodex_core_contracts::library::{PageAssignee, PageWork};
    fn set_args(flags: &[&str]) -> PropertySetArgs {
        #[derive(Parser)]
        struct Command {
            #[command(flatten)]
            args: PropertySetArgs,
        }
        Command::try_parse_from(["set", "NODEX-1"].iter().chain(flags))
            .unwrap()
            .args
    }
    #[test]
    fn start_automatically_is_set_with_page_work_and_never_rides_a_reassignment() {
        let agent = |model: &str| PageAssignee::Agent {
            instance_id: "codex".into(),
            model: model.into(),
            effort: None,
        };
        let work = PageWork {
            owner: "person".into(),
            assignee: Some(agent("model")),
            auto_start: false,
        };
        let edited =
            edit_work(work.clone(), &set_args(&["--auto-start", "true"]), "person").unwrap();
        assert!(edited.auto_start);
        assert_eq!(edited.assignee, work.assignee);
        let edited = edit_work(
            PageWork {
                assignee: None,
                ..work.clone()
            },
            &set_args(&["--assignee", "agent:codex/model", "--auto-start", "true"]),
            "person",
        )
        .unwrap();
        assert!(edited.auto_start);
        assert!(
            edit_work(
                work,
                &set_args(&["--assignee", "agent:codex/other", "--auto-start", "true"]),
                "person",
            )
            .unwrap_err()
            .message
            .contains("separate command")
        );
    }
    #[test]
    fn assignment_references_are_typed_and_reject_incomplete_agents() {
        assert_eq!(
            assignee_reference("me", "person").unwrap(),
            Some(PageAssignee::Member {
                member_id: "person".into()
            })
        );
        assert_eq!(assignee_reference("none", "person").unwrap(), None);
        assert_eq!(
            assignee_reference("agent:codex/model/high", "person").unwrap(),
            Some(PageAssignee::Agent {
                instance_id: "codex".into(),
                model: "model".into(),
                effort: Some("high".into())
            })
        );
        for value in [
            "Alice",
            "agent:codex",
            "agent:codex//high",
            "agent:codex/model/high/extra",
        ] {
            let error = assignee_reference(value, "person").unwrap_err();
            assert!(
                error.message.starts_with(ASSIGNEE_FORMS),
                "{value}: {}",
                error.message
            );
        }
        // An Agent written without its prefix is pointed at the exact syntax.
        assert_eq!(
            assignee_reference("codex/gpt-6-luna", "person")
                .unwrap_err()
                .message,
            format!("{ASSIGNEE_FORMS}; use agent:codex/gpt-6-luna")
        );
        assert_eq!(
            member_reference("Alice", "person", OWNER_FORMS)
                .unwrap_err()
                .message,
            OWNER_FORMS
        );
    }
}

#[derive(serde::Serialize, utoipa::ToSchema)]
#[serde(untagged)]
#[allow(dead_code)]
pub(crate) enum PropertySetResult {
    Source(PropertyBatchReceipt),
    Page(
        Box<
            CompactReceipt<
                nodex_core_contracts::library::LibraryCommitValue,
                nodex_core_contracts::library::LibraryReceipt,
            >,
        >,
    ),
}
