use nodex_core_contracts::database::{
    DatabaseIdentityTarget, DatabaseRead, DatabaseReadValue, DatabaseRelationTargetItem,
    DatabaseRowsTarget, DatabaseViewReadTarget,
};
use nodex_core_contracts::events::{AuthorizedReadStamp, ResourceKey};
use nodex_core_contracts::{BoundModuleContext, StoreEpoch};
use rusqlite::Connection;

use crate::infrastructure::resource_authorization;
use crate::infrastructure::sqlite::StoreError;

pub(super) fn issue(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    commit_head: i64,
    read: &DatabaseRead,
    value: &DatabaseReadValue,
) -> Result<Option<AuthorizedReadStamp>, StoreError> {
    if matches!(
        value,
        DatabaseReadValue::RowDetail { value } if value.summary.lifecycle != "active"
    ) {
        return Ok(None);
    }
    let inactive_identity = match value {
        DatabaseReadValue::Database { value } => value.database.lifecycle != "active",
        DatabaseReadValue::DataSource { value } => value.data_source.lifecycle != "active",
        DatabaseReadValue::View { value } => value.lifecycle != "active",
        _ => false,
    };
    if inactive_identity {
        return Ok(None);
    }
    let Some(subject) = read_subject(context, read) else {
        return Ok(None);
    };
    let mut authorization_dependencies = vec![subject.clone()];
    append_value_dependencies(value, &mut authorization_dependencies);
    resource_authorization::issue_read_stamp(
        connection,
        context,
        StoreEpoch(store_epoch.to_owned()),
        commit_head,
        subject.clone(),
        vec![subject],
        authorization_dependencies,
    )
    .map(Some)
}

fn read_subject(context: &BoundModuleContext, read: &DatabaseRead) -> Option<ResourceKey> {
    match read {
        DatabaseRead::CatalogWindow { .. } => Some(context_subject(context)),
        DatabaseRead::Database { target } => Some(match target {
            DatabaseIdentityTarget::ProjectDefault => context_subject(context),
            DatabaseIdentityTarget::Database { database_id } => ResourceKey::Database {
                database_id: database_id.clone(),
            },
        }),
        DatabaseRead::PageKeyPrefixPreview { database_id, .. } => {
            Some(database_id.as_ref().map_or_else(
                || context_subject(context),
                |database_id| ResourceKey::Database {
                    database_id: database_id.clone(),
                },
            ))
        }
        DatabaseRead::PageKeyNamespace { database_id } => Some(ResourceKey::Database {
            database_id: database_id.clone(),
        }),
        DatabaseRead::DataSourceWindow { database_id, .. }
        | DatabaseRead::ViewDescriptorWindow { database_id, .. } => Some(ResourceKey::Database {
            database_id: database_id.clone(),
        }),
        DatabaseRead::DataSource { data_source_id }
        | DatabaseRead::PropertyWindow { data_source_id, .. }
        | DatabaseRead::OptionWindow { data_source_id, .. }
        | DatabaseRead::PageLayout { data_source_id }
        | DatabaseRead::RelationCandidateWindow { data_source_id, .. } => {
            Some(ResourceKey::DataSource {
                data_source_id: data_source_id.clone(),
            })
        }
        DatabaseRead::View { view_id }
        | DatabaseRead::ViewPersonalPreferences { view_id }
        | DatabaseRead::ViewCollapsedOccurrences { view_id }
        | DatabaseRead::ViewContext { view_id, .. } => Some(ResourceKey::View {
            view_id: view_id.clone(),
        }),
        DatabaseRead::ViewWindow { target, .. }
        | DatabaseRead::ListWindow { target, .. }
        | DatabaseRead::ViewGroups { target } => Some(view_target_subject(context, target)),
        DatabaseRead::RowsById { target, .. } => Some(match target {
            DatabaseRowsTarget::ProjectDefault => context_subject(context),
            DatabaseRowsTarget::View { view_id } => ResourceKey::View {
                view_id: view_id.clone(),
            },
        }),
        DatabaseRead::RowDetail { page_id }
        | DatabaseRead::RelationTargetWindow {
            address: nodex_core_contracts::database::DatabasePagePropertyAddress { page_id, .. },
            ..
        } => Some(ResourceKey::Page {
            page_id: page_id.clone(),
        }),
        DatabaseRead::AgentDataSourceQuery { .. } | DatabaseRead::AgentViewQuery { .. } => None,
    }
}

