//! Declarative Data Source configuration. Selectors are exact stable IDs or names.
use crate::database::{
    DatabasePropertySchema, DatabaseViewFilter, DatabaseViewLayout, DatabaseViewSortDirection,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DatabaseConfigurationScript {
    /// Revision observed before constructing this script. All statements share this fence.
    pub if_schema_revision: i64,
    pub operations: Vec<DatabaseConfigurationOperation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseConfigurationOperation {
    AddProperty {
        name: String,
        schema: DatabasePropertySchema,
        #[serde(default)]
        options: Vec<String>,
    },
    RenameProperty {
        property: String,
        name: String,
    },
    ChangePropertyType {
        property: String,
        schema: DatabasePropertySchema,
    },
    AddOption {
        property: String,
        name: String,
        color: Option<String>,
    },
    RenameOption {
        property: String,
        option: String,
        name: String,
    },
    CreateView {
        name: String,
        layout: DatabaseViewLayout,
        /// Complete saved filter. propertyId and select option values accept exact IDs or unique names.
        /// Uses the shared View expression grammar; omitted or null means no filter.
        filter: Option<DatabaseViewFilter>,
        group_by: Option<String>,
        #[serde(default)]
        sorts: Vec<ConfigurationSort>,
    },
    UpdateView {
        view: String,
        if_revision: i64,
        name: Option<String>,
        /// Replace all saved filters; omitted preserves them and null clears them.
        /// propertyId and select option values accept exact IDs or unique names.
        #[serde(
            default,
            deserialize_with = "crate::deserialize_present",
            skip_serializing_if = "Option::is_none"
        )]
        filter: Option<Option<DatabaseViewFilter>>,
        sorts: Option<Vec<ConfigurationSort>>,
        #[serde(
            default,
            deserialize_with = "crate::deserialize_present",
            skip_serializing_if = "Option::is_none"
        )]
        group_by: Option<Option<String>>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationSort {
    /// Property ID/name, or the intrinsic title, created, or manual sort.
    pub property: String,
    pub direction: DatabaseViewSortDirection,
}
