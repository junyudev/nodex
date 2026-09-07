//! Read-only SQL over authorized public content relations.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use utoipa::ToSchema;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SqlScope {
    pub database_id: Option<String>,
    #[serde(default)]
    pub bindings: Vec<SqlBinding>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SqlBinding {
    pub table: String,
    pub data_source_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SqlQuery {
    pub scope: SqlScope,
    pub sql: String,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SqlColumn {
    pub nullable: bool,
    pub description: String,
    pub name: String,
    pub storage_type: String,
    pub property_id: Option<String>,
    pub property_schema: Option<crate::database::DatabasePropertySchema>,
    pub options: Vec<SqlOption>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SqlTable {
    pub table: String,
    pub data_source_id: Option<String>,
    pub name: String,
    pub description: String,
    pub row_identity: Vec<String>,
    pub arguments: Vec<String>,
    pub ordering: Option<String>,
    pub examples: Vec<String>,
    pub columns: Vec<SqlColumn>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SqlSchema {
    pub tables: Vec<SqlTable>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SqlResult {
    pub returned_count: usize,
    pub snapshot: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct SqlOption {
    pub id: String,
    pub name: String,
}
