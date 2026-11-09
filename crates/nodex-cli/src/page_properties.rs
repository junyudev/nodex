use crate::cli::MutationArgs;
use crate::data_source::stable_id;
use crate::error::{CliError, CliErrorCode};
use crate::input::read_json;
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, operation_id, resolve_page_selector,
    selected_project, unwrap_library,
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
#[command(group(clap::ArgGroup::new("value").required(true).multiple(true).args(["option", "text", "number", "assignee", "owner"])))]
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
    /// Select option ID; choose exactly one of --option, --text or --number.
    #[arg(long)]
    pub option: Option<String>,
    /// Replacement text value, including an empty string.
    #[arg(long)]
    pub text: Option<String>,
    /// Replacement numeric value.
    #[arg(long, allow_hyphen_values = true)]
    pub number: Option<f64>,
    /// Observed value revision. Owner/Assignee default to the revision read by this command.
    #[arg(long, required_unless_present_any = ["assignee", "owner"])]
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
        *prepared = Some(read_json::<PropertyApplyDocument>(input, "Property edits")?.into_inner());
    }
    Ok(())
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    args: PagePropertiesArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
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
            let page_id = resolve_page_selector(client, &project.id, &args.page)?;
            if args.assignee.is_some() || args.owner.is_some() {
                return set_work(client, &project.id, &page_id, args);
            }
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
                operation_id: operation_id(mutation.idempotency_key.as_deref())?,
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
fn set_work(
    client: &CoreClient,
    project: &str,
    page: &str,
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
            "Set Owner and Assignee separately from Data Source Properties",
        ));
    }
    crate::page_mutation::validate_return_fields(&args.mutation.r#return)?;
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
    let mut work: PageWork = serde_json::from_value(property.value.clone()).map_err(internal)?;
    if let Some(owner) = args.owner {
        work.owner = member_reference(&owner, &me.id, OWNER_FORMS)?;
    }
    if let Some(assignee) = args.assignee {
        work.assignee = assignee_reference(&assignee, &me.id)?;
    }
    let response = client
        .library_apply(
            Some(project),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                operation_id: operation_id(args.mutation.idempotency_key.as_deref())?,
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
        ResponseEnvelope::Ok(committed) => {
            if let Some(LibraryBlockPropertyMutationReceipt {
                outcome: LibraryBlockPropertyMutationOutcome::Rejected { error },
            }) = &committed.outcome().block_property_mutation
            {
                let code = if error.code == LibraryBlockPropertyMutationErrorCode::PropertyConflict
                {
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
        ResponseEnvelope::Error(error) => Err(map_core_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::library::PageAssignee;
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
