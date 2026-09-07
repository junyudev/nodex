//! Database-owned projections for the public query Module. Every operation uses
//! the caller's existing read snapshot and the ordinary Database authorization.
use std::collections::BTreeMap;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::database::*;
use nodex_core_contracts::sql::SqlOption;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::infrastructure::request_execution::check_request_interruption;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_ROWS: usize = 100_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;

pub(crate) use super::window::effective_query::{
    EffectiveViewRequest, project as project_effective_view,
};

pub(crate) struct QueryContext<'a> {
    pub connection: &'a Connection,
    pub library_id: &'a str,
    pub commit_head: i64,
    pub context: &'a BoundModuleContext,
}

/// Schema facts needed by public SQL, without management policy or usage scans.
pub(crate) struct QueryProperty {
    pub property_id: String,
    pub name: String,
    pub schema: DatabasePropertySchema,
    pub revision: i64,
    pub option_count: usize,
    pub system_role: Option<DatabasePropertySystemRole>,
}

impl QueryContext<'_> {
    fn read(&self, read: DatabaseRead) -> Result<DatabaseReadValue, StoreError> {
        check_request_interruption()?;
        super::read::read_at_commit_head(
            self.connection,
            self.library_id,
            self.commit_head,
            self.context,
            read,
        )
    }

    pub(crate) fn source(&self, source: &str) -> Result<DatabaseDataSourceDescriptor, StoreError> {
        let DatabaseReadValue::DataSource { value } = self.read(DatabaseRead::DataSource {
            data_source_id: source.to_owned(),
        })?
        else {
            return Err(invalid("Data Source identity is unavailable"));
        };
        if value.data_source.lifecycle != "active" {
            return Err(not_found("Data Source is not active"));
        }
        Ok(value)
    }

    pub(crate) fn source_properties(&self, source: &str) -> Result<Vec<QueryProperty>, StoreError> {
        self.source(source)?;
        let mut statement = self.connection.prepare(
            "SELECT id,name,value_type,config_json,schema_revision FROM data_source_properties \
             WHERE data_source_id=?1 AND lifecycle='active' ORDER BY rank_key,id",
        )?;
        let mut cursor = statement.query([source])?;
        let mut properties = Vec::new();
        while let Some(row) = cursor.next()? {
            check_request_interruption()?;
            if properties.len() >= super::MAX_DATA_SOURCE_PROPERTIES {
                return Err(exhausted());
            }
            let property_id: String = row.get(0)?;
            let value_type: String = row.get(2)?;
            let config: String = row.get(3)?;
            let schema = super::property_semantics::schema_from_storage(
                self.connection,
                source,
                &property_id,
                &value_type,
            )?;
            if !super::property_semantics::is_canonical_property_id(&property_id)
                || !super::property_semantics::schema_matches_canonical_property(
                    &property_id,
                    source,
                    &schema,
                )
            {
                return Err(corrupt(
                    "Stored Property identity or schema is not canonical",
                ));
            }
            let option_count = super::property_semantics::option_count_from_storage(
                &property_id,
                &value_type,
                &config,
                &schema,
            )?;
            let system_role = match property_id.as_str() {
                super::property_semantics::STATUS_PROPERTY_ID => {
                    Some(DatabasePropertySystemRole::Status)
                }
                super::property_semantics::TASK_PARENT_PROPERTY_ID => {
                    Some(DatabasePropertySystemRole::TaskParent)
                }
                _ => None,
            };
            properties.push(QueryProperty {
                property_id,
                name: row.get(1)?,
                schema,
                revision: row.get(4)?,
                option_count,
                system_role,
            });
        }
        Ok(properties)
    }

    /// Option identity/configuration does not require counting selected Pages.
    fn options(
        &self,
        source: &str,
        property: &str,
    ) -> Result<Vec<super::property_semantics::PropertyOption>, StoreError> {
        self.source(source)?;
        let (value_type, config) = self.connection.query_row(
            "SELECT value_type,config_json FROM data_source_properties WHERE data_source_id=?1 AND id=?2 AND lifecycle='active'",
            params![source,property], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)),
        ).optional()?.ok_or_else(|| not_found("Property is not active"))?;
        if !matches!(value_type.as_str(), "select" | "multi_select") {
            return Ok(Vec::new());
        }
        Ok(
            super::property_semantics::option_config_from_storage(property, &value_type, &config)?
                .options,
        )
    }

    pub(crate) fn property_options(
        &self,
        source: &str,
        property: &str,
    ) -> Result<Vec<SqlOption>, StoreError> {
        Ok(self
            .options(source, property)?
            .into_iter()
            .map(|option| SqlOption {
                id: option.id,
                name: option.name,
            })
            .collect())
    }

    /// ID lookup joins only the selected membership. A full scan reads identity
    /// columns only; Property values and Documents remain lazy.
    pub(crate) fn source_ids(
        &self,
        source: &str,
        page: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        self.source(source)?;
        let base = "SELECT membership.page_block_id FROM data_source_page_memberships membership \
            JOIN blocks block ON block.id = membership.page_block_id AND block.library_id = ?1 \
            WHERE membership.data_source_id = ?2 AND membership.removed_at IS NULL AND block.lifecycle = 'active'";
        let sql = if page.is_some() {
            format!("{base} AND membership.page_block_id = ?3")
        } else {
            base.to_owned()
        };
        let mut statement = self.connection.prepare(&sql)?;
        let mut cursor = if let Some(page) = page {
            statement.query(params![self.library_id, source, page])?
        } else {
            statement.query(params![self.library_id, source])?
        };
        let mut result = Vec::new();
        let mut bytes = 0;
        while let Some(row) = cursor.next()? {
            check_request_interruption()?;
            let id = row.get::<_, String>(0)?;
            bytes += id.len();
            if result.len() >= MAX_ROWS || bytes > MAX_BYTES {
                return Err(exhausted());
            }
            result.push(id);
        }
        Ok(result)
    }

    fn membership(&self, source: &str, page: &str) -> Result<(String, i64), StoreError> {
        self.source(source)?;
        self.connection.query_row(
            "SELECT membership.id, membership.revision FROM data_source_page_memberships membership \
             JOIN blocks block ON block.id = membership.page_block_id AND block.library_id = ?1 \
             WHERE membership.data_source_id = ?2 AND membership.page_block_id = ?3 \
               AND membership.removed_at IS NULL AND block.lifecycle = 'active'",
            params![self.library_id, source, page], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?.ok_or_else(|| not_found("Page is not an active member of this Data Source"))
    }

    pub(crate) fn source_value(
        &self,
        source: &str,
        page: &str,
        property: &str,
    ) -> Result<Value, StoreError> {
        let (membership, _) = self.membership(source, page)?;
        let value_type = self.connection.query_row(
            "SELECT value_type FROM data_source_properties WHERE data_source_id = ?1 AND id = ?2 AND lifecycle = 'active'",
            params![source, property], |row| row.get::<_, String>(0),
        ).optional()?.ok_or_else(|| not_found("Property is not active"))?;
        if value_type == "relation" {
            return self.relation_value(source, page, property);
        }
        let value = self.connection.query_row(
            "SELECT value_json FROM data_source_property_values WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
            params![source, membership, property], |row| row.get::<_, String>(0),
        ).optional()?;
        value
            .map(|value| {
                serde_json::from_str(&value).map_err(|_| corrupt("Property value is invalid"))
            })
            .transpose()
            .map(|value| value.unwrap_or(Value::Null))
    }

    pub(crate) fn source_versions(&self, source: &str, page: &str) -> Result<Value, StoreError> {
        let (membership, revision) = self.membership(source, page)?;
        let revisions = self.connection.prepare(
            "SELECT property.id, COALESCE(value.revision, 0) FROM data_source_properties property \
             LEFT JOIN data_source_property_values value ON value.data_source_id = property.data_source_id \
               AND value.property_id = property.id AND value.membership_id = ?2 \
             WHERE property.data_source_id = ?1 AND property.lifecycle = 'active' ORDER BY property.id",
        )?.query_map(params![source, membership], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
        Ok(json!({ "membership_revision": revision, "value_revisions": revisions }))
    }

    fn relation_value(
        &self,
        source: &str,
        page: &str,
        property: &str,
    ) -> Result<Value, StoreError> {
        let mut targets = BudgetRows::default();
        let mut after = None;
        loop {
            let DatabaseReadValue::RelationTargetWindow { value } =
                self.read(DatabaseRead::RelationTargetWindow {
                    address: DatabasePagePropertyAddress {
                        data_source_id: source.to_owned(),
                        page_id: page.to_owned(),
                        property_id: property.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after,
                        first: Some(super::relation::MAX_RELATION_WINDOW as u32),
                    },
                })?
            else {
                return Err(invalid("Relation targets are unavailable"));
            };
            for target in value.targets.items {
                targets.push(match target {
                    DatabaseRelationTargetItem::Visible { page_id, .. } => Value::String(page_id),
                    DatabaseRelationTargetItem::Restricted { .. } => Value::Null,
                })?;
            }
            after = value.targets.next_cursor;
            if after.is_none() {
                return Ok(Value::Array(targets.rows));
            }
        }
    }

    pub(crate) fn view_rows(&self, view: &str) -> Result<Vec<Value>, StoreError> {
        let occurrences = super::read::query_view_occurrences(
            self.connection,
            self.library_id,
            self.commit_head,
            self.context,
            view,
        )?;
        let mut parents = BTreeMap::new();
        let mut output = BudgetRows::default();
        for occurrence in occurrences {
            let DatabaseListProjectionRow::Page {
                occurrence_key,
                summary,
                group_path,
                ancestor_page_ids,
                ..
            } = occurrence
            else {
                continue;
            };
            let parent = ancestor_page_ids
                .last()
                .and_then(|id| parents.get(&(group_path.clone(), id.clone())))
                .cloned();
            parents.insert(
                (group_path.clone(), summary.page_id.clone()),
                occurrence_key.clone(),
            );
            output.push(json!({
                "occurrence_id": occurrence_key, "page_id": summary.page_id, "title": summary.title,
                "group_key": group_path.first().cloned().flatten(), "subgroup_key": group_path.get(1).cloned().flatten(),
                "parent_occurrence_id": parent, "ordinal": output.rows.len(),
            }))?;
        }
        Ok(output.rows)
    }

    pub(crate) fn rows(
        &self,
        relation: &str,
        equalities: &BTreeMap<String, Value>,
    ) -> Result<Vec<Value>, StoreError> {
        let mut output = BudgetRows::default();
        if relation == "databases" {
            for database in self.databases(text(equalities, "database_id"))? {
                output.push(json!({ "database_id": database.database_id, "name": database.name,
                    "metadata_revision": database.metadata_revision, "access_revision": database.access_revision,
                    "default_view_id": database.default_view_id, "created_at": database.created_at, "updated_at": database.updated_at }))?;
            }
            return Ok(output.rows);
        }
        if relation == "views" {
            for view in self.views(text(equalities, "view_id"), text(equalities, "database_id"))? {
                output.push(json!({ "view_id": view.view_id, "database_id": view.database_id, "data_source_id": view.data_source_id,
                    "name": view.name, "layout": view.layout, "config_json": encode(&view.definition)?, "revision": view.revision,
                    "is_default": view.is_default, "created_at": view.created_at, "updated_at": view.updated_at }))?;
            }
            return Ok(output.rows);
        }
        let page_source = if text(equalities, "data_source_id").is_none() {
            text(equalities, "page_id").map(|page| self.connection.query_row(
                "SELECT data_source_id FROM data_source_page_memberships WHERE page_block_id = ?1 AND removed_at IS NULL",
                [page], |row| row.get::<_, String>(0),
            ).optional()).transpose()?.flatten()
        } else {
            None
        };
        if text(equalities, "page_id").is_some()
            && text(equalities, "data_source_id").is_none()
            && page_source.is_none()
        {
            return Ok(Vec::new());
        }
        let sources = self.sources(
            text(equalities, "data_source_id").or(page_source.as_deref()),
            text(equalities, "database_id"),
        )?;
        for source in sources {
            let id = &source.data_source_id;
            if relation == "data_sources" {
                output.push(json!({ "data_source_id": id, "database_id": source.home_database_id, "name": source.name,
                    "schema_revision": source.schema_revision, "created_at": source.created_at, "updated_at": source.updated_at }))?;
                continue;
            }
            let properties = self
                .source_properties(id)?
                .into_iter()
                .filter(|property| {
                    text(equalities, "property_id").is_none_or(|id| property.property_id == id)
                })
                .collect::<Vec<_>>();
            if relation == "property_values" {
                self.value_rows(id, text(equalities, "page_id"), &properties, &mut output)?;
                continue;
            }
            for property in &properties {
                self.property_rows(relation, equalities, id, property, &mut output)?;
            }
        }
        Ok(output.rows)
    }

    /// One revision observation per Page, shared by every projected Property.
    fn value_rows(
        &self,
        source: &str,
        page: Option<&str>,
        properties: &[QueryProperty],
        output: &mut BudgetRows,
    ) -> Result<(), StoreError> {
        if properties.is_empty() {
            return Ok(());
        }
        for page in self.source_ids(source, page)? {
            let revisions = self.source_versions(source, &page)?;
            for property in properties {
                let id = &property.property_id;
                let value = self.source_value(source, &page, id)?;
                output.push(json!({ "page_id": page, "data_source_id": source, "property_id": id,
                    "value_json": encode(&value)?, "value_revision": revisions["value_revisions"][id], "membership_revision": revisions["membership_revision"] }))?;
            }
        }
        Ok(())
    }

    fn property_rows(
        &self,
        relation: &str,
        equalities: &BTreeMap<String, Value>,
        source: &str,
        property: &QueryProperty,
        output: &mut BudgetRows,
    ) -> Result<(), StoreError> {
        let id = &property.property_id;
        if relation == "properties" {
            return output.push(json!({ "data_source_id": source, "property_id": id, "name": property.name,
                "schema_json": encode(&property.schema)?, "revision": property.revision, "option_count": property.option_count,
                "system_role": property.system_role }));
        }
        if relation == "property_options" {
            if !matches!(
                property.schema,
                DatabasePropertySchema::Select | DatabasePropertySchema::MultiSelect
            ) {
                return Ok(());
            }
            for option in self.options(source, id)? {
                output.push(json!({ "data_source_id": source, "property_id": id, "option_id": option.id, "name": option.name, "color": option.color }))?;
            }
            return Ok(());
        }
        if relation != "page_relations" {
            return Err(invalid("Unknown Database query relation"));
        }
        if !matches!(property.schema, DatabasePropertySchema::Relation { .. }) {
            return Ok(());
        }
        for page in self.source_ids(source, text(equalities, "page_id"))? {
            let value = self.source_value(source, &page, id)?;
            for target in value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                output.push(json!({ "page_id": page, "data_source_id": source, "property_id": id, "target_page_id": target }))?;
            }
        }
        Ok(())
    }

    fn databases(
        &self,
        selected: Option<&str>,
    ) -> Result<Vec<DatabaseContainerRecord>, StoreError> {
        let ids = self.identity_rows("SELECT block_id FROM database_containers WHERE library_id = ?1 AND lifecycle = 'active'", "block_id", selected)?;
        let mut rows = Vec::new();
        for id in ids {
            match self.read(DatabaseRead::Database {
                target: DatabaseIdentityTarget::Database { database_id: id },
            }) {
                Ok(DatabaseReadValue::Database { value }) => rows.push(value.database),
                Err(error) if invisible(&error) => {}
                Err(error) => return Err(error),
                _ => return Err(invalid("Database identity is unavailable")),
            }
        }
        Ok(rows)
    }

    fn sources(
        &self,
        selected: Option<&str>,
        database: Option<&str>,
    ) -> Result<Vec<DatabaseDataSourceRecord>, StoreError> {
        if let Some(selected) = selected {
            return match self.source(selected) {
                Ok(value)
                    if database
                        .is_none_or(|database| value.data_source.home_database_id == database) =>
                {
                    Ok(vec![value.data_source])
                }
                Ok(_) => Ok(Vec::new()),
                Err(error) if invisible(&error) => Ok(Vec::new()),
                Err(error) => Err(error),
            };
        }
        let mut output = Vec::new();
        for database in self.databases(database)? {
            let mut after = None;
            loop {
                let DatabaseReadValue::DataSourceWindow { data_sources } =
                    self.read(DatabaseRead::DataSourceWindow {
                        database_id: database.database_id.clone(),
                        window: CollectionWindowRequest {
                            after,
                            first: Some(200),
                        },
                    })?
                else {
                    return Err(invalid("Data Sources are unavailable"));
                };
                output.extend(
                    data_sources
                        .items
                        .into_iter()
                        .filter(|source| source.lifecycle == "active"),
                );
                if output.len() > MAX_ROWS {
                    return Err(exhausted());
                }
                after = data_sources.next_cursor;
                if after.is_none() {
                    break;
                }
            }
        }
        Ok(output)
    }

    fn views(
        &self,
        selected: Option<&str>,
        database: Option<&str>,
    ) -> Result<Vec<DatabaseViewRecord>, StoreError> {
        if let Some(view) = selected {
            return match self.read(DatabaseRead::View {
                view_id: view.to_owned(),
            }) {
                Ok(DatabaseReadValue::View { value })
                    if value.lifecycle == "active"
                        && database.is_none_or(|database| value.database_id == database) =>
                {
                    Ok(vec![value])
                }
                Ok(_) => Ok(Vec::new()),
                Err(error) if invisible(&error) => Ok(Vec::new()),
                Err(error) => Err(error),
            };
        }
        let mut output = Vec::new();
        for database in self.databases(database)? {
            let mut after = None;
            loop {
                let DatabaseReadValue::ViewDescriptorWindow { views } =
                    self.read(DatabaseRead::ViewDescriptorWindow {
                        database_id: database.database_id.clone(),
                        window: CollectionWindowRequest {
                            after,
                            first: Some(200),
                        },
                    })?
                else {
                    return Err(invalid("Views are unavailable"));
                };
                output.extend(
                    views
                        .items
                        .into_iter()
                        .filter(|view| view.lifecycle == "active"),
                );
                if output.len() > MAX_ROWS {
                    return Err(exhausted());
                }
                after = views.next_cursor;
                if after.is_none() {
                    break;
                }
            }
        }
        Ok(output)
    }

    fn identity_rows(
        &self,
        base: &str,
        key: &str,
        selected: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        let sql = if selected.is_some() {
            format!("{base} AND {key} = ?2")
        } else {
            base.to_owned()
        };
        let mut statement = self.connection.prepare(&sql)?;
        let mut cursor = if let Some(selected) = selected {
            statement.query(params![self.library_id, selected])?
        } else {
            statement.query([self.library_id])?
        };
        let mut output = Vec::new();
        while let Some(row) = cursor.next()? {
            check_request_interruption()?;
            if output.len() >= MAX_ROWS {
                return Err(exhausted());
            }
            output.push(row.get(0)?);
        }
        Ok(output)
    }
}

fn encode(value: &impl serde::Serialize) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| corrupt("Query JSON projection is invalid"))
}
fn text<'a>(equalities: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    equalities.get(key).and_then(Value::as_str)
}
fn invisible(error: &StoreError) -> bool {
    matches!(
        error.code,
        StoreErrorCode::Unauthorized | StoreErrorCode::NotFound
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}
fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
fn exhausted() -> StoreError {
    StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "SQL Database projection exceeds its row or byte budget; no partial result was returned",
        false,
    )
}

#[derive(Default)]
struct BudgetRows {
    rows: Vec<Value>,
    bytes: usize,
}
impl BudgetRows {
    fn push(&mut self, value: Value) -> Result<(), StoreError> {
        check_request_interruption()?;
        self.bytes += serde_json::to_vec(&value)
            .map_err(|_| corrupt("Query projection is invalid"))?
            .len();
        if self.rows.len() >= MAX_ROWS || self.bytes > MAX_BYTES {
            return Err(exhausted());
        }
        self.rows.push(value);
        Ok(())
    }
}
