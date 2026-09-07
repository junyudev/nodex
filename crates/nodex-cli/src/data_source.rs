use std::path::Path;

use clap::{Args, Subcommand};
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::database::{DatabaseRead, DatabaseReadValue};
use nodex_core_protocol::client::CoreClient;

use crate::error::{CliError, CliErrorCode};
use crate::runtime::{CommandOutput, selected_project, unwrap_database};

#[derive(Clone, Debug, PartialEq, Args)]
pub struct WindowArgs {
    /// Opaque continuation cursor from the preceding collection result.
    #[arg(long)]
    pub after: Option<String>,
    /// Maximum entries in this collection window.
    #[arg(long)]
    pub limit: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Args)]
pub struct DataSourceArgs {
    #[command(subcommand)]
    pub command: DataSourceCommand,
}
#[derive(Clone, Debug, PartialEq, Subcommand)]
pub enum DataSourceCommand {
    /// Add or change Property definitions and saved Views in one atomic script.
    Configure(crate::config_script::ConfigureArgs),
}
pub(crate) fn prepare(args: &mut DataSourceArgs) -> Result<(), CliError> {
    let DataSourceCommand::Configure(arguments) = &mut args.command;
    crate::config_script::prepare(arguments)
}
pub(crate) fn execute(
    client: &CoreClient,
    explicit_project: Option<&str>,
    database: Option<&str>,
    cwd: &Path,
    args: DataSourceArgs,
) -> Result<CommandOutput, CliError> {
    let project = selected_database_project(client, explicit_project, database, cwd)?;
    let DataSourceCommand::Configure(arguments) = args.command;
    let source_id = resolve_optional_source(client, &project, arguments.data_source.as_deref())?;
    crate::config_script::execute(client, &project.id, source_id, arguments)
}

pub(crate) fn stable_id(value: &str) -> Result<String, CliError> {
    let value = value.strip_prefix('@').unwrap_or(value);
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "Expected one bounded stable resource identity",
        ));
    }
    Ok(value.to_owned())
}
fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

pub(crate) fn select_identity(
    selector: &str,
    kind: &str,
    candidates: Vec<(String, String)>,
) -> Result<String, CliError> {
    let selector_id = stable_id(selector)?;
    if let Some((id, _)) = candidates.iter().find(|(id, _)| id == &selector_id) {
        return Ok(id.clone());
    }
    if selector.starts_with('@') {
        return Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            format!("no authorized {kind} has identity '{selector_id}'"),
        ));
    }
    let mut matches: Vec<_> = candidates
        .into_iter()
        .filter(|(_, name)| name == selector)
        .map(|(id, _)| id)
        .collect();
    matches.sort();
    matches.dedup();
    match matches.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(CliError::new(
            CliErrorCode::ScopeNotFound,
            format!(
                "no authorized {kind} matches '{selector}'; list available resources and use their ID"
            ),
        )),
        _ => Err(CliError::new(
            CliErrorCode::ScopeAmbiguous,
            format!(
                "{kind} name '{selector}' is ambiguous; use an ID: {}{}",
                matches
                    .iter()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
                if matches.len() > 8 { ", …" } else { "" }
            ),
        ).with_details(serde_json::json!({"argument": kind, "candidates": matches.iter().take(8).map(|id| serde_json::json!({"id": id, "name": selector})).collect::<Vec<_>>(), "hint": "Use a candidate ID"}))),
    }
}

pub(crate) fn database_candidates(
    client: &CoreClient,
    project: &nodex_core_contracts::workspace::ProjectWorkspaceProject,
) -> Result<Vec<(String, String)>, CliError> {
    let mut after = None;
    let mut candidates = Vec::new();
    loop {
        let snapshot = unwrap_database(client.database_read(
            Some(&project.id),
            DatabaseRead::CatalogWindow {
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            },
        ))?;
        let DatabaseReadValue::CatalogWindow { databases } = snapshot.value else {
            return Err(internal("unexpected Database catalog"));
        };
        candidates.extend(
            databases
                .items
                .into_iter()
                .map(|item| (item.database.database_id, item.database.name)),
        );
        enforce_selector_budget(candidates.len())?;
        after = databases.next_cursor;
        if after.is_none() {
            return Ok(candidates);
        }
    }
}

