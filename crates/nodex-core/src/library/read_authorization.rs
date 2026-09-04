use nodex_core_contracts::events::{AuthorizedReadStamp, ResourceKey};
use nodex_core_contracts::library::{
    LibraryCatalogEntry, LibraryNavigationNode, LibraryNavigationParent, LibraryRead,
    LibraryReadValue, LibraryResourceTarget, LibraryRouteTarget,
};
use nodex_core_contracts::{BoundModuleContext, StoreEpoch};
use rusqlite::Connection;

use crate::infrastructure::resource_authorization;
use crate::infrastructure::sqlite::StoreError;

pub(super) fn issue(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    commit_head: i64,
    read: &LibraryRead,
    value: &LibraryReadValue,
) -> Result<Option<AuthorizedReadStamp>, StoreError> {
    let subject = if context.project_id.is_none()
        && matches!(
            read,
            LibraryRead::FilePresentation {
                source: nodex_core_contracts::library::LibraryFileReadSource::RecoveryDraft { .. }
                    | nodex_core_contracts::library::LibraryFileReadSource::CanvasRecovery { .. },
                ..
            }
        ) {
        Some(library_resource(&context.library_id.0))
    } else {
        read_subject(&context.library_id.0, read, value)
    };
    let Some(subject) = subject else {
        return Ok(None);
    };
    let mut authorization_dependencies = vec![subject.clone()];
    append_value_dependencies(value, &mut authorization_dependencies);
    resource_authorization::issue_read_stamp(
        connection,
        context,
        StoreEpoch(store_epoch.to_owned()),
        commit_head,
        subject.clone(),
        vec![subject],
        authorization_dependencies,
    )
    .map(Some)
}

fn read_subject(
    library_id: &str,
    read: &LibraryRead,
    value: &LibraryReadValue,
) -> Option<ResourceKey> {
    match read {
        LibraryRead::Files { .. } => Some(library_resource(library_id)),
        LibraryRead::FileUsages { file_id, .. }
        | LibraryRead::FileVersions { file_id, .. }
        | LibraryRead::File { file_id } => Some(ResourceKey::File {
            file_id: file_id.clone(),
        }),
        LibraryRead::FilePresentation {
            file_id, source, ..
        } => Some(match source {
            nodex_core_contracts::library::LibraryFileReadSource::Direct => ResourceKey::File {
                file_id: file_id.clone(),
            },
            nodex_core_contracts::library::LibraryFileReadSource::Page { page_id } => {
                ResourceKey::Page {
                    page_id: page_id.clone(),
                }
            }
            nodex_core_contracts::library::LibraryFileReadSource::DocumentRevision {
                document_id,
                ..
            }
            | nodex_core_contracts::library::LibraryFileReadSource::RecoveryDraft {
                document_id,
                ..
            }
            | nodex_core_contracts::library::LibraryFileReadSource::CanvasRevision {
                document_id,
                ..
            }
            | nodex_core_contracts::library::LibraryFileReadSource::CanvasRecovery {
                document_id,
                ..
            } => ResourceKey::Document {
                document_id: document_id.clone(),
            },
            nodex_core_contracts::library::LibraryFileReadSource::Canvas { canvas_id, .. } => {
                ResourceKey::Canvas {
                    canvas_id: canvas_id.clone(),
                }
            }
        }),
        LibraryRead::Metadata
        | LibraryRead::StandaloneRoots { .. }
        | LibraryRead::Catalog { .. } => Some(library_resource(library_id)),
        LibraryRead::ResourceProjectAccess { target } => Some(resource_target(target)),
        LibraryRead::Children { parent, .. } => Some(navigation_parent(library_id, parent)),
        LibraryRead::Path { target } => Some(route_target(target)),
        LibraryRead::PageDetail { page_id }
        | LibraryRead::PageFileInventory { page_id, .. }
        | LibraryRead::ResolvePageFile { page_id, .. }
        | LibraryRead::PageContent { page_id }
        | LibraryRead::PageProjectionFile { page_id, .. }
        | LibraryRead::PageDraftProjection { page_id } => Some(ResourceKey::Page {
            page_id: page_id.clone(),
        }),
        LibraryRead::PageMentionDestination { page_id } => Some(ResourceKey::Page {
            page_id: page_id.clone(),
        }),
        LibraryRead::PageTarget { page_id }
        | LibraryRead::PageOwnershipPath { page_id }
        | LibraryRead::PageLocation { page_id } => existing_page_subject(value, page_id),
        LibraryRead::CanvasTarget { canvas_id } => matches!(
            value,
            LibraryReadValue::CanvasTarget {
                value
            } if matches!(
                value.as_ref(),
                nodex_core_contracts::library::LibraryCanvasTarget::Available { .. }
            )
        )
        .then(|| ResourceKey::Canvas {
            canvas_id: canvas_id.clone(),
        }),
        LibraryRead::ViewLocation { view_id } => existing_view_subject(value, view_id),
        _ => None,
    }
}

fn library_resource(library_id: &str) -> ResourceKey {
    ResourceKey::Library {
        library_id: library_id.to_owned(),
    }
}

