use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::agent::{AgentAuthorizationTarget, AgentProjectResourceAction};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::database::{
    DatabaseContainerRecord, DatabaseDataSourceDescriptor, DatabaseDataSourceRecord,
    DatabaseDescriptor, DatabaseIdentityTarget, DatabasePageKeyNamespace,
    DatabasePageKeyPrefixAvailability, DatabasePageKeyPrefixPreview, DatabasePageLayout,
    DatabasePageLayoutEntry, DatabasePagePropertyVisibility, DatabasePropertyDescriptor,
    DatabasePropertyManagementPolicy, DatabasePropertyOption, DatabasePropertySchema,
    DatabasePropertySystemRole, DatabasePropertyType, DatabaseRead, DatabaseReadValue,
    DatabaseRetiredPageKeyPrefix, DatabaseRowsTarget, DatabaseViewCollapsedOccurrences,
    DatabaseViewContext, DatabaseViewDisclosureTarget, DatabaseViewLayout,
    DatabaseViewPersonalPreferences, DatabaseViewPreferencesOverrideInput, DatabaseViewReadTarget,
    DatabaseViewRecord,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate},
};

use super::authorization::{authorize_database, authorize_required, project_primary_database};
use super::is_trusted_library_database_context;

pub(crate) struct PageDataSourceProjection {
    pub page_key: Option<String>,
    pub membership_id: String,
    pub data_source_id: String,
    pub membership_revision: i64,
    pub membership_created_at: String,
    pub database: Value,
    pub data_source: Value,
    pub properties: Vec<DatabasePropertyDescriptor>,
    pub property_configs: BTreeMap<String, Value>,
    pub values: BTreeMap<String, Value>,
}

struct PropertyDescriptorRow {
    property_id: String,
    data_source_id: String,
    name: String,
    value_type: String,
    config_json: String,
    rank_key: String,
    lifecycle: String,
    revision: i64,
    created_at: String,
    updated_at: String,
}

