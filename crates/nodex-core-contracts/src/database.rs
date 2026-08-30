use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::agent::AgentExecutionAuthorization;
use crate::collection::{CollectionWindow, CollectionWindowRequest};
use crate::events::ProjectionSnapshotAuthority;
use crate::{ModuleMutationReceipt, ModuleName, VersionedModuleContract};

pub const DATABASE_CONTRACT_VERSION: u32 = 24;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseRelationCardinality {
    One,
    Many,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseCurrencyCode {
    #[default]
    Usd,
    Eur,
    Gbp,
    Jpy,
    Cny,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseNumberFormat {
    #[default]
    Plain,
    Percent,
    Currency {
        currency_code: DatabaseCurrencyCode,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseDateFormat {
    #[default]
    Full,
    MonthDayYear,
    DayMonthYear,
    YearMonthDay,
    Relative,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseTimeFormat {
    #[default]
    TwelveHour,
    TwentyFourHour,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabasePropertySchema {
    Text,
    Number {
        #[serde(default)]
        format: DatabaseNumberFormat,
    },
    Checkbox,
    Select,
    MultiSelect,
    Date {
        #[serde(default)]
        date_format: DatabaseDateFormat,
    },
    Datetime {
        #[serde(default)]
        date_format: DatabaseDateFormat,
        #[serde(default)]
        time_format: DatabaseTimeFormat,
    },
    Relation {
        target_data_source_id: String,
        cardinality: DatabaseRelationCardinality,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabasePropertyFilterOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    IsEmpty,
    IsNotEmpty,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePropertyCapabilities {
    pub filter_operators: Vec<DatabaseViewFilterOperator>,
    pub sortable: bool,
    pub groupable: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabasePropertySystemRole {
    Status,
    TaskParent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabasePropertyType {
    Text,
    Number,
    Checkbox,
    Select,
    MultiSelect,
    Date,
    Datetime,
    Relation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePropertyManagementPolicy {
    pub can_rename: bool,
    pub can_reorder: bool,
    pub can_change_type: bool,
    pub can_duplicate: bool,
    pub can_delete: bool,
    pub can_restore: bool,
    pub can_permanently_delete: bool,
    pub can_manage_options: bool,
    pub allowed_types: Vec<DatabasePropertyType>,
    pub blocked_reasons: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePropertyDescriptor {
    pub property_id: String,
    pub data_source_id: String,
    pub name: String,
    pub schema: DatabasePropertySchema,
    pub capabilities: DatabasePropertyCapabilities,
    pub system_role: Option<DatabasePropertySystemRole>,
    pub non_empty_value_count: i64,
    pub referenced_view_ids: Vec<String>,
    pub management_policy: DatabasePropertyManagementPolicy,
    pub option_count: u32,
    pub rank_key: String,
    pub lifecycle: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabasePagePropertyVisibility {
    AlwaysShow,
    HideWhenEmpty,
    AlwaysHide,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePageLayoutEntry {
    pub property_id: String,
    pub rank_key: String,
    pub visibility: DatabasePagePropertyVisibility,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePageLayout {
    pub data_source_id: String,
    pub revision: i64,
    pub entries: Vec<DatabasePageLayoutEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabasePageLayoutPlacement {
    Before { property_id: String },
    End,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDuplicatePropertyOption {
    pub source_option_id: String,
    pub new_option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseOptionPlacement {
    Before { option_id: String },
    End,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabasePropertyPlacement {
    Before { property_id: String },
    End,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewPlacement {
    Before { view_id: String },
    End,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewLayoutInput {
    Board,
    List,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseViewSortFieldInput {
    Manual,
    Title,
    Created,
    Property { property_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewSortDirectionInput {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewNullOrderInput {
    First,
    Last,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewSortInput {
    pub field: DatabaseViewSortFieldInput,
    pub direction: DatabaseViewSortDirectionInput,
    pub nulls: DatabaseViewNullOrderInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseViewGroupOverrideInput {
    None,
    Property { property_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewCompletedRangeInput {
    All,
    PastMonth,
    PastWeek,
    PastDay,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewCompletionOverrideInput {
    pub range: Option<DatabaseViewCompletedRangeInput>,
    pub order_by_recency: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewHierarchyOverrideInput {
    pub show_sub_pages: Option<bool>,
    pub nested_sub_pages: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseViewFieldInput {
    Property { property_id: String },
    Intrinsic { field: DatabaseViewIntrinsicField },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewLayoutDisplayOverrideInput {
    pub fields: Option<Vec<DatabaseViewFieldInput>>,
    pub property_order: Option<Vec<String>>,
    pub show_empty_groups: Option<bool>,
    pub show_description: Option<bool>,
}

/// A bounded Profile-local patch over a durable View definition. Shared manual
/// ranks remain View-global even when their presentation position is personal.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewPresentationOverrideInput {
    pub group: Option<DatabaseViewGroupOverrideInput>,
    pub subgroup: Option<DatabaseViewGroupOverrideInput>,
    pub group_direction: Option<DatabaseViewSortDirectionInput>,
    pub completion: Option<DatabaseViewCompletionOverrideInput>,
    pub hierarchy: Option<DatabaseViewHierarchyOverrideInput>,
    pub display: Option<DatabaseViewLayoutDisplayOverrideInput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewAdvancedFilterOverrideInput {
    None,
    Filter { filter: DatabaseViewFilter },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewRulesOverrideInput {
    pub property_filters: Option<Vec<DatabaseViewPropertyFilter>>,
    pub advanced_filter: Option<DatabaseViewAdvancedFilterOverrideInput>,
    pub sorts: Option<Vec<DatabaseViewSortInput>>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewPreferencesOverrideInput {
    pub rules_override: DatabaseViewRulesOverrideInput,
    pub presentation_override: DatabaseViewPresentationOverrideInput,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewLayout {
    Board,
    List,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewNullOrder {
    First,
    Last,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewFilterGroupOperator {
    And,
    Or,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewFilterOperator {
    /// Legacy v5 operators are accepted only while Store migration rewrites
    /// them to their Property-typed v6 equivalents.
    Equals,
    NotEquals,
    Contains,
    NotContains,
    TextIs,
    TextIsNot,
    TextContains,
    TextDoesNotContain,
    TextStartsWith,
    TextEndsWith,
    NumberEquals,
    NumberDoesNotEqual,
    NumberGreaterThan,
    NumberLessThan,
    NumberGreaterThanOrEqualTo,
    NumberLessThanOrEqualTo,
    CheckboxIs,
    CheckboxIsNot,
    SelectIs,
    SelectIsNot,
    MultiSelectContains,
    MultiSelectDoesNotContain,
    MultiSelectContainsAll,
    DateIs,
    DateIsNot,
    DateBefore,
    DateAfter,
    DateOnOrBefore,
    DateOnOrAfter,
    DateWithin,
    DateRelativeTo,
    RelationContains,
    RelationDoesNotContain,
    IsEmpty,
    IsNotEmpty,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewFilter {
    Group {
        operator: DatabaseViewFilterGroupOperator,
        #[schema(no_recursion)]
        children: Vec<DatabaseViewFilter>,
    },
    Clause {
        #[serde(rename = "propertyId")]
        property_id: String,
        operator: DatabaseViewFilterOperator,
        #[serde(
            default,
            deserialize_with = "crate::deserialize_present",
            skip_serializing_if = "Option::is_none"
        )]
        value: Option<Option<Value>>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewSortField {
    Manual,
    Title,
    Created,
    Property {
        #[serde(rename = "propertyId")]
        property_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DatabaseViewSort {
    pub field: DatabaseViewSortField,
    pub direction: DatabaseViewSortDirection,
    pub nulls: DatabaseViewNullOrder,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewPropertyFilter {
    pub filter_id: String,
    pub clause: DatabaseViewFilter,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewRules {
    #[serde(default)]
    pub property_filters: Vec<DatabaseViewPropertyFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_filter: Option<DatabaseViewFilter>,
    #[serde(default)]
    pub sorts: Vec<DatabaseViewSort>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewGroup {
    pub property_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewCompletedRange {
    All,
    PastMonth,
    PastWeek,
    PastDay,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewCompletion {
    pub range: DatabaseViewCompletedRange,
    pub order_by_recency: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewHierarchy {
    pub show_sub_pages: bool,
    pub nested_sub_pages: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewIntrinsicField {
    PageKey,
    CreatedAt,
    UpdatedAt,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewField {
    Property {
        #[serde(rename = "propertyId")]
        property_id: String,
    },
    Intrinsic {
        field: DatabaseViewIntrinsicField,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewLayoutDisplay {
    pub fields: Vec<DatabaseViewField>,
    #[serde(default)]
    pub property_order: Vec<String>,
    pub show_empty_groups: bool,
    #[serde(default = "default_show_description")]
    pub show_description: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewConditionalColor {
    Gray,
    Brown,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
    Red,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseViewConditionalColorSource {
    #[default]
    Fixed,
    PropertyOption,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewConditionalColorRule {
    pub rule_id: String,
    pub property_id: String,
    pub operator: DatabaseViewFilterOperator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default)]
    pub color_source: DatabaseViewConditionalColorSource,
    pub color: DatabaseViewConditionalColor,
}

fn default_show_description() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseViewPresentation {
    pub group: Option<DatabaseViewGroup>,
    pub subgroup: Option<DatabaseViewGroup>,
    pub group_direction: DatabaseViewSortDirection,
    pub completion: DatabaseViewCompletion,
    pub hierarchy: DatabaseViewHierarchy,
    pub display: DatabaseViewLayoutDisplay,
    #[serde(default)]
    pub conditional_colors: Vec<DatabaseViewConditionalColorRule>,
}

/// Durable View policy. Storage schema markers are an adapter concern and are
/// intentionally absent from the domain contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DatabaseViewDefinition {
    pub rules: DatabaseViewRules,
    pub presentation: DatabaseViewPresentation,
}

/// Restricts a `ViewWindow` read to one stable primary/secondary group path.
/// A null key addresses the unassigned value at that level.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseGroupScope {
    Path {
        group_key: Option<String>,
        subgroup_key: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseAgentViewQuery {
    pub authorization: AgentExecutionAuthorization,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub projection_property_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DatabaseAgentDataSourceQuery {
    pub authorization: AgentExecutionAuthorization,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub projection_property_ids: Option<Vec<String>>,
    pub filter: DatabaseViewFilter,
    pub sort: Vec<DatabaseViewSort>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseIdentityTarget {
    ProjectDefault,
    Database { database_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewReadTarget {
    ProjectDefault,
    Database {
        database_id: String,
    },
    View {
        view_id: String,
    },
    PresentedView {
        view_id: String,
        preferences_override: DatabaseViewPreferencesOverrideInput,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseRowsTarget {
    ProjectDefault,
    View { view_id: String },
}

/// One discriminated Database read command. Each variant carries only the
/// coordinates accepted by that read, so target/mode/optional-field
/// cross-products cannot cross the module boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseRead {
    CatalogWindow {
        window: CollectionWindowRequest,
    },
    Database {
        target: DatabaseIdentityTarget,
    },
    PageKeyPrefixPreview {
        database_id: Option<String>,
        name_hint: String,
        requested_prefix: Option<String>,
    },
    PageKeyNamespace {
        database_id: String,
    },
    DataSourceWindow {
        database_id: String,
        window: CollectionWindowRequest,
    },
    DataSource {
        data_source_id: String,
    },
    PropertyWindow {
        data_source_id: String,
        window: CollectionWindowRequest,
    },
    OptionWindow {
        data_source_id: String,
        property_id: String,
        window: CollectionWindowRequest,
    },
    PageLayout {
        data_source_id: String,
    },
    ViewDescriptorWindow {
        database_id: String,
        window: CollectionWindowRequest,
    },
    View {
        view_id: String,
    },
    AgentDataSourceQuery {
        data_source_id: String,
        query: DatabaseAgentDataSourceQuery,
    },
    AgentViewQuery {
        view_id: String,
        query: DatabaseAgentViewQuery,
    },
    ViewWindow {
        target: DatabaseViewReadTarget,
        window: CollectionWindowRequest,
        group_scope: Option<DatabaseGroupScope>,
    },
    ListWindow {
        target: DatabaseViewReadTarget,
        window: CollectionWindowRequest,
    },
    ViewGroups {
        target: DatabaseViewReadTarget,
    },
    ViewContext {
        view_id: String,
        window: CollectionWindowRequest,
        group_scope: Option<DatabaseGroupScope>,
    },
    RowsById {
        target: DatabaseRowsTarget,
        page_ids: Vec<String>,
    },
    RowDetail {
        page_id: String,
    },
    RelationTargetWindow {
        address: DatabasePagePropertyAddress,
        window: CollectionWindowRequest,
    },
    RelationCandidateWindow {
        data_source_id: String,
        query: Option<String>,
        window: CollectionWindowRequest,
    },
    ViewPersonalPreferences {
        view_id: String,
    },
    ViewCollapsedOccurrences {
        view_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseContainerRecord {
    pub database_id: String,
    pub library_id: String,
    pub name: String,
    pub lifecycle: String,
    pub default_view_id: Option<String>,
    pub access_revision: i64,
    pub metadata_revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDescriptor {
    pub database: DatabaseContainerRecord,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabasePageKeyPrefixAvailability {
    Available,
    Current,
    Reserved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePageKeyPrefixPreview {
    pub prefix: String,
    pub availability: DatabasePageKeyPrefixAvailability,
    pub alternative_prefix: Option<String>,
    pub next_number: i64,
    pub example_keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRetiredPageKeyPrefix {
    pub prefix: String,
    pub last_number: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePageKeyNamespace {
    pub database_id: String,
    pub current_prefix: String,
    pub next_number: i64,
    pub assigned_page_count: i64,
    pub revision: i64,
    pub retired_prefixes: Vec<DatabaseRetiredPageKeyPrefix>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDataSourceRecord {
    pub data_source_id: String,
    pub library_id: String,
    pub home_database_id: String,
    pub name: String,
    pub schema_key: String,
    pub schema_revision: i64,
    pub lifecycle: String,
    pub rank_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDataSourceDescriptor {
    pub data_source: DatabaseDataSourceRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewRecord {
    pub view_id: String,
    pub database_id: String,
    pub data_source_id: String,
    pub name: String,
    pub layout: DatabaseViewLayout,
    pub definition: DatabaseViewDefinition,
    pub is_default: bool,
    pub revision: i64,
    pub rank_key: String,
    pub lifecycle: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePropertyOption {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub selected_page_count: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseReadValue {
    CatalogWindow {
        databases: CollectionWindow<DatabaseDescriptor>,
    },
    Database {
        value: DatabaseDescriptor,
    },
    PageKeyPrefixPreview {
        value: DatabasePageKeyPrefixPreview,
    },
    PageKeyNamespace {
        value: DatabasePageKeyNamespace,
    },
    DataSourceWindow {
        data_sources: CollectionWindow<DatabaseDataSourceRecord>,
    },
    DataSource {
        value: DatabaseDataSourceDescriptor,
    },
    PropertyWindow {
        properties: CollectionWindow<DatabasePropertyDescriptor>,
    },
    OptionWindow {
        options: CollectionWindow<DatabasePropertyOption>,
    },
    PageLayout {
        value: DatabasePageLayout,
    },
    ViewDescriptorWindow {
        views: CollectionWindow<DatabaseViewRecord>,
    },
    View {
        value: DatabaseViewRecord,
    },
    AgentDataSourceQuery {
        value: DatabaseDataSourceQueryWindow,
    },
    AgentViewQuery {
        value: DatabaseViewWindow,
    },
    ViewWindow {
        value: DatabaseViewWindow,
    },
    ListWindow {
        value: DatabaseListWindow,
    },
    ViewGroups {
        value: DatabaseViewGroups,
    },
    ViewContext {
        value: Box<DatabaseViewContext>,
    },
    RowsById {
        value: DatabaseRowsById,
    },
    RowDetail {
        value: Box<DatabaseRowDetail>,
    },
    RelationTargetWindow {
        value: DatabaseRelationTargetWindow,
    },
    RelationCandidateWindow {
        candidates: CollectionWindow<DatabaseRelationCandidate>,
    },
    ViewPersonalPreferences {
        value: DatabaseViewPersonalPreferences,
    },
    ViewCollapsedOccurrences {
        value: DatabaseViewCollapsedOccurrences,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewPersonalPreferences {
    pub rules_override: DatabaseViewRulesOverrideInput,
    pub presentation_override: DatabaseViewPresentationOverrideInput,
    /// Zero means that this Profile has never changed this View.
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabaseViewDisclosureTarget {
    Group { occurrence_key: String },
    Page { occurrence_key: String },
}

impl DatabaseViewDisclosureTarget {
    pub fn occurrence_key(&self) -> &str {
        match self {
            Self::Group { occurrence_key } | Self::Page { occurrence_key } => occurrence_key,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewCollapsedOccurrences {
    pub targets: Vec<DatabaseViewDisclosureTarget>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatabasePersonalViewChange {
    Preferences {
        view_id: String,
        value: DatabaseViewPersonalPreferences,
    },
    OccurrenceDisclosure {
        view_id: String,
        target: DatabaseViewDisclosureTarget,
        collapsed: bool,
    },
}

impl DatabasePersonalViewChange {
    pub fn view_id(&self) -> &str {
        match self {
            Self::Preferences { view_id, .. } | Self::OccurrenceDisclosure { view_id, .. } => {
                view_id
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRelationCandidate {
    pub page_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseRelationTargetItem {
    Visible {
        edge_id: String,
        page_id: String,
        title: String,
        lifecycle: String,
        membership_state: String,
    },
    Restricted {
        edge_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRelationTargetWindow {
    pub value_revision: i64,
    pub total_count: i64,
    pub targets: CollectionWindow<DatabaseRelationTargetItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRelationValuePreview {
    pub value_revision: i64,
    pub total_count: i64,
    pub targets: Vec<DatabaseRelationTargetItem>,
    pub restricted_count: i64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewWindow {
    pub database_id: String,
    pub data_source_id: String,
    pub view_id: String,
    pub projection: ProjectionSnapshotAuthority,
    pub rows: CollectionWindow<DatabaseRowSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDataSourceQueryWindow {
    pub database_id: String,
    pub data_source_id: String,
    pub projection: ProjectionSnapshotAuthority,
    pub rows: CollectionWindow<DatabaseRowSummary>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseListTransientKind {
    None,
    Ancestor,
    Child,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseListProjectionRow {
    Group {
        occurrence_key: String,
        group_key: Option<String>,
        total_occurrence_count: i64,
    },
    Subgroup {
        occurrence_key: String,
        group_key: Option<String>,
        subgroup_key: Option<String>,
        total_occurrence_count: i64,
    },
    Page {
        occurrence_key: String,
        summary: Box<DatabaseRowSummary>,
        group_path: Vec<Option<String>>,
        ancestor_page_ids: Vec<String>,
        depth: u32,
        has_children: bool,
        /// Number of Page occurrences in this visible occurrence subtree,
        /// including transient context rows and this row.
        subtree_occurrence_count: u32,
        /// Number of concrete Page occurrences in this subtree. Transient
        /// rows are skipped, but their descendants remain part of the count.
        concrete_subtree_page_count: u32,
        /// Maximum number of Parent edges below this occurrence.
        subtree_height: u32,
        /// Stable occurrence identity of the first direct child when one is
        /// present. This lets a bounded renderer preview the normalized
        /// "after parent" slot without materializing the whole subtree.
        first_child_occurrence_key: Option<String>,
        transient_kind: DatabaseListTransientKind,
    },
}

impl DatabaseListProjectionRow {
    pub fn occurrence_key(&self) -> &str {
        match self {
            Self::Group { occurrence_key, .. }
            | Self::Subgroup { occurrence_key, .. }
            | Self::Page { occurrence_key, .. } => occurrence_key,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListGroupSummary {
    pub group_key: Option<String>,
    pub subgroup_key: Option<String>,
    pub total_occurrence_count: i64,
}

/// A continuous window over the fully expanded List occurrence projection.
/// Model totals intentionally differ from occurrence totals when multi-value
/// grouping or transient hierarchy context repeats a Page.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListWindow {
    pub database_id: String,
    pub data_source_id: String,
    pub view_id: String,
    pub projection: ProjectionSnapshotAuthority,
    pub rows: CollectionWindow<DatabaseListProjectionRow>,
    pub groups: Vec<DatabaseListGroupSummary>,
    pub total_projection_row_count: i64,
    pub total_occurrence_count: i64,
    pub total_model_count: i64,
    pub window_start: i64,
    pub window_end: i64,
    pub is_complete: bool,
}

/// Bounded per-group totals for a View, observed from data. At most
/// `MAX_VIEW_GROUP_SUMMARIES` groups are returned; `truncated` reports when the
/// grouping cardinality exceeded that bound. `grouped: false` means the View
/// has no grouping Property and only `total_rows` is meaningful.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewGroups {
    pub database_id: String,
    pub data_source_id: String,
    pub view_id: String,
    pub projection: ProjectionSnapshotAuthority,
    pub grouped: bool,
    pub subgrouped: bool,
    pub total_rows: i64,
    pub total_groups: i64,
    pub group_limit: usize,
    pub truncated: bool,
    pub groups: Vec<DatabaseViewGroupSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewGroupSummary {
    /// `None` counts the unassigned value at that path level.
    pub group_key: Option<String>,
    pub subgroup_key: Option<String>,
    pub total_rows: i64,
}

pub const MAX_VIEW_GROUP_SUMMARIES: usize = 200;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewContext {
    pub database: DatabaseContainerRecord,
    pub data_source: DatabaseDataSourceRecord,
    pub view: DatabaseViewRecord,
    pub properties: Vec<DatabasePropertyDescriptor>,
    pub groups: DatabaseViewGroups,
    pub projection: ProjectionSnapshotAuthority,
    pub rows: CollectionWindow<DatabaseViewContextRow>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseViewContextRow {
    pub summary: DatabaseRowSummary,
    pub move_etag: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRowsById {
    pub rows: Vec<DatabaseRowSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRowDetail {
    pub summary: DatabaseRowSummary,
    pub body_nfm: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseRowSummary {
    pub page_id: String,
    pub page_key: Option<String>,
    pub lifecycle: String,
    pub title: String,
    pub rich_title: Value,
    pub description_preview: String,
    pub description_length: i64,
    pub has_description: bool,
    /// Canonical Property values. Select-like values are stable option IDs.
    pub database_values: BTreeMap<String, Value>,
    pub intrinsic_properties: BTreeMap<String, Value>,
    pub database_value_revisions: BTreeMap<String, i64>,
    pub metadata_revision: i64,
    pub parent_revision: i64,
    pub document_id: String,
    pub document_generation: i64,
    pub document_head_seq: i64,
    pub membership_id: String,
    pub membership_revision: i64,
    pub membership_created_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub effective_group_key: Option<String>,
    pub effective_subgroup_key: Option<String>,
    pub rank_key: Option<String>,
    pub position_revision: Option<i64>,
    pub position_order: Option<i64>,
    pub task_parent_page_id: Option<String>,
    pub task_sibling_rank: Option<String>,
    /// Revision of the standard `task_parent` Relation value. This remains
    /// populated for root tasks, which have no Relation edge.
    pub task_parent_value_revision: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseIntent {
    RenamePageKeyPrefix {
        database_id: String,
        expected_revision: i64,
        prefix: String,
    },
    PutProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
        name: String,
        schema: DatabasePropertySchema,
        before_property_id: Option<String>,
    },
    MoveProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
        placement: DatabasePropertyPlacement,
    },
    ChangePropertyType {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
        schema: DatabasePropertySchema,
    },
    DuplicateProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
        new_property_id: String,
        name: String,
        option_ids: Vec<DatabaseDuplicatePropertyOption>,
    },
    RestoreProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
    },
    PermanentlyDeleteProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
    },
    DeleteProperty {
        data_source_id: String,
        property_id: String,
        expected_data_source_revision: i64,
        expected_property_revision: i64,
    },
    PutOption {
        data_source_id: String,
        property_id: String,
        option_id: String,
        name: String,
        color: Option<String>,
        expected_property_revision: i64,
    },
    MoveOption {
        data_source_id: String,
        property_id: String,
        option_id: String,
        expected_property_revision: i64,
        placement: DatabaseOptionPlacement,
    },
    DeleteOption {
        data_source_id: String,
        property_id: String,
        option_id: String,
        expected_property_revision: i64,
    },
    DeleteOptionAndClearValues {
        data_source_id: String,
        property_id: String,
        option_id: String,
        expected_property_revision: i64,
    },
    PutPageLayoutEntry {
        data_source_id: String,
        expected_revision: i64,
        property_id: String,
        visibility: DatabasePagePropertyVisibility,
        placement: Option<DatabasePageLayoutPlacement>,
    },
    EditPropertyValues {
        edits: Vec<DatabasePropertyValueMutation>,
    },
    TransferPage {
        page_id: String,
        expected_parent_revision: i64,
        expected_active_membership_revision: i64,
        target: DatabaseTransferTarget,
    },
    PutView {
        database_id: String,
        data_source_id: String,
        view_id: String,
        expected_revision: i64,
        name: String,
        layout: DatabaseViewLayout,
        definition: DatabaseViewDefinition,
        is_default: bool,
        before_view_id: Option<String>,
    },
    DuplicateView {
        database_id: String,
        source_view_id: String,
        expected_revision: i64,
        new_view_id: String,
    },
    ChangeViewLayout {
        database_id: String,
        view_id: String,
        expected_revision: i64,
        layout: DatabaseViewLayout,
    },
    MoveView {
        database_id: String,
        view_id: String,
        expected_revision: i64,
        placement: DatabaseViewPlacement,
    },
    DeleteView {
        database_id: String,
        view_id: String,
        expected_revision: i64,
    },
    PositionPage {
        view_id: String,
        page_id: String,
        expected_position_revision: i64,
        before_page_id: Option<String>,
    },
    PositionPages {
        view_id: String,
        pages: Vec<DatabasePagePosition>,
        before_page_id: Option<String>,
    },
    SetTaskParent {
        data_source_id: String,
        pages: Vec<DatabaseTaskParentPage>,
        parent_page_id: Option<String>,
        before_page_id: Option<String>,
    },
    MoveListOccurrences {
        view_id: String,
        preferences_override: DatabaseViewPreferencesOverrideInput,
        expected_projection: DatabaseListProjectionExpectation,
        initiator_occurrence_key: String,
        selection: DatabaseListMoveSelection,
        target: DatabaseListMoveTarget,
    },
    UndoListOccurrenceMove {
        recipe: DatabaseListMoveUndoRecipe,
    },
    PutViewPersonalPreferences {
        view_id: String,
        expected_revision: i64,
        rules_override: DatabaseViewRulesOverrideInput,
        presentation_override: DatabaseViewPresentationOverrideInput,
    },
    SetViewOccurrenceDisclosure {
        view_id: String,
        target: DatabaseViewDisclosureTarget,
        collapsed: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePagePropertyAddress {
    pub page_id: String,
    pub data_source_id: String,
    pub property_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabasePropertyValueInput {
    Empty,
    Text { value: String },
    Number { value: f64 },
    Checkbox { value: bool },
    Select { option_id: String },
    MultiSelect { option_ids: Vec<String> },
    Date { value: String },
    Datetime { value: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabasePropertySetDelta {
    MultiSelect {
        add_option_ids: Vec<String>,
        remove_option_ids: Vec<String>,
    },
    Relation {
        add_page_ids: Vec<String>,
        remove_edge_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabasePropertyValueEdit {
    Replace {
        expected_value_revision: i64,
        value: DatabasePropertyValueInput,
    },
    PatchSet {
        delta: DatabasePropertySetDelta,
    },
    ReplaceOneRelation {
        expected_value_revision: i64,
        target_page_id: Option<String>,
    },
    ClearManyRelation {
        expected_value_revision: i64,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DatabasePropertyValueMutation {
    pub address: DatabasePagePropertyAddress,
    pub edit: DatabasePropertyValueEdit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabasePagePosition {
    pub page_id: String,
    pub expected_position_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseTaskParentPage {
    pub page_id: String,
    /// Root tasks retain an empty `task_parent` Relation value header, so this
    /// revision remains positive and monotonic.
    pub expected_value_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseTransferTarget {
    Library { library_id: String },
    Page { page_id: String },
    DataSource { data_source_id: String },
}

/// Selection semantics for one Database List drag. Occurrence identities are
/// resolved against the exact effective List projection inside Core; callers
/// never materialize descendant Page IDs themselves.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseListMoveSelection {
    Explicit {
        occurrence_keys: Vec<String>,
    },
    AllMatching {
        excluded_occurrence_keys: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseListMoveEdge {
    Before,
    After,
    Inside,
}

/// A raw pointer target. Page target normalization (including
/// `after(parent) -> before(first child)`) remains a Core responsibility.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseListMoveTarget {
    Page {
        occurrence_key: String,
        edge: DatabaseListMoveEdge,
    },
    Group {
        occurrence_key: String,
    },
    Root,
}

/// Renderer-visible causal coordinate. The canonical scope body is omitted
/// because callers only need to prove that the scope identity and revision
/// they rendered are still current.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListProjectionExpectation {
    pub scope_key: String,
    pub schema_version: u32,
    pub revision: i64,
    pub covered_commit_seq: i64,
    pub effect_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListMoveNormalizedTarget {
    pub target_occurrence_key: Option<String>,
    pub target_page_id: Option<String>,
    pub parent_page_id: Option<String>,
    pub before_page_id: Option<String>,
    pub group_key: Option<String>,
    pub subgroup_key: Option<String>,
    pub depth: u32,
    pub edge: DatabaseListMoveEdge,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListMovePropertyState {
    pub page_id: String,
    pub property_id: String,
    pub before_value: DatabasePropertyValueInput,
    pub after_value: DatabasePropertyValueInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListMoveParentGuard {
    pub page_id: String,
    pub parent_page_id: Option<String>,
}

/// One contiguous source run restored by semantic Undo. A null parent means
/// the Page run belonged at List root; `before_page_id` is always outside the
/// moved closure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListMoveRestoreRun {
    pub page_ids: Vec<String>,
    pub parent_page_id: Option<String>,
    pub before_page_id: Option<String>,
}

/// Opaque-to-UI inverse recipe. Core validates the move's logical post-image
/// before restoring these runs, so session Undo cannot overwrite a later edit.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DatabaseListMoveUndoRecipe {
    pub view_id: String,
    pub data_source_id: String,
    pub property_states: Vec<DatabaseListMovePropertyState>,
    pub post_parent_guards: Vec<DatabaseListMoveParentGuard>,
    pub post_before_page_id: Option<String>,
    pub post_order_guard: bool,
    pub restore_runs: Vec<DatabaseListMoveRestoreRun>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseOperationOutcome {
    ListOccurrenceMove {
        operation_index: u32,
        moved_page_ids: Vec<String>,
        move_root_page_ids: Vec<String>,
        normalized_target: DatabaseListMoveNormalizedTarget,
        undo_recipe: Box<DatabaseListMoveUndoRecipe>,
    },
    ListOccurrenceMoveUndo {
        operation_index: u32,
        restored_page_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct DatabaseReceipt {
    #[serde(flatten)]
    pub mutation: ModuleMutationReceipt,
    pub affected_database_ids: Vec<String>,
    pub affected_data_source_ids: Vec<String>,
    pub affected_page_ids: Vec<String>,
    pub affected_view_ids: Vec<String>,
    pub operation_kinds: Vec<String>,
    #[serde(default)]
    pub operation_outcomes: Vec<DatabaseOperationOutcome>,
    pub committed_revisions: BTreeMap<String, i64>,
    pub commit_seq: i64,
    pub committed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseCommitValue {
    pub operation_count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseEvent {
    pub kind: DatabaseEventKind,
    pub project_id: Option<String>,
    pub database_ids: Vec<String>,
    pub data_source_ids: Vec<String>,
    pub page_ids: Vec<String>,
    pub view_ids: Vec<String>,
    /// Profile-owned deltas are routed through View authorization but do not
    /// invalidate shared Database/View projections.
    #[serde(default)]
    pub personal_view_changes: Vec<DatabasePersonalViewChange>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseEventKind {
    DatabaseChanged,
}

pub struct DatabaseContract;

impl VersionedModuleContract for DatabaseContract {
    type Read = DatabaseRead;
    type Snapshot = DatabaseReadValue;
    type Intent = Vec<DatabaseIntent>;
    type Receipt = DatabaseReceipt;
    type Event = DatabaseEvent;

    const VERSION: u32 = DATABASE_CONTRACT_VERSION;
    const MODULE: ModuleName = ModuleName::Database;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DatabaseViewFilter, DatabaseViewFilterOperator};

    #[test]
    fn filter_clause_round_trip_preserves_missing_null_and_concrete_values() {
        let cases = [
            (
                json!({
                    "kind": "clause",
                    "propertyId": "status",
                    "operator": "is_empty"
                }),
                None,
            ),
            (
                json!({
                    "kind": "clause",
                    "propertyId": "status",
                    "operator": "select_is",
                    "value": null
                }),
                Some(None),
            ),
            (
                json!({
                    "kind": "clause",
                    "propertyId": "status",
                    "operator": "select_is",
                    "value": "triage"
                }),
                Some(Some(json!("triage"))),
            ),
        ];

        for (encoded, expected_value) in cases {
            let decoded = serde_json::from_value::<DatabaseViewFilter>(encoded.clone())
                .expect("decode filter clause");
            let DatabaseViewFilter::Clause {
                operator, value, ..
            } = &decoded
            else {
                panic!("filter clause");
            };
            assert!(matches!(
                operator,
                DatabaseViewFilterOperator::IsEmpty | DatabaseViewFilterOperator::SelectIs
            ));
            assert_eq!(value, &expected_value);
            assert_eq!(
                serde_json::to_value(decoded).expect("encode filter clause"),
                encoded
            );
        }
    }
}