fn context_subject(context: &BoundModuleContext) -> ResourceKey {
    match &context.project_id {
        Some(project_id) => ResourceKey::Project {
            project_id: project_id.0.clone(),
        },
        None => ResourceKey::Library {
            library_id: context.library_id.0.clone(),
        },
    }
}

fn view_target_subject(
    context: &BoundModuleContext,
    target: &DatabaseViewReadTarget,
) -> ResourceKey {
    match target {
        DatabaseViewReadTarget::ProjectDefault => context_subject(context),
        DatabaseViewReadTarget::Database { database_id } => ResourceKey::Database {
            database_id: database_id.clone(),
        },
        DatabaseViewReadTarget::View { view_id }
        | DatabaseViewReadTarget::PresentedView { view_id, .. } => ResourceKey::View {
            view_id: view_id.clone(),
        },
    }
}

fn append_value_dependencies(value: &DatabaseReadValue, output: &mut Vec<ResourceKey>) {
    match value {
        DatabaseReadValue::ViewWindow { value } | DatabaseReadValue::AgentViewQuery { value } => {
            append_view_coordinates(
                &value.database_id,
                &value.data_source_id,
                &value.view_id,
                output,
            );
            append_rows(
                value
                    .rows
                    .items
                    .iter()
                    .filter(|row| row.lifecycle == "active")
                    .map(|row| row.page_id.as_str()),
                output,
            );
        }
        DatabaseReadValue::AgentDataSourceQuery { value } => {
            output.push(ResourceKey::Database {
                database_id: value.database_id.clone(),
            });
            output.push(ResourceKey::DataSource {
                data_source_id: value.data_source_id.clone(),
            });
            append_rows(
                value
                    .rows
                    .items
                    .iter()
                    .filter(|row| row.lifecycle == "active")
                    .map(|row| row.page_id.as_str()),
                output,
            );
        }
        DatabaseReadValue::ListWindow { value } => {
            append_view_coordinates(
                &value.database_id,
                &value.data_source_id,
                &value.view_id,
                output,
            );
            append_rows(
                value.rows.items.iter().filter_map(|row| match row {
                    nodex_core_contracts::database::DatabaseListProjectionRow::Page {
                        summary,
                        ..
                    } if summary.lifecycle == "active" => Some(summary.page_id.as_str()),
                    _ => None,
                }),
                output,
            );
        }
        DatabaseReadValue::ViewGroups { value } => append_view_coordinates(
            &value.database_id,
            &value.data_source_id,
            &value.view_id,
            output,
        ),
        DatabaseReadValue::ViewContext { value } => {
            append_view_coordinates(
                &value.groups.database_id,
                &value.groups.data_source_id,
                &value.groups.view_id,
                output,
            );
            append_rows(
                value
                    .rows
                    .items
                    .iter()
                    .filter(|row| row.summary.lifecycle == "active")
                    .map(|row| row.summary.page_id.as_str()),
                output,
            );
        }
        DatabaseReadValue::RowsById { value } => {
            append_rows(
                value
                    .rows
                    .iter()
                    .filter(|row| row.lifecycle == "active")
                    .map(|row| row.page_id.as_str()),
                output,
            );
        }
        DatabaseReadValue::RowDetail { value } => output.push(ResourceKey::Page {
            page_id: value.summary.page_id.clone(),
        }),
        DatabaseReadValue::RelationCandidateWindow { candidates } => {
            append_rows(
                candidates.items.iter().map(|row| row.page_id.as_str()),
                output,
            );
        }
        DatabaseReadValue::RelationTargetWindow { value } => {
            append_rows(
                value
                    .targets
                    .items
                    .iter()
                    .filter_map(|target| match target {
                        DatabaseRelationTargetItem::Visible { page_id, .. } => {
                            Some(page_id.as_str())
                        }
                        DatabaseRelationTargetItem::Restricted { .. } => None,
                    }),
                output,
            );
        }
        _ => {}
    }
}

fn append_view_coordinates(
    database_id: &str,
    data_source_id: &str,
    view_id: &str,
    output: &mut Vec<ResourceKey>,
) {
    output.push(ResourceKey::Database {
        database_id: database_id.to_owned(),
    });
    output.push(ResourceKey::DataSource {
        data_source_id: data_source_id.to_owned(),
    });
    output.push(ResourceKey::View {
        view_id: view_id.to_owned(),
    });
}

fn append_rows<'a>(rows: impl IntoIterator<Item = &'a str>, output: &mut Vec<ResourceKey>) {
    output.extend(rows.into_iter().map(|page_id| ResourceKey::Page {
        page_id: page_id.to_owned(),
    }));
}
