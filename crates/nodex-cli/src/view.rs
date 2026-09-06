use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use nodex_core_contracts::collection::{CollectionWindowRequest, MAX_COLLECTION_WINDOW_ITEMS};
use nodex_core_contracts::database::{
    DatabaseGroupScope, DatabasePropertyDescriptor, DatabasePropertySchema, DatabaseRead,
    DatabaseReadValue, DatabaseViewContext, DatabaseViewContextRow, DatabaseViewDefinition,
};
use nodex_core_contracts::workspace::ProjectWorkspaceProject;
use nodex_core_protocol::client::CoreClient;
use serde::Serialize;
use serde_json::Value;

use crate::cli::ViewQueryArgs;
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, selected_project, unwrap_database};

const VIEW_QUERY_SCHEMA_VERSION: u32 = 1;
const MAX_VIEW_SELECTOR_CANDIDATES: usize = 10_000;

pub(crate) fn query(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    arguments: ViewQueryArgs,
    json_output: bool,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let view_id = resolve_view_selector(client, &project, &arguments.view)?;
    let group_scope = match (arguments.group, arguments.unassigned) {
        (Some(key), false) => Some(DatabaseGroupScope::Path {
            group_key: Some(validate_group_key(key)?),
            subgroup_key: None,
        }),
        (None, true) => Some(DatabaseGroupScope::Path {
            group_key: None,
            subgroup_key: None,
        }),
        (None, false) => None,
        (Some(_), true) => {
            return Err(CliError::new(
                CliErrorCode::InvalidInput,
                "--group and --unassigned are mutually exclusive",
            ));
        }
    };
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::ViewContext {
            view_id,
            window: CollectionWindowRequest {
                after: arguments.after,
                first: arguments.limit,
            },
            group_scope,
        },
    ))?;
    let DatabaseReadValue::ViewContext { value } = snapshot.value else {
        return Err(internal("Core returned the wrong saved View context"));
    };
    let labels = read_group_labels(client, &project.id, &value)?;
    let output = project_context(*value, labels)?;
    if json_output {
        return serde_json::to_value(output)
            .map(CommandOutput::Json)
            .map_err(internal);
    }
    Ok(CommandOutput::Text(render_human(&output)))
}

pub(crate) fn resolve_view_selector(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
) -> Result<String, CliError> {
    if let Some(view_id) = selector.strip_prefix('@') {
        return validate_stable_id(view_id, "View selector");
    }
    if selector.is_empty() || selector.len() > 4_096 || selector.trim() != selector {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "a View name selector must be a non-empty bounded exact name",
        ));
    }

    let mut database_cursor = None;
    let mut database_ids = Vec::new();
    loop {
        let snapshot = unwrap_database(client.database_read(
            Some(&project.id),
            DatabaseRead::CatalogWindow {
                window: CollectionWindowRequest {
                    after: database_cursor,
                    first: Some(MAX_COLLECTION_WINDOW_ITEMS),
                },
            },
        ))?;
        let DatabaseReadValue::CatalogWindow { databases } = snapshot.value else {
            return Err(internal(
                "Core returned the wrong Database catalog for View resolution",
            ));
        };
        for database in databases.items {
            database_ids.push(database.database.database_id);
            enforce_candidate_budget(database_ids.len())?;
        }
        let Some(next_cursor) = databases.next_cursor else {
            break;
        };
        database_cursor = Some(next_cursor);
    }

    let mut matches = Vec::new();
    for database_id in database_ids {
        let mut view_cursor = None;
        loop {
            let snapshot = unwrap_database(client.database_read(
                Some(&project.id),
                DatabaseRead::ViewDescriptorWindow {
                    database_id: database_id.clone(),
                    window: CollectionWindowRequest {
                        after: view_cursor,
                        first: Some(MAX_COLLECTION_WINDOW_ITEMS),
                    },
                },
            ))?;
            let DatabaseReadValue::ViewDescriptorWindow { views } = snapshot.value else {
                return Err(internal("Core returned the wrong View descriptor window"));
            };
            for view in views.items {
                if view.name != selector {
                    continue;
                }
                matches.push(view.view_id);
                enforce_candidate_budget(matches.len())?;
            }
            let Some(next_cursor) = views.next_cursor else {
                break;
            };
            view_cursor = Some(next_cursor);
        }
    }
    resolve_unique_name(selector, matches)
}

fn resolve_unique_name(selector: &str, mut matches: Vec<String>) -> Result<String, CliError> {
    matches.sort();
    matches.dedup();
    match matches.as_slice() {
        [] => Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            format!("no authorized View matches '{selector}'"),
        )),
        [view_id] => Ok(view_id.clone()),
        _ => Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            format!(
                "View name '{selector}' matches multiple Views: {}",
                matches.join(", ")
            ),
        )),
    }
}