pub(crate) fn enforce_selector_budget(count: usize) -> Result<(), CliError> {
    if count <= 10_000 {
        return Ok(());
    }
    Err(CliError::new(
        CliErrorCode::ScopeBudgetExceeded,
        "Resource resolution exceeds 10,000 candidates; use a narrower scope",
    ))
}

pub(crate) fn resolve_database(
    client: &CoreClient,
    project: &nodex_core_contracts::workspace::ProjectWorkspaceProject,
    selector: Option<&str>,
) -> Result<String, CliError> {
    let Some(selector) = selector else {
        return Ok(project.database_id.clone());
    };
    if let Some(id) = read_identity(
        client,
        &project.id,
        selector,
        DatabaseRead::Database {
            target: nodex_core_contracts::database::DatabaseIdentityTarget::Database {
                database_id: stable_id(selector)?,
            },
        },
    )? {
        return Ok(id);
    }
    select_identity(selector, "Database", database_candidates(client, project)?)
}

pub(crate) fn resolve_source(
    client: &CoreClient,
    project: &nodex_core_contracts::workspace::ProjectWorkspaceProject,
    selector: &str,
) -> Result<String, CliError> {
    if let Some(id) = read_identity(
        client,
        &project.id,
        selector,
        DatabaseRead::DataSource {
            data_source_id: stable_id(selector)?,
        },
    )? {
        return Ok(id);
    }
    let mut candidates = Vec::new();
    for database_id in [project.database_id.clone()] {
        let mut after = None;
        loop {
            let snapshot = unwrap_database(client.database_read(
                Some(&project.id),
                DatabaseRead::DataSourceWindow {
                    database_id: database_id.clone(),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(200),
                    },
                },
            ))?;
            let DatabaseReadValue::DataSourceWindow { data_sources } = snapshot.value else {
                return Err(internal("unexpected Data Source catalog"));
            };
            candidates.extend(
                data_sources
                    .items
                    .into_iter()
                    .map(|item| (item.data_source_id, item.name)),
            );
            enforce_selector_budget(candidates.len())?;
            after = data_sources.next_cursor;
            if after.is_none() {
                break;
            }
        }
    }
    select_identity(selector, "Data Source", candidates)
}

pub(crate) fn resolve_optional_source(
    client: &CoreClient,
    project: &nodex_core_contracts::workspace::ProjectWorkspaceProject,
    selector: Option<&str>,
) -> Result<String, CliError> {
    if let Some(selector) = selector {
        return resolve_source(client, project, selector);
    }
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::DataSourceWindow {
            database_id: project.database_id.clone(),
            window: CollectionWindowRequest {
                after: None,
                first: Some(200),
            },
        },
    ))?;
    let DatabaseReadValue::DataSourceWindow { data_sources } = snapshot.value else {
        return Err(internal("unexpected Data Source catalog"));
    };
    select_default_source(
        &project.database_id,
        data_sources
            .items
            .into_iter()
            .map(|source| (source.data_source_id, source.name))
            .collect(),
        data_sources.next_cursor.is_some(),
    )
}

pub(crate) fn select_default_source(
    database_id: &str,
    candidates: Vec<(String, String)>,
    has_more: bool,
) -> Result<String, CliError> {
    if candidates.len() == 1 && !has_more {
        return Ok(candidates[0].0.clone());
    }
    let code = if candidates.is_empty() {
        CliErrorCode::ScopeNotFound
    } else {
        CliErrorCode::ScopeAmbiguous
    };
    let candidates: Vec<_> = candidates
        .into_iter()
        .take(8)
        .map(|(id, name)| serde_json::json!({"id": id, "name": name}))
        .collect();
    Err(CliError::new(code, "Specify a Data Source; the Project's default Database does not have exactly one active Data Source. Query `data_sources` with `nodex sql query`.").with_details(serde_json::json!({"argument":"data_source", "scope": database_id, "candidates": candidates, "hint":"Pass a Data Source ID or unique name"})))
}