fn navigation_parent(library_id: &str, parent: &LibraryNavigationParent) -> ResourceKey {
    match parent {
        LibraryNavigationParent::Library => library_resource(library_id),
        LibraryNavigationParent::Page { page_id } => ResourceKey::Page {
            page_id: page_id.clone(),
        },
        LibraryNavigationParent::Database { database_id } => ResourceKey::Database {
            database_id: database_id.clone(),
        },
    }
}

fn route_target(target: &LibraryRouteTarget) -> ResourceKey {
    match target {
        LibraryRouteTarget::Page { page_id } => ResourceKey::Page {
            page_id: page_id.clone(),
        },
        LibraryRouteTarget::Database { database_id } => ResourceKey::Database {
            database_id: database_id.clone(),
        },
        LibraryRouteTarget::Canvas { canvas_id } => ResourceKey::Canvas {
            canvas_id: canvas_id.clone(),
        },
        LibraryRouteTarget::View { view_id } => ResourceKey::View {
            view_id: view_id.clone(),
        },
    }
}

fn resource_target(target: &LibraryResourceTarget) -> ResourceKey {
    match target {
        LibraryResourceTarget::File { file_id } => ResourceKey::File {
            file_id: file_id.clone(),
        },
        LibraryResourceTarget::Page { page_id } => ResourceKey::Page {
            page_id: page_id.clone(),
        },
        LibraryResourceTarget::Database { database_id } => ResourceKey::Database {
            database_id: database_id.clone(),
        },
        LibraryResourceTarget::Canvas { canvas_id } => ResourceKey::Canvas {
            canvas_id: canvas_id.clone(),
        },
    }
}

fn existing_page_subject(value: &LibraryReadValue, page_id: &str) -> Option<ResourceKey> {
    let exists = match value {
        LibraryReadValue::PageTarget { value } => matches!(
            value.as_deref(),
            Some(nodex_core_contracts::library::LibraryPageTarget::Available { .. })
        ),
        LibraryReadValue::PageOwnershipPath { value } => matches!(
            value.as_deref(),
            Some(nodex_core_contracts::library::LibraryPageOwnershipPath::Available { .. })
        ),
        LibraryReadValue::PageLocation { value } => value.is_some(),
        _ => false,
    };
    exists.then(|| ResourceKey::Page {
        page_id: page_id.to_owned(),
    })
}

fn existing_view_subject(value: &LibraryReadValue, view_id: &str) -> Option<ResourceKey> {
    matches!(value, LibraryReadValue::ViewLocation { value: Some(_) }).then(|| ResourceKey::View {
        view_id: view_id.to_owned(),
    })
}

fn append_value_dependencies(value: &LibraryReadValue, output: &mut Vec<ResourceKey>) {
    match value {
        LibraryReadValue::FileUsages { value } => {
            output.extend(
                value
                    .items
                    .iter()
                    .map(|item| resource_target(&item.target.clone().into())),
            );
        }
        LibraryReadValue::Files { value } => {
            output.extend(value.items.iter().map(|file| ResourceKey::File {
                file_id: file.file_id.clone(),
            }))
        }
        LibraryReadValue::Children { items, .. }
        | LibraryReadValue::StandaloneRoots { items, .. }
        | LibraryReadValue::Path { nodes: items, .. } => {
            for item in items {
                append_navigation_node(item, output);
            }
        }
        LibraryReadValue::Catalog { items, .. } => {
            for item in items {
                append_catalog_entry(item, output);
            }
        }
        LibraryReadValue::PageOwnershipPath { value: Some(path) } => {
            if let nodex_core_contracts::library::LibraryPageOwnershipPath::Available {
                ancestors,
                ..
            } = path.as_ref()
            {
                output.extend(ancestors.iter().map(|ancestor| ResourceKey::Page {
                    page_id: ancestor.page_id.clone(),
                }));
            }
        }
        LibraryReadValue::ViewLocation {
            value: Some(location),
        } => {
            output.push(ResourceKey::Database {
                database_id: location.database_id.clone(),
            });
            output.push(ResourceKey::DataSource {
                data_source_id: location.data_source_id.clone(),
            });
        }
        _ => {}
    }
}

fn append_catalog_entry(entry: &LibraryCatalogEntry, output: &mut Vec<ResourceKey>) {
    output.push(resource_target(&entry.target.clone().into()));
}

fn append_navigation_node(node: &LibraryNavigationNode, output: &mut Vec<ResourceKey>) {
    match node {
        LibraryNavigationNode::Page { page_id, .. } => output.push(ResourceKey::Page {
            page_id: page_id.clone(),
        }),
        LibraryNavigationNode::Database {
            database_id,
            default_view_id,
            ..
        } => {
            output.push(ResourceKey::Database {
                database_id: database_id.clone(),
            });
            output.push(ResourceKey::View {
                view_id: default_view_id.clone(),
            });
        }
        LibraryNavigationNode::Canvas { canvas_id, .. } => output.push(ResourceKey::Canvas {
            canvas_id: canvas_id.clone(),
        }),
        LibraryNavigationNode::View {
            view_id,
            database_id,
            data_source_id,
            ..
        } => {
            output.push(ResourceKey::View {
                view_id: view_id.clone(),
            });
            output.push(ResourceKey::Database {
                database_id: database_id.clone(),
            });
            output.push(ResourceKey::DataSource {
                data_source_id: data_source_id.clone(),
            });
        }
    }
}