fn enforce_candidate_budget(count: usize) -> Result<(), CliError> {
    if count <= MAX_VIEW_SELECTOR_CANDIDATES {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::ScopeBudgetExceeded,
        format!("View resolution exceeds the {MAX_VIEW_SELECTOR_CANDIDATES}-candidate limit"),
    ))
}

fn validate_stable_id(value: &str, label: &str) -> Result<String, CliError> {
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            format!("{label} must contain one bounded stable identity"),
        ));
    }
    Ok(value.to_owned())
}

fn validate_group_key(value: String) -> Result<String, CliError> {
    validate_stable_id(&value, "View group key")
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewQueryOutput {
    schema_version: u32,
    database: NamedIdentity,
    data_source: NamedIdentity,
    view: ViewIdentity,
    properties: Vec<DatabasePropertyDescriptor>,
    grouped: bool,
    total_rows: i64,
    groups_truncated: bool,
    groups: Vec<ViewGroupOutput>,
    rows: Vec<ViewRowOutput>,
    page_info: ViewPageInfo,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
struct NamedIdentity {
    id: String,
    name: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ViewIdentity {
    id: String,
    name: String,
    database_id: String,
    data_source_id: String,
    grouping_property_id: Option<String>,
    config: DatabaseViewDefinition,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ViewGroupOutput {
    key: Option<String>,
    label: String,
    total_rows: i64,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ViewRowOutput {
    page_id: String,
    page_key: Option<String>,
    title: String,
    description_preview: String,
    values: BTreeMap<String, Value>,
    intrinsic_properties: BTreeMap<String, Value>,
    effective_group_key: Option<String>,
    position: ViewRowPosition,
    etags: ViewRowEtags,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ViewRowPosition {
    rank_key: Option<String>,
    revision: Option<i64>,
    order: Option<i64>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
struct ViewRowEtags {
    r#move: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ViewPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
    projection_revision: i64,
}

fn read_group_labels(
    client: &CoreClient,
    project_id: &str,
    context: &DatabaseViewContext,
) -> Result<BTreeMap<String, String>, CliError> {
    let Some(property_id) = context
        .view
        .definition
        .presentation
        .group
        .as_ref()
        .map(|group| group.property_id.as_str())
    else {
        return Ok(BTreeMap::new());
    };
    let Some(property) = context
        .properties
        .iter()
        .find(|property| property.property_id == property_id)
    else {
        return Err(internal("Core View grouping Property is missing"));
    };
    if !matches!(
        property.schema,
        DatabasePropertySchema::Select | DatabasePropertySchema::MultiSelect
    ) {
        return Ok(BTreeMap::new());
    }
    let mut labels = BTreeMap::new();
    let mut after = None;
    loop {
        let snapshot = unwrap_database(client.database_read(
            Some(project_id),
            DatabaseRead::OptionWindow {
                data_source_id: property.data_source_id.clone(),
                property_id: property.property_id.clone(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(MAX_COLLECTION_WINDOW_ITEMS),
                },
            },
        ))?;
        let DatabaseReadValue::OptionWindow { options } = snapshot.value else {
            return Err(internal("Core returned the wrong Property option window"));
        };
        for option in options.items {
            labels.insert(option.id, option.name);
        }
        let Some(cursor) = options.next_cursor else {
            return Ok(labels);
        };
        after = Some(cursor);
    }
}

fn project_context(
    context: DatabaseViewContext,
    labels: BTreeMap<String, String>,
) -> Result<ViewQueryOutput, CliError> {
    let database = NamedIdentity {
        id: context.database.database_id,
        name: context.database.name,
    };
    let data_source = NamedIdentity {
        id: context.data_source.data_source_id,
        name: context.data_source.name,
    };
    let grouping_property_id = context
        .view
        .definition
        .presentation
        .group
        .as_ref()
        .map(|group| group.property_id.clone());
    let groups = context
        .groups
        .groups
        .into_iter()
        .map(|group| ViewGroupOutput {
            label: group
                .group_key
                .as_deref()
                .and_then(|key| labels.get(key))
                .cloned()
                .unwrap_or_else(|| {
                    group
                        .group_key
                        .clone()
                        .unwrap_or_else(|| "Unassigned".to_owned())
                }),
            key: group.group_key,
            total_rows: group.total_rows,
        })
        .collect();
    let view = ViewIdentity {
        id: context.view.view_id,
        name: context.view.name,
        database_id: context.view.database_id,
        data_source_id: context.view.data_source_id,
        grouping_property_id,
        config: context.view.definition,
    };
    let rows = context.rows.items.into_iter().map(project_row).collect();
    let end_cursor = context.rows.next_cursor;
    Ok(ViewQueryOutput {
        schema_version: VIEW_QUERY_SCHEMA_VERSION,
        database,
        data_source,
        view,
        properties: context.properties,
        grouped: context.groups.grouped,
        total_rows: context.groups.total_rows,
        groups_truncated: context.groups.truncated,
        groups,
        rows,
        page_info: ViewPageInfo {
            has_next_page: end_cursor.is_some(),
            end_cursor,
            projection_revision: context.rows.authority.projection_revision,
        },
    })
}

fn project_row(row: DatabaseViewContextRow) -> ViewRowOutput {
    ViewRowOutput {
        page_id: row.summary.page_id,
        page_key: row.summary.page_key,
        title: row.summary.title,
        description_preview: row.summary.description_preview,
        values: row.summary.database_values,
        intrinsic_properties: row.summary.intrinsic_properties,
        effective_group_key: row.summary.effective_group_key,
        position: ViewRowPosition {
            rank_key: row.summary.rank_key,
            revision: row.summary.position_revision,
            order: row.summary.position_order,
        },
        etags: ViewRowEtags {
            r#move: row.move_etag,
        },
    }
}

fn render_human(output: &ViewQueryOutput) -> String {
    let mut rendered = format!(
        "{} (@{}) · {} row{}\n",
        output.view.name,
        output.view.id,
        output.total_rows,
        if output.total_rows == 1 { "" } else { "s" }
    );
    for row in &output.rows {
        let group = row.effective_group_key.as_deref().unwrap_or("unassigned");
        let key = row.page_key.as_deref().unwrap_or("-");
        let _ = writeln!(rendered, "{group}\t{key}\t{}\t@{}", row.title, row.page_id);
    }
    if let Some(cursor) = &output.page_info.end_cursor {
        let _ = writeln!(rendered, "next\t{cursor}");
    }
    rendered
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::collection::{CollectionWindow, CollectionWindowAuthority};
    use nodex_core_contracts::database::{
        DatabasePropertyCapabilities, DatabasePropertyManagementPolicy, DatabasePropertySystemRole,
        DatabaseRowSummary, DatabaseViewFilterOperator, DatabaseViewGroupSummary,
        DatabaseViewGroups,
    };
    use nodex_core_contracts::{
        LocalProjectionScope, ProjectionScopeKey, ProjectionSnapshotAuthority,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn unique_view_names_return_stable_candidates() {
        assert_eq!(
            resolve_unique_name("Planning", vec!["view-1".to_owned()]).expect("unique View"),
            "view-1"
        );
        let ambiguous =
            resolve_unique_name("Planning", vec!["view-b".to_owned(), "view-a".to_owned()])
                .expect_err("ambiguous View");
        assert_eq!(ambiguous.code, CliErrorCode::ScopeAmbiguous);
        assert!(ambiguous.message.ends_with("view-a, view-b"));
    }

    #[test]
    fn context_projection_uses_option_labels_and_preserves_stable_group_keys() {
        let context = DatabaseViewContext {
            database: serde_json::from_value(json!({
                "database_id": "database-1",
                "library_id": "library-1",
                "name": "Work",
                "lifecycle": "active",
                "default_view_id": "view-1",
                "access_revision": 1,
                "metadata_revision": 1,
                "created_at": "2026-08-04T00:00:00.000Z",
                "updated_at": "2026-08-04T00:00:00.000Z"
            }))
            .expect("Database record"),
            data_source: serde_json::from_value(json!({
                "data_source_id": "source-1",
                "library_id": "library-1",
                "home_database_id": "database-1",
                "name": "Tasks",
                "schema_key": "nodex.database",
                "schema_revision": 1,
                "lifecycle": "active",
                "rank_key": "a",
                "created_at": "2026-08-04T00:00:00.000Z",
                "updated_at": "2026-08-04T00:00:00.000Z"
            }))
            .expect("Data Source record"),
            view: serde_json::from_value(json!({
                "view_id": "view-1",
                "name": "Planning",
                "layout": "board",
                "database_id": "database-1",
                "data_source_id": "source-1",
                "definition": {
                    "rules": {
                        "propertyFilters": [],
                        "advancedFilter": null,
                        "sorts": []
                    },
                    "presentation": {
                        "group": { "propertyId": "status" },
                        "subgroup": null,
                        "groupDirection": "asc",
                        "completion": { "range": "all", "orderByRecency": false },
                        "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                        "display": {
                            "fields": [],
                            "showEmptyGroups": false,
                            "showDescription": true
                        },
                        "conditionalColors": []
                    }
                },
                "is_default": true,
                "revision": 1,
                "rank_key": "a",
                "lifecycle": "active",
                "created_at": "2026-08-04T00:00:00.000Z",
                "updated_at": "2026-08-04T00:00:00.000Z"
            }))
            .expect("View record"),
            properties: vec![DatabasePropertyDescriptor {
                property_id: "status".to_owned(),
                data_source_id: "source-1".to_owned(),
                name: "Status".to_owned(),
                schema: DatabasePropertySchema::Select,
                capabilities: DatabasePropertyCapabilities {
                    filter_operators: vec![
                        DatabaseViewFilterOperator::Equals,
                        DatabaseViewFilterOperator::NotEquals,
                        DatabaseViewFilterOperator::IsEmpty,
                        DatabaseViewFilterOperator::IsNotEmpty,
                    ],
                    sortable: true,
                    groupable: true,
                },
                system_role: Some(DatabasePropertySystemRole::Status),
                non_empty_value_count: 0,
                referenced_view_ids: Vec::new(),
                management_policy: DatabasePropertyManagementPolicy {
                    can_rename: true,
                    can_reorder: true,
                    can_change_type: false,
                    can_duplicate: true,
                    can_delete: false,
                    can_restore: false,
                    can_permanently_delete: false,
                    can_manage_options: true,
                    allowed_types: Vec::new(),
                    blocked_reasons: vec![
                        "This Property has a required Nodex system role".to_owned(),
                    ],
                },
                option_count: 1,
                rank_key: "a".to_owned(),
                lifecycle: "active".to_owned(),
                revision: 1,
                created_at: "2026-08-04T00:00:00.000Z".to_owned(),
                updated_at: "2026-08-04T00:00:00.000Z".to_owned(),
            }],
            groups: DatabaseViewGroups {
                database_id: "database-1".to_owned(),
                data_source_id: "source-1".to_owned(),
                view_id: "view-1".to_owned(),
                projection: projection_authority(),
                grouped: true,
                subgrouped: false,
                total_rows: 1,
                total_groups: 1,
                group_limit: 200,
                truncated: false,
                groups: vec![DatabaseViewGroupSummary {
                    group_key: Some("triage".to_owned()),
                    subgroup_key: None,
                    total_rows: 1,
                }],
            },
            projection: projection_authority(),
            rows: CollectionWindow {
                items: vec![DatabaseViewContextRow {
                    summary: row_summary(),
                    move_etag: "nxe1.move".to_owned(),
                }],
                next_cursor: Some("nxc1.next".to_owned()),
                authority: CollectionWindowAuthority {
                    projection_revision: 42,
                },
            },
        };

        let output = project_context(
            context,
            BTreeMap::from([("triage".to_owned(), "Triage".to_owned())]),
        )
        .expect("project View context");
        assert_eq!(output.groups[0].key.as_deref(), Some("triage"));
        assert_eq!(output.groups[0].label, "Triage");
        assert_eq!(output.rows[0].etags.r#move, "nxe1.move");
        assert!(output.page_info.has_next_page);
        assert_eq!(output.page_info.projection_revision, 42);
        let human = render_human(&output);
        assert!(human.contains("triage\tLAB-13\tShip\t@page-1"));
    }

    fn projection_authority() -> ProjectionSnapshotAuthority {
        ProjectionSnapshotAuthority {
            scope: ProjectionScopeKey {
                schema_version: 1,
                canonical_key: "scope:view-1".to_owned(),
                scope: LocalProjectionScope::DatabaseView {
                    project_id: "project-1".to_owned(),
                    database_id: "database-1".to_owned(),
                    data_source_id: "source-1".to_owned(),
                    view_id: "view-1".to_owned(),
                },
            },
            revision: 42,
            covered_commit_seq: 42,
            effect_hash: Some("f".repeat(64)),
        }
    }

    fn row_summary() -> DatabaseRowSummary {
        DatabaseRowSummary {
            page_id: "page-1".to_owned(),
            page_key: Some("LAB-13".to_owned()),
            lifecycle: "active".to_owned(),
            title: "Ship".to_owned(),
            rich_title: json!([]),
            description_preview: String::new(),
            description_length: 0,
            has_description: false,
            database_values: BTreeMap::from([("status".to_owned(), json!("triage"))]),
            intrinsic_properties: BTreeMap::new(),
            database_value_revisions: BTreeMap::from([("status".to_owned(), 1)]),
            metadata_revision: 1,
            parent_revision: 1,
            document_id: "document-1".to_owned(),
            document_generation: 1,
            document_head_seq: 1,
            membership_id: "membership-1".to_owned(),
            membership_revision: 1,
            membership_created_at: "2026-07-31T00:00:00Z".to_owned(),
            created_at: "2026-07-31T00:00:00Z".to_owned(),
            updated_at: "2026-07-31T00:00:00Z".to_owned(),
            effective_group_key: Some("triage".to_owned()),
            effective_subgroup_key: None,
            rank_key: Some("a".to_owned()),
            position_revision: Some(1),
            position_order: Some(0),
            task_parent_page_id: None,
            task_sibling_rank: None,
            task_parent_value_revision: 1,
        }
    }
}
