use crate::error::{CliError, CliErrorCode};
use crate::runtime::unwrap_database;
use nodex_core_contracts::collection::{CollectionWindowRequest, MAX_COLLECTION_WINDOW_ITEMS};
use nodex_core_contracts::database::{DatabaseRead, DatabaseReadValue};
use nodex_core_contracts::workspace::ProjectWorkspaceProject;
use nodex_core_protocol::client::CoreClient;

pub(crate) fn resolve_view_selector(
    client: &CoreClient,
    project: &ProjectWorkspaceProject,
    selector: &str,
) -> Result<String, CliError> {
    if let Some(id) = crate::data_source::read_identity(
        client,
        &project.id,
        selector,
        DatabaseRead::View {
            view_id: crate::data_source::stable_id(selector)?,
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
                DatabaseRead::ViewDescriptorWindow {
                    database_id: database_id.clone(),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(MAX_COLLECTION_WINDOW_ITEMS),
                    },
                },
            ))?;
            let DatabaseReadValue::ViewDescriptorWindow { views } = snapshot.value else {
                return Err(internal("unexpected View catalog"));
            };
            candidates.extend(
                views
                    .items
                    .into_iter()
                    .map(|view| (view.view_id, view.name)),
            );
            crate::data_source::enforce_selector_budget(candidates.len())?;
            after = views.next_cursor;
            if after.is_none() {
                break;
            }
        }
    }
    crate::data_source::select_identity(selector, "View", candidates)
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}