/// Probe identities directly before bounded name discovery; a name can fail identity authorization.
pub(crate) fn read_identity(
    client: &CoreClient,
    project_id: &str,
    selector: &str,
    read: DatabaseRead,
) -> Result<Option<String>, CliError> {
    let snapshot = match unwrap_database(client.database_read(Some(project_id), read)) {
        Ok(value) => value,
        Err(error)
            if !selector.starts_with('@')
                && (matches!(
                    error.code,
                    CliErrorCode::ScopeNotFound | CliErrorCode::InvalidInput
                ) || (error.code == CliErrorCode::ScopeUnauthorized
                    && !uuid_identity(selector))) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let id = match snapshot.value {
        DatabaseReadValue::Database { value } => value.database.database_id,
        DatabaseReadValue::DataSource { value } => value.data_source.data_source_id,
        DatabaseReadValue::View { value } => value.view_id,
        _ => return Err(internal("unexpected resource identity")),
    };
    Ok(Some(id))
}

fn uuid_identity(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                return byte == b'-';
            }
            byte.is_ascii_hexdigit()
        })
}

/// Select the collection Database without changing the Project authorization identity.
pub(crate) fn selected_database_project(
    client: &CoreClient,
    explicit_project: Option<&str>,
    database: Option<&str>,
    cwd: &Path,
) -> Result<nodex_core_contracts::workspace::ProjectWorkspaceProject, CliError> {
    let mut project = selected_project(client, explicit_project, cwd)?;
    let Some(database) = database else {
        return Ok(project);
    };
    let database_id = resolve_database(client, &project, Some(database))?;
    let snapshot = unwrap_database(client.database_read(
        Some(&project.id),
        DatabaseRead::Database {
            target: nodex_core_contracts::database::DatabaseIdentityTarget::Database {
                database_id,
            },
        },
    ))?;
    let DatabaseReadValue::Database { value } = snapshot.value else {
        return Err(internal("unexpected Database descriptor"));
    };
    project.database_id = value.database.database_id;
    project.default_database_view_id = value.database.default_view_id;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_accept_bare_ids_optional_prefix_and_unique_names() {
        let candidates = vec![
            ("id-1".to_owned(), "Work".to_owned()),
            ("id-2".to_owned(), "Work".to_owned()),
        ];
        for selector in ["id-1", "@id-1"] {
            assert_eq!(
                select_identity(selector, "View", candidates.clone()).unwrap(),
                "id-1"
            );
        }
        assert_eq!(
            select_identity("Work", "View", candidates)
                .unwrap_err()
                .code,
            CliErrorCode::ScopeAmbiguous
        );
        assert_eq!(
            select_identity("Work", "View", vec![("id-1".to_owned(), "Work".to_owned())]).unwrap(),
            "id-1"
        );
        assert_eq!(
            select_identity("missing", "View", vec![]).unwrap_err().code,
            CliErrorCode::ScopeNotFound
        );
    }
    #[test]
    fn default_source_requires_a_complete_singleton() {
        let one = vec![("source-1".to_owned(), "Tasks".to_owned())];
        assert_eq!(
            select_default_source("db", one.clone(), false).unwrap(),
            "source-1"
        );
        assert_eq!(
            select_default_source("db", one.clone(), true)
                .unwrap_err()
                .code,
            CliErrorCode::ScopeAmbiguous
        );
        let mut two = one;
        two.push(("source-2".to_owned(), "Notes".to_owned()));
        let error = select_default_source("db", two, false).unwrap_err();
        assert_eq!(error.code, CliErrorCode::ScopeAmbiguous);
        assert_eq!(
            error.details.unwrap()["candidates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            select_default_source("db", vec![], false).unwrap_err().code,
            CliErrorCode::ScopeNotFound
        );
    }
}
