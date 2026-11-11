use crate::cli::MutationArgs;
use crate::data_source::stable_id;
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, resolve_page_selector, selected_project,
    unwrap_library,
};
use clap::{Args, Subcommand};
use nodex_core_contracts::database::{
    DatabaseIntent, DatabasePagePropertyAddress, DatabasePropertyValueEdit,
    DatabasePropertyValueInput, DatabasePropertyValueMutation,
};
use nodex_core_contracts::library::{LibraryPageDataSourceContext, LibraryRead, LibraryReadValue};
use nodex_core_contracts::{
    ApplyResponse, DATABASE_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch,
};
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
    /// Replace one select, text, or number Property using its current revision.
    Set(PropertySetArgs),
}
#[derive(Clone, Debug, PartialEq, Args)]
#[command(group(clap::ArgGroup::new("value").required(true).multiple(true).args(["option", "text", "number", "assignee", "owner", "auto_start"])))]
pub struct PropertySetArgs {
    /// Page ID, Page key, or uniquely resolvable title path.
    pub page: String,
    /// Source ID; omitted uses the Page’s current membership.
    #[arg(long)]
    pub data_source: Option<String>,
    /// Stable Property ID within the Source (not its display name).
    #[arg(long)]
    pub property: Option<String>,
    /// member:<id>, me, agent:<instance>/<model>[/<effort>], or none.
    #[arg(long)]
    pub assignee: Option<String>,
    /// Member identity (member:<id>) or me.
    #[arg(long)]
    pub owner: Option<String>,
    /// Whether an Agent Assignee starts on its own once its prerequisites are Done.
    #[arg(long, value_name = "true|false")]
    pub auto_start: Option<bool>,
    /// Select option ID; choose exactly one of --option, --text or --number.
    #[arg(long)]
    pub option: Option<String>,
    /// Replacement text value, including an empty string.
    #[arg(long)]
    pub text: Option<String>,
    /// Replacement numeric value.
    #[arg(long, allow_hyphen_values = true)]
    pub number: Option<f64>,
    /// Observed value revision. Owner, Assignee and Start automatically default to the revision read by this command.
    #[arg(long, required_unless_present_any = ["assignee", "owner", "auto_start"])]
    pub if_revision: Option<i64>,
    #[command(flatten)]
    pub mutation: MutationArgs,
}
#[derive(Clone, Debug, PartialEq, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PropertyApplyInput {
    #[schema(min_items = 1, max_items = 4096)]
    pub edits: Vec<DatabasePropertyValueMutation>,
}

pub(crate) type PropertyApplyDocument = crate::input_document::InputDocument<PropertyApplyInput>;

