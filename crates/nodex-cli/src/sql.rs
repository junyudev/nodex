//! CLI transport for Core-owned public read-only SQL.
use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, selected_project, unwrap_database};
use clap::{Args, Subcommand};
use nodex_core_contracts::database::{DatabaseRead, DatabaseReadValue};
use nodex_core_contracts::sql::{SqlBinding, SqlQuery, SqlScope};
use nodex_core_protocol::client::CoreClient;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct SqlArgs {
    #[command(subcommand)]
    pub command: SqlCommand,
}
#[derive(Clone, Debug, PartialEq, Args)]
pub struct SqlScopeArgs {
    /// Bind this Data Source as the pages table (otherwise requires one default source).
    #[arg(long, conflicts_with = "bind")]
    pub source: Option<String>,
    /// Bind a public Data Source as TABLE=SOURCE_ID; repeat for joins.
    #[arg(long, value_name = "TABLE=SOURCE_ID")]
    pub bind: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum SqlCommand {
    /// Discover public SQL columns and their stable Property identities.
    Schema {
        #[command(flatten)]
        scope: SqlScopeArgs,
    },
    /// Execute one read-only SQLite SELECT over complete authorized inputs.
    Query {
        #[arg(required_unless_present = "file", conflicts_with = "file")]
        sql: Option<String>,
        /// Read SQL from a UTF-8 file or redirected stdin (-).
        #[arg(long)]
        file: Option<PathBuf>,
        /// Bind a named SQL parameter with a JSON scalar: name=value.
        #[arg(long, value_name = "NAME=JSON")]
        param: Vec<String>,
        #[command(flatten)]
        scope: SqlScopeArgs,
        #[arg(skip)]
        prepared: Option<SqlQuery>,
    },
}

pub(crate) fn prepare(args: &mut SqlArgs) -> Result<(), CliError> {
    let SqlCommand::Query {
        sql,
        file,
        param,
        scope,
        prepared,
    } = &mut args.command
    else {
        return Ok(());
    };
    let sql = match file {
        Some(path) => String::from_utf8(crate::input::read_bytes(path, 64 * 1024, "SQL")?)
            .map_err(|_| invalid("SQL input must be UTF-8"))?,
        None => sql
            .clone()
            .ok_or_else(|| invalid("SQL requires a statement or --file"))?,
    };
    if sql.trim().is_empty() || sql.len() > 64 * 1024 {
        return Err(invalid("SQL requires a non-empty statement up to 64 KiB"));
    }
    let mut parameters = BTreeMap::new();
    for binding in param {
        let (name, encoded) = binding
            .split_once('=')
            .ok_or_else(|| invalid("SQL --param requires NAME=JSON"))?;
        let value: Value = serde_json::from_str(encoded)
            .map_err(|error| invalid(format!("Invalid SQL parameter '{name}': {error}")))?;
        if name.is_empty()
            || name.starts_with([':', '@', '$', '?'])
            || value.is_array()
            || value.is_object()
            || parameters.insert(name.to_owned(), value).is_some()
        {
            return Err(invalid(
                "SQL parameter names must be unique and unprefixed; values must be JSON scalars",
            ));
        }
    }
    *prepared = Some(SqlQuery {
        scope: resolve_scope(scope.clone(), None)?,
        sql,
        parameters,
    });
    Ok(())
}

pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    database: Option<&str>,
    cwd: &Path,
    args: SqlArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let read = match args.command {
        SqlCommand::Schema { scope } => DatabaseRead::SqlSchema {
            scope: resolve_scope(scope, database)?,
        },
        SqlCommand::Query { prepared, .. } => {
            let mut query = prepared.ok_or_else(|| invalid("SQL input was not prepared"))?;
            query.scope.database_id = database.map(crate::data_source::stable_id).transpose()?;
            DatabaseRead::SqlQuery { query }
        }
    };
    let snapshot = unwrap_database(client.database_read(Some(&project.id), read))?;
    let value = match snapshot.value {
        DatabaseReadValue::SqlSchema { value } => serde_json::to_value(value),
        DatabaseReadValue::SqlQuery { value } => serde_json::to_value(value),
        _ => {
            return Err(CliError::new(
                CliErrorCode::Internal,
                "Unexpected SQL result",
            ));
        }
    }
    .map_err(|error| CliError::new(CliErrorCode::Internal, error.to_string()))?;
    Ok(CommandOutput::Json(value))
}
fn resolve_scope(args: SqlScopeArgs, database: Option<&str>) -> Result<SqlScope, CliError> {
    let mut bindings = Vec::new();
    if let Some(source) = args.source {
        bindings.push(SqlBinding {
            table: "pages".to_owned(),
            data_source_id: crate::data_source::stable_id(&source)?,
        });
    }
    for binding in args.bind {
        let (table, source) = binding
            .split_once('=')
            .ok_or_else(|| invalid("SQL --bind requires TABLE=SOURCE_ID"))?;
        bindings.push(SqlBinding {
            table: table.to_owned(),
            data_source_id: crate::data_source::stable_id(source)?,
        });
    }
    Ok(SqlScope {
        database_id: database.map(crate::data_source::stable_id).transpose()?,
        bindings,
    })
}
fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepares_scalar_parameters_and_cross_source_bindings_without_rewriting_sql() {
        let sql = "SELECT p.page_id FROM projects p JOIN tasks t ON p.page_id=t.project WHERE t.title=:name";
        let mut args = SqlArgs {
            command: SqlCommand::Query {
                sql: Some(sql.to_owned()),
                file: None,
                param: vec!["name=\"a'b\"".to_owned()],
                scope: SqlScopeArgs {
                    source: None,
                    bind: vec!["projects=source-a".to_owned(), "tasks=source-b".to_owned()],
                },
                prepared: None,
            },
        };
        prepare(&mut args).unwrap();
        let SqlCommand::Query {
            prepared: Some(query),
            ..
        } = args.command
        else {
            panic!("prepared SQL");
        };
        assert_eq!(query.sql, sql);
        assert_eq!(query.parameters["name"], "a'b");
        assert_eq!(query.scope.bindings[1].data_source_id, "source-b");
    }
    #[test]
    fn rejects_duplicate_and_structured_parameters() {
        for param in [
            vec!["x=1", "x=2"],
            vec!["x=[]"],
            vec!["x={}"],
            vec!["x=bare"],
        ] {
            let mut args = SqlArgs {
                command: SqlCommand::Query {
                    sql: Some("SELECT :x".to_owned()),
                    file: None,
                    param: param.into_iter().map(str::to_owned).collect(),
                    scope: SqlScopeArgs {
                        source: None,
                        bind: vec![],
                    },
                    prepared: None,
                },
            };
            assert!(prepare(&mut args).is_err());
        }
    }
}
