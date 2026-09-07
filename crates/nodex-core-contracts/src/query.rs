//! Public, authorized SQL reads across content Modules.
use crate::agent::{AgentExecutionAuthorization, AgentTurnProvenance};
use crate::database::{DatabaseDisplayedViewSelection, DatabaseEffectiveViewCoordinate};
use crate::sql::{SqlQuery, SqlResult, SqlSchema, SqlScope};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const QUERY_CONTRACT_VERSION: u32 = 3;

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
    /// Agent SQL uses the calling Project's durable resource grants.
    AgentSchema {
        provenance: Box<AgentTurnProvenance>,
        scope: SqlScope,
        relation: Option<String>,
    },
    AgentQuery {
        provenance: Box<AgentTurnProvenance>,
        query: SqlQuery,
    },
    /// A fixed effective-View projection, independently authorized from public SQL bindings.
    AgentDisplayedViewQuery {
        authorization: Box<AgentExecutionAuthorization>,
        coordinate: Box<DatabaseEffectiveViewCoordinate>,
        projection_property_ids: Option<Vec<String>>,
        selection: DatabaseDisplayedViewSelection,
    },
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryReadValue {
    Schema {
        value: SqlSchema,
    },
    Query {
        value: SqlResult,
    },
    DisplayedViewQuery {
        value: DatabaseDisplayedViewQueryResult,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DatabaseDisplayedViewQueryCoverage {
    EffectiveComplete,
    EffectiveLimited { limit: u32 },
    Observed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
pub struct DatabaseDisplayedViewQueryResult {
    pub result: SqlResult,
    pub rules_fingerprint: String,
    pub view_revision: i64,
    pub schema_revision: i64,
    pub preferences_revision: Option<i64>,
    pub coverage: DatabaseDisplayedViewQueryCoverage,
    pub total_effective_occurrences: usize,
}