pub(crate) fn prepare(args: &mut PagePropertiesArgs) -> Result<(), CliError> {
    if let PagePropertiesCommand::PrepareBatch(args) = &mut args.command {
        return crate::selection_batch::prepare(args);
    }
    if let PagePropertiesCommand::Apply {
        input, prepared, ..
    } = &mut args.command
    {
        *prepared = Some(read_property_edits(input)?);
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
    let command_name = match &args.command {
        PagePropertiesCommand::Apply { .. } => "page properties apply",
        _ => "page properties set",
    };
    let (edits, mutation) = match args.command {
        PagePropertiesCommand::PrepareBatch(args) => {
            return crate::selection_batch::execute(client, &project.id, args);
        }
        PagePropertiesCommand::Apply {
            input: _,
            prepared,
            mutation,
        } => (
            prepared
                .ok_or_else(|| internal("Property edits input was not prepared"))?
                .edits,
            mutation,
        ),
        PagePropertiesCommand::Set(args) => {
            if args.assignee.is_some() || args.owner.is_some() || args.auto_start.is_some() {
                return set_work(client, &project.id, args);
            }
            let page_id = resolve_page_selector(client, &project.id, &args.page)?;
            let property = args
                .property
                .as_deref()
                .ok_or_else(|| invalid("Specify --property for a Data Source value"))?;
            let data_source_id = match args.data_source {
                Some(id) => stable_id(&id)?,
                None => page_source(client, &project.id, &page_id)?
                    .map(|(id, _)| id)
                    .ok_or_else(|| {
                        CliError::new(
                            CliErrorCode::InvalidInput,
                            "Page has no Data Source Property schema",
                        )
                    })?,
            };
            let value = match (args.option, args.text, args.number) {
                (Some(option), None, None) => DatabasePropertyValueInput::Select {
                    option_id: stable_id(&option)?,
                },
                (None, Some(value), None) => DatabasePropertyValueInput::Text { value },
                (None, None, Some(value)) if value.is_finite() => {
                    DatabasePropertyValueInput::Number { value }
                }
                _ => {
                    return Err(CliError::new(
                        CliErrorCode::InvalidInput,
                        "Specify exactly one finite --number, --text, or --option value",
                    ));
                }
            };
            (
                vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id,
                        data_source_id,
                        property_id: stable_id(property)?,
                    },
                    edit: DatabasePropertyValueEdit::Replace {
                        expected_value_revision: args.if_revision.ok_or_else(|| {
                            invalid("Specify --if-revision for a Data Source value")
                        })?,
                        value,
                    },
                }],
                args.mutation,
            )
        }
    };
    crate::page_mutation::validate_return_fields(&mutation.r#return)?;
    let response = client
        .database_apply(
            Some(&project.id),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: crate::retry_key::admit(
                    client,
                    Some(&project.id),
                    command_name,
                    mutation.idempotency_key.as_deref(),
                    &edits,
                )?,
                store_epoch: StoreEpoch(client.handshake.store_epoch.clone()),
                intent: vec![DatabaseIntent::EditPropertyValues { edits }],
            },
        )
        .map_err(map_client_error)?;
    match response.0 {
        ResponseEnvelope::Ok(committed) => serde_json::to_value(committed)
            .map(CommandOutput::Json)
            .map_err(internal),
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}
fn page_source(
    client: &CoreClient,
    project_id: &str,
    page_id: &str,
) -> Result<Option<(String, Vec<String>)>, CliError> {
    let result = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageDetail {
            page_id: page_id.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageDetail { value } = result.value else {
        return Err(internal("unexpected Page detail"));
    };
    match value.data_source_context {
        LibraryPageDataSourceContext::Standalone => Ok(None),
        LibraryPageDataSourceContext::Member {
            membership,
            properties,
            ..
        } => Ok(Some((
            membership.data_source_id,
            properties
                .into_iter()
                .map(|property| property.property_id)
                .collect(),
        ))),
    }
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
    args: PropertySetArgs,
) -> Result<CommandOutput, CliError> {
    use nodex_core_contracts::library::*;
    if args.property.is_some()
        || args.option.is_some()
        || args.text.is_some()
        || args.number.is_some()
        || args.data_source.is_some()
    {
        return Err(invalid(
            "Set Owner, Assignee and Start automatically separately from Data Source Properties",
        ));
    }
    crate::page_mutation::validate_return_fields(&args.mutation.r#return)?;
    let admitted = crate::retry_key::admit_with_replay(
        client,
        Some(project),
        "page properties set",
        args.mutation.idempotency_key.as_deref(),
        (
            &args.page,
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
    let page = resolve_page_selector(client, project, &args.page)?;
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
    serde_json::to_value(committed)
        .map(CommandOutput::Json)
        .map_err(internal)
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
    Source(
        Box<
            ApplyResponse<
                nodex_core_contracts::database::DatabaseCommitValue,
                nodex_core_contracts::database::DatabaseReceipt,
            >,
        >,
    ),
    Page(
        Box<
            ApplyResponse<
                nodex_core_contracts::library::LibraryCommitValue,
                nodex_core_contracts::library::LibraryReceipt,
            >,
        >,
    ),
}