fn property_descriptor(
    connection: &Connection,
    row: PropertyDescriptorRow,
) -> Result<DatabasePropertyDescriptor, StoreError> {
    if !super::property_semantics::is_canonical_property_id(&row.property_id) {
        return Err(corrupt("Stored Property ID is not canonical"));
    }
    let schema = super::property_semantics::schema_from_storage(
        connection,
        &row.data_source_id,
        &row.property_id,
        &row.value_type,
    )?;
    if !super::property_semantics::schema_matches_canonical_property(
        &row.property_id,
        &row.data_source_id,
        &schema,
    ) {
        return Err(corrupt("Stored reserved Property schema is not canonical"));
    }
    let option_count = if matches!(row.value_type.as_str(), "select" | "multi_select") {
        super::property_semantics::option_config_from_storage(
            &row.property_id,
            &row.value_type,
            &row.config_json,
        )?
        .options
        .len()
    } else if matches!(
        schema,
        DatabasePropertySchema::Number { .. }
            | DatabasePropertySchema::Date { .. }
            | DatabasePropertySchema::Datetime { .. }
    ) {
        0
    } else {
        let config = serde_json::from_str::<Value>(&row.config_json)
            .map_err(|_| corrupt("Stored Property config is invalid"))?;
        if config.as_object().is_none_or(|config| !config.is_empty()) {
            return Err(corrupt(
                "Stored Property config is not the canonical empty object",
            ));
        }
        0
    };
    let non_empty_value_count = non_empty_property_value_count(
        connection,
        &row.data_source_id,
        &row.property_id,
        &row.value_type,
    )?;
    let referenced_view_ids =
        property_referenced_view_ids(connection, &row.data_source_id, &row.property_id)?;
    let system_role = match row.property_id.as_str() {
        super::property_semantics::STATUS_PROPERTY_ID => Some(DatabasePropertySystemRole::Status),
        super::property_semantics::TASK_PARENT_PROPERTY_ID => {
            Some(DatabasePropertySystemRole::TaskParent)
        }
        _ => None,
    };
    let active = row.lifecycle == "active";
    let custom = super::property_semantics::is_custom_property_id(&row.property_id);
    let removable = system_role.is_none();
    let option_backed = matches!(row.value_type.as_str(), "select" | "multi_select");
    let mut blocked_reasons = Vec::new();
    if !active {
        blocked_reasons.push("Deleted Properties must be restored before editing".to_owned());
    }
    if system_role.is_some() {
        blocked_reasons.push("This Property has a required Nodex system role".to_owned());
    }
    if active && non_empty_value_count > 0 {
        blocked_reasons.push("Clear all Property values before changing its type".to_owned());
    }
    let management_policy = DatabasePropertyManagementPolicy {
        can_rename: active,
        can_reorder: active,
        // The same schema intent owns presentation-only Number/Date formats,
        // which remain editable with values. Core still rejects structural
        // type or Relation changes until values are empty.
        can_change_type: active && custom,
        can_duplicate: active && system_role != Some(DatabasePropertySystemRole::TaskParent),
        can_delete: active && removable,
        can_restore: !active && removable,
        can_permanently_delete: !active && removable && referenced_view_ids.is_empty(),
        can_manage_options: active && option_backed,
        allowed_types: if active && custom {
            vec![
                DatabasePropertyType::Text,
                DatabasePropertyType::Number,
                DatabasePropertyType::Checkbox,
                DatabasePropertyType::Select,
                DatabasePropertyType::MultiSelect,
                DatabasePropertyType::Date,
                DatabasePropertyType::Datetime,
                DatabasePropertyType::Relation,
            ]
        } else {
            vec![]
        },
        blocked_reasons,
    };
    Ok(DatabasePropertyDescriptor {
        property_id: row.property_id,
        data_source_id: row.data_source_id,
        name: row.name,
        capabilities: super::property_semantics::capabilities(&schema),
        system_role,
        non_empty_value_count,
        referenced_view_ids,
        management_policy,
        schema,
        option_count: u32::try_from(option_count)
            .map_err(|_| corrupt("Property option count overflowed"))?,
        rank_key: row.rank_key,
        lifecycle: row.lifecycle,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) fn page_layout(
    connection: &Connection,
    data_source_id: &str,
) -> Result<DatabasePageLayout, StoreError> {
    let revision = connection
        .query_row(
            "SELECT revision FROM data_source_page_layouts WHERE data_source_id = ?1",
            [data_source_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Data Source Page layout is unavailable"))?;
    let rows = connection
        .prepare(
            "SELECT entry.property_id, entry.rank_key, entry.visibility \
             FROM data_source_page_layout_entries entry \
             JOIN data_source_properties property \
               ON property.data_source_id = entry.data_source_id \
              AND property.id = entry.property_id \
             WHERE entry.data_source_id = ?1 AND property.lifecycle = 'active' \
             ORDER BY entry.rank_key, entry.property_id",
        )?
        .query_map([data_source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let entries = rows
        .into_iter()
        .map(|(property_id, rank_key, visibility)| {
            let visibility = match visibility.as_str() {
                "always_show" => DatabasePagePropertyVisibility::AlwaysShow,
                "hide_when_empty" => DatabasePagePropertyVisibility::HideWhenEmpty,
                "always_hide" => DatabasePagePropertyVisibility::AlwaysHide,
                _ => return Err(corrupt("Page layout visibility is invalid")),
            };
            Ok(DatabasePageLayoutEntry {
                property_id,
                rank_key,
                visibility,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(DatabasePageLayout {
        data_source_id: data_source_id.to_owned(),
        revision,
        entries,
    })
}

fn non_empty_property_value_count(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
    value_type: &str,
) -> Result<i64, StoreError> {
    if value_type == "relation" {
        return connection
            .query_row(
                "SELECT count(DISTINCT source_membership_id) \
                 FROM data_source_relation_edges \
                 WHERE source_data_source_id = ?1 AND property_id = ?2",
                params![data_source_id, property_id],
                |row| row.get(0),
            )
            .map_err(StoreError::from);
    }
    connection
        .query_row(
            "SELECT count(*) FROM data_source_property_values \
             WHERE data_source_id = ?1 AND property_id = ?2 AND \
               CASE value_type \
                 WHEN 'text' THEN json_type(value_json) = 'text' \
                   AND length(json_extract(value_json, '$')) > 0 \
                 WHEN 'multi_select' THEN json_type(value_json) = 'array' \
                   AND json_array_length(value_json) > 0 \
                 ELSE json_type(value_json) <> 'null' \
               END",
            params![data_source_id, property_id],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

fn filter_references_property(
    filter: &nodex_core_contracts::database::DatabaseViewFilter,
    property_id: &str,
) -> bool {
    match filter {
        nodex_core_contracts::database::DatabaseViewFilter::Clause {
            property_id: candidate,
            ..
        } => candidate == property_id,
        nodex_core_contracts::database::DatabaseViewFilter::Group { children, .. } => children
            .iter()
            .any(|child| filter_references_property(child, property_id)),
    }
}

fn property_referenced_view_ids(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<Vec<String>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT id, config_json FROM database_views \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY rank_key, id",
        )?
        .query_map([data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .filter_map(|(view_id, config_json)| {
            let definition = match super::view_contract::decode_definition_json(&config_json) {
                Ok(value) => value,
                Err(message) => return Some(Err(corrupt(&message))),
            };
            let presentation = &definition.presentation;
            let referenced = filter_references_property(
                &super::view_contract::effective_filter(&definition.rules),
                property_id,
            ) || definition.rules.sorts.iter().any(|sort| {
                matches!(
                    &sort.field,
                    nodex_core_contracts::database::DatabaseViewSortField::Property {
                        property_id: candidate
                    } if candidate == property_id
                )
            }) || presentation
                .group
                .as_ref()
                .is_some_and(|group| group.property_id == property_id)
                || presentation
                    .subgroup
                    .as_ref()
                    .is_some_and(|group| group.property_id == property_id)
                || presentation.display.fields.iter().any(|field| {
                    matches!(
                        field,
                        nodex_core_contracts::database::DatabaseViewField::Property {
                            property_id: candidate
                        } if candidate == property_id
                    )
                })
                || presentation
                    .conditional_colors
                    .iter()
                    .any(|rule| rule.property_id == property_id);
            referenced.then_some(Ok(view_id))
        })
        .collect()
}

pub(crate) fn page_data_source_projection(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    data_source_id: &str,
    project_id: Option<&str>,
) -> Result<PageDataSourceProjection, StoreError> {
    let memberships = connection
        .prepare(
            "SELECT id, data_source_id, revision, created_at \
             FROM data_source_page_memberships \
             WHERE page_block_id = ?1 AND removed_at IS NULL ORDER BY id",
        )?
        .query_map([page_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let [(membership_id, membership_source_id, revision, created_at)] = memberships.as_slice()
    else {
        return Err(corrupt(
            "Data Source Page must have exactly one active membership",
        ));
    };
    if membership_source_id != data_source_id {
        return Err(corrupt(
            "Data Source Page membership and parent coordinates diverge",
        ));
    }
    let database_id = database_for_source(connection, library_id, data_source_id)?;
    let data_source = source_record(connection, library_id, data_source_id)?;
    if data_source.lifecycle == "deleted" {
        return Err(corrupt("Data Source Page belongs to a deleted Data Source"));
    }
    let database = container_record(connection, library_id, &database_id)?;
    if database.lifecycle == "deleted" {
        return Err(corrupt("Data Source Page belongs to a deleted Database"));
    }
    let mut values = read_values(connection, data_source_id, membership_id)?
        .into_iter()
        .collect();
    super::relation_projection::hydrate_projection_values(
        connection,
        library_id,
        project_id,
        data_source_id,
        membership_id,
        &mut values,
    )?;
    Ok(PageDataSourceProjection {
        page_key: super::current_page_key_for_database_page(
            connection,
            library_id,
            &database_id,
            page_id,
        )?,
        membership_id: membership_id.clone(),
        data_source_id: membership_source_id.clone(),
        membership_revision: *revision,
        membership_created_at: created_at.clone(),
        database: container_record_value(&database),
        data_source: data_source_record_value(&data_source),
        properties: property_records(connection, data_source_id, true)?,
        property_configs: read_property_configs(connection, data_source_id)?,
        values,
    })
}

pub(crate) fn read(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    request: DatabaseRead,
) -> Result<DatabaseReadValue, StoreError> {
    let commit_head = crate::infrastructure::local_commit::head(connection)?;
    read_at_commit_head(connection, library_id, commit_head, context, request)
}

pub(crate) fn read_at_commit_head(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    request: DatabaseRead,
) -> Result<DatabaseReadValue, StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str());
    if project_id.is_none() && !is_trusted_library_database_context(context) {
        return Err(unauthorized(
            "Database reads require a Project or trusted Library scope",
        ));
    }
    let primary_database_id = project_id
        .map(|project_id| project_primary_database(connection, library_id, project_id))
        .transpose()?
        .flatten();
    let store_epoch = crate::document::read_store_epoch(connection)?;
    let mut value = match request {
        DatabaseRead::CatalogWindow { window } => {
            let project_id = project_id
                .ok_or_else(|| invalid("Library Database reads require a concrete target"))?;
            DatabaseReadValue::CatalogWindow {
                databases: catalog_window(
                    connection,
                    library_id,
                    commit_head,
                    project_id,
                    primary_database_id.as_deref(),
                    &window,
                )?,
            }
        }
        DatabaseRead::Database { target } => {
            let database_id = match target {
                DatabaseIdentityTarget::ProjectDefault => primary_database_id
                    .clone()
                    .ok_or_else(|| not_found("Project has no primary Database"))?,
                DatabaseIdentityTarget::Database { database_id } => database_id,
            };
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::Database {
                value: database_descriptor(connection, library_id, &database_id)?,
            }
        }
        DatabaseRead::PageKeyPrefixPreview {
            database_id,
            name_hint,
            requested_prefix,
        } => {
            if let Some(database_id) = database_id.as_deref() {
                authorize_required(
                    connection,
                    project_id,
                    primary_database_id.as_deref(),
                    database_id,
                )?;
            }
            let preview = super::preview_page_key_prefix(
                connection,
                library_id,
                &name_hint,
                requested_prefix.as_deref(),
                database_id.as_deref(),
            )?;
            let availability = match preview.availability {
                super::page_key::PageKeyPrefixAvailability::Available => {
                    DatabasePageKeyPrefixAvailability::Available
                }
                super::page_key::PageKeyPrefixAvailability::Current => {
                    DatabasePageKeyPrefixAvailability::Current
                }
                super::page_key::PageKeyPrefixAvailability::Reserved => {
                    DatabasePageKeyPrefixAvailability::Reserved
                }
            };
            DatabaseReadValue::PageKeyPrefixPreview {
                value: DatabasePageKeyPrefixPreview {
                    example_keys: page_key_examples(&preview.prefix, preview.next_number)?,
                    prefix: preview.prefix,
                    availability,
                    alternative_prefix: preview.alternative_prefix,
                    next_number: preview.next_number,
                },
            }
        }
        DatabaseRead::PageKeyNamespace { database_id } => {
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            let settings =
                super::page_key_namespace_settings(connection, library_id, &database_id)?
                    .ok_or_else(|| {
                        not_found("Page-key namespace is not enabled for this Database")
                    })?;
            DatabaseReadValue::PageKeyNamespace {
                value: DatabasePageKeyNamespace {
                    database_id,
                    current_prefix: settings.current_prefix,
                    next_number: settings.next_number,
                    assigned_page_count: settings.assigned_page_count,
                    revision: settings.revision,
                    retired_prefixes: settings
                        .retired_prefixes
                        .into_iter()
                        .map(|prefix| DatabaseRetiredPageKeyPrefix {
                            prefix: prefix.prefix,
                            last_number: prefix.last_number,
                        })
                        .collect(),
                },
            }
        }
        DatabaseRead::DataSourceWindow {
            database_id,
            window,
        } => {
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::DataSourceWindow {
                data_sources: data_source_window(
                    connection,
                    library_id,
                    commit_head,
                    &database_id,
                    &window,
                )?,
            }
        }
        DatabaseRead::DataSource { data_source_id } => {
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::DataSource {
                value: data_source_descriptor(connection, library_id, &data_source_id)?,
            }
        }
        DatabaseRead::PropertyWindow {
            data_source_id,
            window,
        } => {
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::PropertyWindow {
                properties: property_window(
                    connection,
                    library_id,
                    commit_head,
                    &data_source_id,
                    &window,
                )?,
            }
        }
        DatabaseRead::OptionWindow {
            data_source_id,
            property_id,
            window,
        } => {
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::OptionWindow {
                options: option_window(
                    connection,
                    library_id,
                    commit_head,
                    &data_source_id,
                    &property_id,
                    &window,
                )?,
            }
        }
        DatabaseRead::PageLayout { data_source_id } => {
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::PageLayout {
                value: page_layout(connection, &data_source_id)?,
            }
        }
        DatabaseRead::ViewDescriptorWindow {
            database_id,
            window,
        } => {
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::ViewDescriptorWindow {
                views: view_descriptor_window(
                    connection,
                    library_id,
                    commit_head,
                    project_id,
                    &database_id,
                    &window,
                )?,
            }
        }
        DatabaseRead::View { view_id } => {
            authorize_view(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                &view_id,
            )?;
            DatabaseReadValue::View {
                value: view_record(connection, library_id, project_id, &view_id)?,
            }
        }
        DatabaseRead::ViewPersonalPreferences { view_id } => {
            authorize_view(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                &view_id,
            )?;
            DatabaseReadValue::ViewPersonalPreferences {
                value: view_personal_preferences(
                    connection,
                    context.profile_id.0.as_str(),
                    &view_id,
                )?,
            }
        }
        DatabaseRead::ViewCollapsedOccurrences { view_id } => {
            authorize_view(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                &view_id,
            )?;
            DatabaseReadValue::ViewCollapsedOccurrences {
                value: view_collapsed_occurrences(
                    connection,
                    context.profile_id.0.as_str(),
                    &view_id,
                )?,
            }
        }
        DatabaseRead::ViewWindow {
            target,
            window,
            group_scope,
        } => {
            let resolved = resolve_view_read_target(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                target,
            )?;
            validate_view_filter_access_by_id(
                connection,
                library_id,
                project_id,
                &resolved.view_id,
            )?;
            let read = super::window::ViewWindowRead {
                commit_head,
                project_id,
                store_epoch: &store_epoch,
                window: &window,
                group_scope: group_scope.as_ref(),
            };
            let value = match resolved.preferences_override {
                Some(preferences_override) => super::window::presented_view_window(
                    connection,
                    library_id,
                    &resolved.view_id,
                    &preferences_override,
                    read,
                )?,
                None => {
                    super::window::view_window(connection, library_id, &resolved.view_id, read)?
                }
            };
            DatabaseReadValue::ViewWindow { value }
        }
        DatabaseRead::ListWindow { target, window } => {
            let resolved = resolve_view_read_target(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                target,
            )?;
            validate_view_filter_access_by_id(
                connection,
                library_id,
                project_id,
                &resolved.view_id,
            )?;
            let read = super::window::ViewWindowRead {
                commit_head,
                project_id,
                store_epoch: &store_epoch,
                window: &window,
                group_scope: None,
            };
            let value = match resolved.preferences_override {
                Some(preferences_override) => super::window::presented_list_window(
                    connection,
                    library_id,
                    &resolved.view_id,
                    &preferences_override,
                    read,
                )?,
                None => {
                    super::window::list_window(connection, library_id, &resolved.view_id, read)?
                }
            };
            DatabaseReadValue::ListWindow { value }
        }
        DatabaseRead::ViewGroups { target } => {
            let resolved = resolve_view_read_target(
                connection,
                library_id,
                project_id,
                primary_database_id.as_deref(),
                target,
            )?;
            validate_view_filter_access_by_id(
                connection,
                library_id,
                project_id,
                &resolved.view_id,
            )?;
            let read = super::window::ViewGroupsRead {
                commit_head,
                project_id,
                store_epoch: &store_epoch,
            };
            let value = match resolved.preferences_override {
                Some(preferences_override) => super::window::presented_view_groups(
                    connection,
                    library_id,
                    &resolved.view_id,
                    &preferences_override,
                    read,
                )?,
                None => {
                    super::window::view_groups(connection, library_id, &resolved.view_id, read)?
                }
            };
            DatabaseReadValue::ViewGroups { value }
        }
        DatabaseRead::ViewContext {
            view_id,
            window,
            group_scope,
        } => {
            let project_id = project_id
                .ok_or_else(|| invalid("Database View context requires a Project scope"))?;
            authorize_view(
                connection,
                library_id,
                Some(project_id),
                primary_database_id.as_deref(),
                &view_id,
            )?;
            let projection = super::window::view_context(
                connection,
                library_id,
                &view_id,
                super::window::ViewContextRead {
                    commit_head,
                    project_id,
                    store_epoch: &store_epoch,
                    window: &window,
                    group_scope: group_scope.as_ref(),
                },
            )?;
            let property_ids = projection
                .property_ids
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            let properties = property_records(connection, &projection.data_source_id, true)?
                .into_iter()
                .filter(|property| property_ids.contains(property.property_id.as_str()))
                .collect();
            DatabaseReadValue::ViewContext {
                value: Box::new(DatabaseViewContext {
                    database: container_record(connection, library_id, &projection.database_id)?,
                    data_source: source_record(connection, library_id, &projection.data_source_id)?,
                    view: view_record(connection, library_id, Some(project_id), &view_id)?,
                    properties,
                    groups: projection.groups,
                    projection: projection.projection,
                    rows: projection.rows,
                }),
            }
        }
        DatabaseRead::RowsById { target, page_ids } => {
            let view_id = match target {
                DatabaseRowsTarget::ProjectDefault => {
                    let database_id = primary_database_id
                        .clone()
                        .ok_or_else(|| not_found("Project has no primary Database"))?;
                    authorize_required(
                        connection,
                        project_id,
                        primary_database_id.as_deref(),
                        &database_id,
                    )?;
                    default_view_for_database(connection, &database_id)?
                }
                DatabaseRowsTarget::View { view_id } => {
                    authorize_view(
                        connection,
                        library_id,
                        project_id,
                        primary_database_id.as_deref(),
                        &view_id,
                    )?;
                    view_id
                }
            };
            DatabaseReadValue::RowsById {
                value: super::window::rows_by_id(connection, library_id, &view_id, &page_ids)?,
            }
        }
        DatabaseRead::RowDetail { page_id } => {
            let data_source_id = data_source_for_page(connection, library_id, &page_id)?;
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            let view_id = default_view_for_database(connection, &database_id)?;
            DatabaseReadValue::RowDetail {
                value: Box::new(super::window::row_detail(
                    connection, library_id, &view_id, &page_id,
                )?),
            }
        }
        DatabaseRead::AgentDataSourceQuery {
            data_source_id,
            query,
        } => {
            crate::library::agent_authorization::authorize_execution(
                connection,
                context,
                library_id,
                &query.authorization,
                &AgentAuthorizationTarget::DataSource {
                    data_source_id: data_source_id.clone(),
                },
                AgentProjectResourceAction::Read,
            )?;
            let window = CollectionWindowRequest {
                after: query.cursor.clone(),
                first: query.limit,
            };
            DatabaseReadValue::AgentDataSourceQuery {
                value: super::window::agent_data_source_window(
                    connection,
                    library_id,
                    &data_source_id,
                    &query,
                    super::window::ViewWindowRead {
                        commit_head,
                        project_id,
                        store_epoch: &store_epoch,
                        window: &window,
                        group_scope: None,
                    },
                )?,
            }
        }
        DatabaseRead::AgentViewQuery { view_id, query } => {
            crate::library::agent_authorization::authorize_execution(
                connection,
                context,
                library_id,
                &query.authorization,
                &AgentAuthorizationTarget::View {
                    view_id: view_id.clone(),
                },
                AgentProjectResourceAction::Read,
            )?;
            validate_view_filter_access_by_id(connection, library_id, project_id, &view_id)?;
            let window = CollectionWindowRequest {
                after: query.cursor,
                first: query.limit,
            };
            DatabaseReadValue::AgentViewQuery {
                value: super::window::agent_view_window(
                    connection,
                    library_id,
                    &view_id,
                    query.projection_property_ids.as_deref(),
                    super::window::ViewWindowRead {
                        commit_head,
                        project_id,
                        store_epoch: &store_epoch,
                        window: &window,
                        group_scope: None,
                    },
                )?,
            }
        }
        DatabaseRead::RelationTargetWindow { address, window } => {
            let database_id = database_for_source(connection, library_id, &address.data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::RelationTargetWindow {
                value: super::relation::target_window(
                    connection,
                    library_id,
                    commit_head,
                    project_id,
                    &address,
                    &window,
                )?,
            }
        }
        DatabaseRead::RelationCandidateWindow {
            data_source_id,
            query,
            window,
        } => {
            let database_id = database_for_source(connection, library_id, &data_source_id)?;
            authorize_required(
                connection,
                project_id,
                primary_database_id.as_deref(),
                &database_id,
            )?;
            DatabaseReadValue::RelationCandidateWindow {
                candidates: super::relation::candidate_window(
                    connection,
                    library_id,
                    commit_head,
                    &data_source_id,
                    query.as_deref(),
                    &window,
                )?,
            }
        }
    };
    hydrate_relation_previews(connection, library_id, project_id, &mut value)?;
    Ok(value)
}

fn page_key_examples(prefix: &str, next_number: i64) -> Result<Vec<String>, StoreError> {
    (0_i64..3)
        .map(|offset| {
            next_number
                .checked_add(offset)
                .map(|number| format!("{prefix}-{number}"))
                .ok_or_else(|| {
                    StoreError::new(
                        StoreErrorCode::ResourceExhausted,
                        "Page-key namespace cannot produce another preview example",
                        false,
                    )
                })
        })
        .collect()
}

struct ResolvedViewReadTarget {
    view_id: String,
    preferences_override: Option<DatabaseViewPreferencesOverrideInput>,
}

fn resolve_view_read_target(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    primary_database_id: Option<&str>,
    target: DatabaseViewReadTarget,
) -> Result<ResolvedViewReadTarget, StoreError> {
    let (view_id, preferences_override) = match target {
        DatabaseViewReadTarget::ProjectDefault => {
            let database_id =
                primary_database_id.ok_or_else(|| not_found("Project has no primary Database"))?;
            authorize_required(connection, project_id, primary_database_id, database_id)?;
            (default_view_for_database(connection, database_id)?, None)
        }
        DatabaseViewReadTarget::Database { database_id } => {
            authorize_required(connection, project_id, primary_database_id, &database_id)?;
            (default_view_for_database(connection, &database_id)?, None)
        }
        DatabaseViewReadTarget::View { view_id } => {
            authorize_view(
                connection,
                library_id,
                project_id,
                primary_database_id,
                &view_id,
            )?;
            (view_id, None)
        }
        DatabaseViewReadTarget::PresentedView {
            view_id,
            preferences_override,
        } => {
            authorize_view(
                connection,
                library_id,
                project_id,
                primary_database_id,
                &view_id,
            )?;
            (view_id, Some(preferences_override))
        }
    };
    Ok(ResolvedViewReadTarget {
        view_id,
        preferences_override,
    })
}

fn authorize_view(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    primary_database_id: Option<&str>,
    view_id: &str,
) -> Result<(), StoreError> {
    let database_id = database_for_view(connection, library_id, view_id)?;
    authorize_required(connection, project_id, primary_database_id, &database_id)
}

fn view_personal_preferences(
    connection: &Connection,
    profile_id: &str,
    view_id: &str,
) -> Result<DatabaseViewPersonalPreferences, StoreError> {
    let stored = connection
        .query_row(
            "SELECT preferences_json, revision \
             FROM database_view_personal_preferences \
             WHERE profile_id = ?1 AND view_id = ?2",
            params![profile_id, view_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((presentation_json, revision)) = stored else {
        return Ok(DatabaseViewPersonalPreferences {
            rules_override: Default::default(),
            presentation_override: Default::default(),
            revision: 0,
        });
    };
    let preferences_override =
        serde_json::from_str::<DatabaseViewPreferencesOverrideInput>(&presentation_json)
            .map_err(|_| corrupt("Database View personal preferences are invalid"))?;
    Ok(DatabaseViewPersonalPreferences {
        rules_override: preferences_override.rules_override,
        presentation_override: preferences_override.presentation_override,
        revision,
    })
}

fn view_collapsed_occurrences(
    connection: &Connection,
    profile_id: &str,
    view_id: &str,
) -> Result<DatabaseViewCollapsedOccurrences, StoreError> {
    let rows = connection
        .prepare(
            "SELECT target_kind, occurrence_key \
             FROM database_view_collapsed_occurrences \
             WHERE profile_id = ?1 AND view_id = ?2 \
             ORDER BY target_kind, occurrence_key LIMIT 2001",
        )?
        .query_map(params![profile_id, view_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 2_000 {
        return Err(corrupt(
            "Database View collapsed occurrences exceed their durable bound",
        ));
    }
    let targets = rows
        .into_iter()
        .map(|(kind, occurrence_key)| match kind.as_str() {
            "group" => Ok(DatabaseViewDisclosureTarget::Group { occurrence_key }),
            "page" => Ok(DatabaseViewDisclosureTarget::Page { occurrence_key }),
            _ => Err(corrupt("Database View disclosure target kind is invalid")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DatabaseViewCollapsedOccurrences { targets })
}

fn hydrate_relation_previews(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    value: &mut DatabaseReadValue,
) -> Result<(), StoreError> {
    match value {
        DatabaseReadValue::ViewWindow { value } | DatabaseReadValue::AgentViewQuery { value } => {
            super::relation_projection::hydrate_row_previews(
                connection,
                library_id,
                project_id,
                &value.data_source_id,
                &mut value.rows.items,
            )
        }
        DatabaseReadValue::AgentDataSourceQuery { value } => {
            super::relation_projection::hydrate_row_previews(
                connection,
                library_id,
                project_id,
                &value.data_source_id,
                &mut value.rows.items,
            )
        }
        DatabaseReadValue::ListWindow { value } => {
            let mut summaries = value
                .rows
                .items
                .iter_mut()
                .filter_map(|row| match row {
                    nodex_core_contracts::database::DatabaseListProjectionRow::Page {
                        summary,
                        ..
                    } => Some(summary.as_mut()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            hydrate_summary_refs(
                connection,
                library_id,
                project_id,
                &value.data_source_id,
                &mut summaries,
            )
        }
        DatabaseReadValue::ViewContext { value } => {
            let mut summaries = value
                .rows
                .items
                .iter_mut()
                .map(|row| &mut row.summary)
                .collect::<Vec<_>>();
            hydrate_summary_refs(
                connection,
                library_id,
                project_id,
                &value.data_source.data_source_id,
                &mut summaries,
            )
        }
        DatabaseReadValue::RowsById { value } => {
            hydrate_summary_rows(connection, library_id, project_id, &mut value.rows)
        }
        DatabaseReadValue::RowDetail { value } => hydrate_summary_rows(
            connection,
            library_id,
            project_id,
            std::slice::from_mut(&mut value.summary),
        ),
        _ => Ok(()),
    }
}

fn hydrate_summary_rows(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    rows: &mut [nodex_core_contracts::database::DatabaseRowSummary],
) -> Result<(), StoreError> {
    let Some(first) = rows.first() else {
        return Ok(());
    };
    let data_source_id = connection
        .query_row(
            "SELECT data_source_id FROM data_source_page_memberships WHERE id = ?1",
            [&first.membership_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| corrupt("Database row membership is unavailable"))?;
    super::relation_projection::hydrate_row_previews(
        connection,
        library_id,
        project_id,
        &data_source_id,
        rows,
    )
}

fn hydrate_summary_refs(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    data_source_id: &str,
    rows: &mut [&mut nodex_core_contracts::database::DatabaseRowSummary],
) -> Result<(), StoreError> {
    let mut owned = rows.iter().map(|row| (*row).clone()).collect::<Vec<_>>();
    super::relation_projection::hydrate_row_previews(
        connection,
        library_id,
        project_id,
        data_source_id,
        &mut owned,
    )?;
    for (target, hydrated) in rows.iter_mut().zip(owned) {
        target.database_values = hydrated.database_values;
    }
    Ok(())
}

fn catalog_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    project_id: &str,
    primary_database_id: Option<&str>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabaseDescriptor>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("database_catalog_v1", project_id, primary_database_id))?;
    let subject = CollectionCursorSubject {
        kind: "database_catalog",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Database catalog cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT block_id FROM database_containers \
         WHERE library_id = ?1 AND lifecycle <> 'deleted' \
           AND (?2 IS NULL OR block_id > ?2) \
         ORDER BY block_id",
    )?;
    let mut rows = statement.query(params![library_id, after.as_deref()])?;
    let mut candidates = Vec::with_capacity(normalized.first + 1);
    while candidates.len() <= normalized.first {
        let Some(row) = rows.next()? else {
            break;
        };
        let database_id = row.get::<_, String>(0)?;
        if !authorize_database(connection, project_id, primary_database_id, &database_id)? {
            continue;
        }
        candidates.push(WindowCandidate {
            item: database_descriptor(connection, library_id, &database_id)?,
            coordinate: KeysetCoordinate {
                values: Vec::new(),
                stable_id: database_id,
            },
        });
    }
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

fn data_source_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    database_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabaseDataSourceRecord>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("database_data_sources_v1", database_id))?;
    let subject = CollectionCursorSubject {
        kind: "database_data_sources",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let RankCursor {
        bucket: after_bucket,
        rank: after_rank,
        stable_id: after_id,
    } = decode_rank_cursor(connection, subject, normalized.after)?;
    let query_limit = i64::try_from(normalized.first.saturating_add(1))
        .map_err(|_| invalid("Data Source window limit overflowed"))?;
    let ids = connection
        .prepare(
            "SELECT id, 0, rank_key \
             FROM data_sources WHERE home_database_block_id = ?1 AND lifecycle = 'active' \
               AND (?2 IS NULL \
                 OR CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END > ?2 \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 AND rank_key > ?3) \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 \
                   AND rank_key = ?3 AND id > ?4)) \
             ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, rank_key, id \
             LIMIT ?5",
        )?
        .query_map(
            params![database_id, after_bucket, after_rank, after_id, query_limit],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = ids
        .into_iter()
        .map(|(id, bucket, rank)| {
            Ok(WindowCandidate {
                item: source_record(connection, library_id, &id)?,
                coordinate: KeysetCoordinate {
                    values: vec![
                        cursor::KeysetValue::Integer { value: bucket },
                        cursor::KeysetValue::Text { value: rank },
                    ],
                    stable_id: id,
                },
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble_database_window(
        connection,
        subject,
        commit_head,
        normalized.first,
        candidates,
    )
}

fn view_descriptor_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    project_id: Option<&str>,
    database_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabaseViewRecord>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("database_views_v1", database_id))?;
    let subject = CollectionCursorSubject {
        kind: "database_views",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let RankCursor {
        bucket: after_bucket,
        rank: after_rank,
        stable_id: after_id,
    } = decode_rank_cursor(connection, subject, normalized.after)?;
    let query_limit = i64::try_from(normalized.first.saturating_add(1))
        .map_err(|_| invalid("Database View window limit overflowed"))?;
    let ids = connection
        .prepare(
            "SELECT id, 0, rank_key \
             FROM database_views WHERE database_block_id = ?1 AND lifecycle = 'active' \
               AND (?2 IS NULL \
                 OR CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END > ?2 \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 AND rank_key > ?3) \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 \
                   AND rank_key = ?3 AND id > ?4)) \
             ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, rank_key, id \
             LIMIT ?5",
        )?
        .query_map(
            params![database_id, after_bucket, after_rank, after_id, query_limit],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = ids
        .into_iter()
        .map(|(id, bucket, rank)| {
            Ok(WindowCandidate {
                item: view_record(connection, library_id, project_id, &id)?,
                coordinate: KeysetCoordinate {
                    values: vec![
                        cursor::KeysetValue::Integer { value: bucket },
                        cursor::KeysetValue::Text { value: rank },
                    ],
                    stable_id: id,
                },
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble_database_window(
        connection,
        subject,
        commit_head,
        normalized.first,
        candidates,
    )
}

fn property_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    data_source_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabasePropertyDescriptor>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("database_properties_v2", data_source_id))?;
    let subject = CollectionCursorSubject {
        kind: "database_properties",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let RankCursor {
        bucket: after_bucket,
        rank: after_rank,
        stable_id: after_id,
    } = decode_rank_cursor(connection, subject, normalized.after)?;
    let query_limit = i64::try_from(normalized.first.saturating_add(1))
        .map_err(|_| invalid("Property window limit overflowed"))?;
    let candidate_rows = connection
        .prepare(
            "SELECT id, data_source_id, name, value_type, config_json, rank_key, lifecycle, \
               schema_revision, created_at, updated_at, \
               CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END \
             FROM data_source_properties WHERE data_source_id = ?1 \
               AND (?2 IS NULL \
                 OR CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END > ?2 \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 AND rank_key > ?3) \
                 OR (CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END = ?2 \
                   AND rank_key = ?3 AND id > ?4)) \
             ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, rank_key, id \
             LIMIT ?5",
        )?
        .query_map(
            params![
                data_source_id,
                after_bucket,
                after_rank,
                after_id,
                query_limit
            ],
            |row| {
                let id = row.get::<_, String>(0)?;
                let value_type = row.get::<_, String>(3)?;
                let rank = row.get::<_, String>(5)?;
                let bucket = row.get::<_, i64>(10)?;
                Ok((
                    PropertyDescriptorRow {
                        property_id: id.clone(),
                        data_source_id: row.get::<_, String>(1)?,
                        name: row.get::<_, String>(2)?,
                        value_type,
                        config_json: row.get::<_, String>(4)?,
                        rank_key: rank.clone(),
                        lifecycle: row.get::<_, String>(6)?,
                        revision: row.get::<_, i64>(7)?,
                        created_at: row.get::<_, String>(8)?,
                        updated_at: row.get::<_, String>(9)?,
                    },
                    KeysetCoordinate {
                        values: vec![
                            cursor::KeysetValue::Integer { value: bucket },
                            cursor::KeysetValue::Text { value: rank },
                        ],
                        stable_id: id,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = candidate_rows
        .into_iter()
        .map(|(row, coordinate)| {
            Ok(WindowCandidate {
                item: property_descriptor(connection, row)?,
                coordinate,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble_database_window(
        connection,
        subject,
        commit_head,
        normalized.first,
        candidates,
    )
}

fn option_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    data_source_id: &str,
    property_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<DatabasePropertyOption>, StoreError> {
    if !super::property_semantics::is_canonical_property_id(property_id) {
        return Err(invalid("Property ID is not canonical"));
    }
    let normalized = normalize_request(request)?;
    let (value_type, config_json, property_revision) = connection
        .query_row(
            "SELECT value_type, config_json, schema_revision FROM data_source_properties \
             WHERE data_source_id = ?1 AND id = ?2 AND lifecycle = 'active'",
            params![data_source_id, property_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    if !matches!(value_type.as_str(), "select" | "multi_select") {
        return Err(invalid("Property is not option-backed"));
    }
    let fingerprint = cursor::query_fingerprint(&(
        "database_property_options_v2",
        data_source_id,
        property_id,
        property_revision,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "database_property_options",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [cursor::KeysetValue::Integer { value: ordinal }] = coordinate.values.as_slice()
            else {
                return Err(invalid("Property option cursor is incompatible"));
            };
            if direction != CursorDirection::Forward || *ordinal < 0 {
                return Err(invalid("Property option cursor is incompatible"));
            }
            usize::try_from(*ordinal).map_err(|_| invalid("Property option cursor is incompatible"))
        })
        .transpose()?;
    let config = super::property_semantics::option_config_from_storage(
        property_id,
        &value_type,
        &config_json,
    )?;
    let candidates = config
        .options
        .into_iter()
        .enumerate()
        .filter(|(ordinal, _)| after.is_none_or(|after| *ordinal > after))
        .take(normalized.first.saturating_add(1))
        .map(|(ordinal, option)| {
            let option = DatabasePropertyOption {
                selected_page_count: selected_option_page_count(
                    connection,
                    data_source_id,
                    property_id,
                    &option.id,
                )?,
                id: option.id,
                name: option.name,
                color: option.color,
            };
            let id = option.id.clone();
            Ok(WindowCandidate {
                item: option,
                coordinate: KeysetCoordinate {
                    values: vec![cursor::KeysetValue::Integer {
                        value: i64::try_from(ordinal)
                            .expect("Property option ordinals stay within their fixed bound"),
                    }],
                    stable_id: id,
                },
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble_database_window(
        connection,
        subject,
        commit_head,
        normalized.first,
        candidates,
    )
}

fn selected_option_page_count(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
    option_id: &str,
) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT count(DISTINCT value.membership_id) \
             FROM data_source_property_values value \
             WHERE value.data_source_id = ?1 AND value.property_id = ?2 AND (\
               (json_type(value.value_json) = 'text' \
                 AND json_extract(value.value_json, '$') = ?3) \
               OR (json_type(value.value_json) = 'array' AND EXISTS (\
                 SELECT 1 FROM json_each(value.value_json) item WHERE item.value = ?3\
               ))\
             )",
            params![data_source_id, property_id, option_id],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

fn assemble_database_window<T: serde::Serialize>(
    connection: &Connection,
    subject: CollectionCursorSubject<'_>,
    commit_head: i64,
    first: usize,
    candidates: Vec<WindowCandidate<T>>,
) -> Result<CollectionWindow<T>, StoreError> {
    assemble(
        candidates,
        first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

struct RankCursor {
    bucket: Option<i64>,
    rank: Option<String>,
    stable_id: Option<String>,
}

fn decode_rank_cursor(
    connection: &Connection,
    subject: CollectionCursorSubject<'_>,
    encoded: Option<&str>,
) -> Result<RankCursor, StoreError> {
    let Some(encoded) = encoded else {
        return Ok(RankCursor {
            bucket: None,
            rank: None,
            stable_id: None,
        });
    };
    let (direction, coordinate) = cursor::decode(connection, encoded, subject)?;
    let [
        cursor::KeysetValue::Integer { value: bucket },
        cursor::KeysetValue::Text { value: rank },
    ] = coordinate.values.as_slice()
    else {
        return Err(invalid("Database descriptor cursor is incompatible"));
    };
    if direction != CursorDirection::Forward {
        return Err(invalid(
            "Database descriptor cursor direction is incompatible",
        ));
    }
    Ok(RankCursor {
        bucket: Some(*bucket),
        rank: Some(rank.clone()),
        stable_id: Some(coordinate.stable_id),
    })
}

fn default_view_for_database(
    connection: &Connection,
    database_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT default_view_id FROM database_containers WHERE block_id = ?1",
            [database_id],
            |row| row.get::<_, Option<String>>(0),
        )?
        .ok_or_else(|| not_found("Database has no default View"))
}

fn database_for_source(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT home_database_block_id FROM data_sources \
             WHERE id = ?1 AND library_id = ?2",
            params![data_source_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Data Source is unavailable"))
}

fn database_for_view(
    connection: &Connection,
    library_id: &str,
    view_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT view.database_block_id FROM database_views view \
             JOIN database_containers container ON container.block_id = view.database_block_id \
             WHERE view.id = ?1 AND container.library_id = ?2",
            params![view_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Database View is unavailable"))
}

fn data_source_for_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT page.parent_id FROM pages page JOIN blocks block \
               ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND page.parent_kind = 'data_source' AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Database Page is unavailable"))
}

fn database_descriptor(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<DatabaseDescriptor, StoreError> {
    Ok(DatabaseDescriptor {
        database: container_record(connection, library_id, database_id)?,
    })
}

fn data_source_descriptor(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<DatabaseDataSourceDescriptor, StoreError> {
    Ok(DatabaseDataSourceDescriptor {
        data_source: source_record(connection, library_id, data_source_id)?,
    })
}

fn container_record(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<DatabaseContainerRecord, StoreError> {
    connection
        .query_row(
            "SELECT block_id, library_id, name, lifecycle, default_view_id, access_revision, \
               metadata_revision, created_at, updated_at FROM database_containers \
             WHERE block_id = ?1 AND library_id = ?2",
            params![database_id, library_id],
            |row| {
                Ok(DatabaseContainerRecord {
                    database_id: row.get(0)?,
                    library_id: row.get(1)?,
                    name: row.get(2)?,
                    lifecycle: row.get(3)?,
                    default_view_id: row.get(4)?,
                    access_revision: row.get(5)?,
                    metadata_revision: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Database is unavailable in this Library"))
}

fn source_record(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<DatabaseDataSourceRecord, StoreError> {
    connection
        .query_row(
            "SELECT id, library_id, home_database_block_id, name, schema_key, schema_revision, \
               lifecycle, rank_key, created_at, updated_at FROM data_sources \
             WHERE id = ?1 AND library_id = ?2",
            params![data_source_id, library_id],
            |row| {
                Ok(DatabaseDataSourceRecord {
                    data_source_id: row.get(0)?,
                    library_id: row.get(1)?,
                    home_database_id: row.get(2)?,
                    name: row.get(3)?,
                    schema_key: row.get(4)?,
                    schema_revision: row.get(5)?,
                    lifecycle: row.get(6)?,
                    rank_key: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Data Source is unavailable in this Library"))
}

fn container_record_value(record: &DatabaseContainerRecord) -> Value {
    json!({
        "databaseId": record.database_id,
        "libraryId": record.library_id,
        "name": record.name,
        "lifecycle": record.lifecycle,
        "defaultViewId": record.default_view_id,
        "accessRevision": record.access_revision,
        "metadataRevision": record.metadata_revision,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn data_source_record_value(record: &DatabaseDataSourceRecord) -> Value {
    json!({
        "dataSourceId": record.data_source_id,
        "libraryId": record.library_id,
        "homeDatabaseId": record.home_database_id,
        "name": record.name,
        "schemaKey": record.schema_key,
        "schemaRevision": record.schema_revision,
        "lifecycle": record.lifecycle,
        "rankKey": record.rank_key,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn view_record_value(record: &DatabaseViewRecord) -> Result<Value, StoreError> {
    let config = serde_json::from_str::<Value>(
        &super::view_contract::encode_definition_json(&record.definition)
            .map_err(|message| corrupt(&message))?,
    )
    .map_err(|_| corrupt("Database View definition cannot encode"))?;
    Ok(json!({
        "viewId": record.view_id,
        "databaseId": record.database_id,
        "dataSourceId": record.data_source_id,
        "name": record.name,
        "layout": match record.layout {
            DatabaseViewLayout::Board => "board",
            DatabaseViewLayout::List => "list",
        },
        "config": config,
        "isDefault": record.is_default,
        "revision": record.revision,
        "rankKey": record.rank_key,
        "lifecycle": record.lifecycle,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    }))
}

fn property_records(
    connection: &Connection,
    data_source_id: &str,
    active_only: bool,
) -> Result<Vec<DatabasePropertyDescriptor>, StoreError> {
    let lifecycle = if active_only {
        "AND lifecycle = 'active'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, data_source_id, name, value_type, config_json, rank_key, lifecycle, \
           schema_revision, created_at, updated_at FROM data_source_properties \
         WHERE data_source_id = ?1 {lifecycle} \
         ORDER BY CASE lifecycle WHEN 'active' THEN 0 ELSE 1 END, rank_key, id"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map([data_source_id], |row| {
            let property_id = row.get::<_, String>(0)?;
            let value_type = row.get::<_, String>(3)?;
            Ok(PropertyDescriptorRow {
                property_id,
                data_source_id: row.get::<_, String>(1)?,
                name: row.get::<_, String>(2)?,
                value_type,
                config_json: row.get::<_, String>(4)?,
                rank_key: row.get::<_, String>(5)?,
                lifecycle: row.get::<_, String>(6)?,
                revision: row.get::<_, i64>(7)?,
                created_at: row.get::<_, String>(8)?,
                updated_at: row.get::<_, String>(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| property_descriptor(connection, row))
        .collect()
}

fn read_property_configs(
    connection: &Connection,
    data_source_id: &str,
) -> Result<BTreeMap<String, Value>, StoreError> {
    connection
        .prepare(
            "SELECT id, config_json FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([data_source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                parse_json(row.get::<_, String>(1)?, "Property config")?,
            ))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .map_err(StoreError::from)
}

fn property_record(
    connection: &Connection,
    data_source_id: &str,
    property_id: &str,
) -> Result<DatabasePropertyDescriptor, StoreError> {
    let row = connection
        .query_row(
            "SELECT id, data_source_id, name, value_type, config_json, rank_key, lifecycle, \
               schema_revision, created_at, updated_at FROM data_source_properties \
             WHERE data_source_id = ?1 AND id = ?2",
            params![data_source_id, property_id],
            |row| {
                let property_id = row.get::<_, String>(0)?;
                let value_type = row.get::<_, String>(3)?;
                Ok(PropertyDescriptorRow {
                    property_id,
                    data_source_id: row.get::<_, String>(1)?,
                    name: row.get::<_, String>(2)?,
                    value_type,
                    config_json: row.get::<_, String>(4)?,
                    rank_key: row.get::<_, String>(5)?,
                    lifecycle: row.get::<_, String>(6)?,
                    revision: row.get::<_, i64>(7)?,
                    created_at: row.get::<_, String>(8)?,
                    updated_at: row.get::<_, String>(9)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Property is unavailable"))?;
    property_descriptor(connection, row)
}

fn view_record(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    view_id: &str,
) -> Result<DatabaseViewRecord, StoreError> {
    let stored = connection
        .query_row(
            "SELECT view.id, view.database_block_id, view.data_source_id, view.name, view.layout, \
               view.config_json, view.revision, view.rank_key, view.lifecycle, view.created_at, \
               view.updated_at, container.default_view_id \
             FROM database_views view JOIN database_containers container \
               ON container.block_id = view.database_block_id WHERE view.id = ?1",
            [view_id],
            |row| {
                let id = row.get::<_, String>(0)?;
                let default_view_id = row.get::<_, Option<String>>(11)?;
                Ok((
                    id.clone(),
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    default_view_id.as_deref() == Some(id.as_str()),
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Database View is unavailable"))?;
    let (
        view_id,
        database_id,
        data_source_id,
        name,
        layout,
        config_json,
        is_default,
        revision,
        rank_key,
        lifecycle,
        created_at,
        updated_at,
    ) = stored;
    let layout = match layout.as_str() {
        "board" => DatabaseViewLayout::Board,
        "list" => DatabaseViewLayout::List,
        _ => return Err(corrupt("Database View layout is invalid")),
    };
    let definition = super::view_contract::decode_definition_json(&config_json)
        .map_err(|message| corrupt(&message))?;
    super::relation::validate_view_filter_read_access(
        connection,
        library_id,
        project_id,
        &data_source_id,
        &super::view_contract::effective_filter(&definition.rules),
    )?;
    Ok(DatabaseViewRecord {
        view_id,
        database_id,
        data_source_id,
        name,
        layout,
        definition,
        is_default,
        revision,
        rank_key,
        lifecycle,
        created_at,
        updated_at,
    })
}

fn validate_view_filter_access_by_id(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    view_id: &str,
) -> Result<(), StoreError> {
    let (data_source_id, config_json) = connection
        .query_row(
            "SELECT data_source_id, config_json FROM database_views WHERE id = ?1",
            [view_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Database View is unavailable"))?;
    let definition = super::view_contract::decode_definition_json(&config_json)
        .map_err(|message| corrupt(&message))?;
    super::relation::validate_view_filter_read_access(
        connection,
        library_id,
        project_id,
        &data_source_id,
        &super::view_contract::effective_filter(&definition.rules),
    )
}

pub(crate) fn view_descriptor_query(
    connection: &Connection,
    library_id: &str,
    project_id: Option<&str>,
    view_id: &str,
) -> Result<Value, StoreError> {
    let view = view_record(connection, library_id, project_id, view_id)?;
    if view.lifecycle != "active" {
        return Err(not_found("Database View is not active"));
    }
    let tags_property = property_record(connection, &view.data_source_id, "tags")?;
    if tags_property.lifecycle != "active" {
        return Err(not_found(
            "Default Data Source tags Property is unavailable",
        ));
    }
    let database = container_record(connection, library_id, &view.database_id)?;
    let data_source = source_record(connection, library_id, &view.data_source_id)?;
    Ok(json!({
        "database": container_record_value(&database),
        "dataSource": data_source_record_value(&data_source),
        "view": view_record_value(&view)?,
        "properties": [serde_json::to_value(tags_property)
            .map_err(|_| corrupt("Property descriptor cannot encode"))?],
        "rows": [],
    }))
}

fn read_values(
    connection: &Connection,
    data_source_id: &str,
    membership_id: &str,
) -> Result<Map<String, Value>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT value.property_id, value.value_type, value.value_json, value.revision \
             FROM data_source_property_values value JOIN data_source_properties property \
               ON property.data_source_id = value.data_source_id \
               AND property.id = value.property_id AND property.lifecycle = 'active' \
             WHERE value.data_source_id = ?1 AND value.membership_id = ?2 \
             ORDER BY value.property_id",
        )?
        .query_map(params![data_source_id, membership_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(property_id, value_type, value_json, revision)| {
            Ok((
                property_id.clone(),
                json!({
                    "propertyId": property_id,
                    "valueType": value_type,
                    "value": parse_json(value_json, "Property value")?,
                    "revision": revision,
                }),
            ))
        })
        .collect()
}

pub(crate) fn page_record(connection: &Connection, page_id: &str) -> Result<Value, StoreError> {
    connection
        .query_row(
            "SELECT page.block_id, page.library_id, page.parent_kind, page.parent_id, \
               block.lifecycle, block.placement_revision, block.metadata_revision, page.document_id, \
               document.generation, document.head_seq, materialization.title, \
               materialization.title_rich_json, materialization.preview, materialization.plain_text, \
               page.created_at, page.updated_at \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id AND document.library_id = page.library_id \
             JOIN document_materializations materialization ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             WHERE page.block_id = ?1",
            [page_id],
            |row| {
                let parent_kind = row.get::<_, String>(2)?;
                let parent_id = row.get::<_, String>(3)?;
                let parent = match parent_kind.as_str() {
                    "library" => json!({ "kind": "library", "libraryId": parent_id }),
                    "page" => json!({ "kind": "page", "pageId": parent_id }),
                    "data_source" => {
                        json!({ "kind": "data_source", "dataSourceId": parent_id })
                    }
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                let rich_title = parse_json(row.get::<_, String>(11)?, "Page rich title")?;
                Ok(json!({
                    "pageId": row.get::<_, String>(0)?,
                    "libraryId": row.get::<_, String>(1)?,
                    "parent": parent,
                    "lifecycle": row.get::<_, String>(4)?,
                    "parentRevision": row.get::<_, i64>(5)?,
                    "metadataRevision": row.get::<_, i64>(6)?,
                    "documentId": row.get::<_, String>(7)?,
                    "documentGeneration": row.get::<_, i64>(8)?,
                    "documentHeadSeq": row.get::<_, i64>(9)?,
                    "title": row.get::<_, String>(10)?,
                    "richTitle": rich_title,
                    "preview": row.get::<_, String>(12)?,
                    "plainText": row.get::<_, String>(13)?,
                    "createdAt": row.get::<_, String>(14)?,
                    "updatedAt": row.get::<_, String>(15)?,
                }))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Database membership has no exact-head Page projection"))
}

fn parse_json(value: String, label: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{label} is invalid JSON"),
            )
            .into(),
        )
    })
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
