//! Public, authorized SQL reads across content Modules.
use crate::sql::{SqlQuery, SqlResult, SqlSchema, SqlScope};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const QUERY_CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum QueryRead {
    Schema {
        scope: SqlScope,
        relation: Option<String>,
    },
    Query {
        query: SqlQuery,
    },
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryReadValue {
    Schema { value: SqlSchema },
    Query { value: SqlResult },
}
