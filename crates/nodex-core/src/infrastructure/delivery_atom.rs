//! Resource-atomic semantic delivery compilation.
//!
//! Physical Module events may aggregate many affected identities for durable
//! evidence. They are never authorization units. This compiler turns them
//! into deliberately redacted, independently authorizable atoms before the
//! LocalCommit manifest is sealed.

use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::administration::StoreAdministrationEvent;
use nodex_core_contracts::automation::AutomationEvent;
use nodex_core_contracts::database::{DatabaseEvent, DatabasePersonalViewChange};
use nodex_core_contracts::events::{
    AuthorizedOwnedDocumentEvent, CoreModuleEventPayload, DeliveryAtomKind, DeliveryAtomPayload,
    ResourceKey,
};
use nodex_core_contracts::library::{LibraryEvent, LibraryEventKind};
use nodex_core_contracts::workspace::ProjectWorkspaceEvent;
use rusqlite::{Connection, OptionalExtension};

use super::sqlite::{StoreError, StoreErrorCode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeliveryAtomDraft {
    pub kind: DeliveryAtomKind,
    pub required_resources: Vec<ResourceKey>,
    pub payload: DeliveryAtomPayload,
}

pub(crate) fn compile(
    connection: &Connection,
    library_id: &str,
    physical_project_id: &str,
    payload: CoreModuleEventPayload,
) -> Result<Vec<DeliveryAtomDraft>, StoreError> {
    validate_identity(library_id, "DeliveryAtom Library")?;
    validate_identity(physical_project_id, "DeliveryAtom physical Project")?;
    let atoms = match payload {
        CoreModuleEventPayload::Library(event) => compile_library(library_id, event)?,
        CoreModuleEventPayload::Database(event) => compile_database(library_id, event),
        CoreModuleEventPayload::OwnedDocument(event) => {
            compile_owned_document(connection, library_id, event)?
        }
        CoreModuleEventPayload::ProjectWorkspace(event) => {
            compile_workspace(library_id, physical_project_id, event)
        }
        CoreModuleEventPayload::Automation(event) => {
            compile_automation(library_id, physical_project_id, event)
        }
        CoreModuleEventPayload::StoreAdministration(event) => {
            compile_store_administration(library_id, event)?
        }
    };
    for atom in &atoms {
        validate(atom)?;
    }
    Ok(atoms)
}

pub(crate) fn compile_store_administration(
    library_id: &str,
    event: StoreAdministrationEvent,
) -> Result<Vec<DeliveryAtomDraft>, StoreError> {
    validate_identity(library_id, "DeliveryAtom Library")?;
    let atoms = vec![atom(
        DeliveryAtomKind::StoreAdministrationChanged,
        [ResourceKey::Library {
            library_id: library_id.to_owned(),
        }],
        DeliveryAtomPayload::StoreAdministration {
            library_id: library_id.to_owned(),
            event,
        },
    )];
    for atom in &atoms {
        validate(atom)?;
    }
    Ok(atoms)
}

pub(crate) fn payload_claims(
    payload: &DeliveryAtomPayload,
) -> Result<Vec<ResourceKey>, StoreError> {
    let mut claims = BTreeSet::new();
    match payload {
        DeliveryAtomPayload::Library { library_id, event } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
            claims.extend(
                event
                    .page_ids
                    .iter()
                    .chain(event.page_file_manifest_invalidations.keys())
                    .chain(event.page_file_body_usage_revisions.keys())
                    .chain(event.page_file_content_invalidations.keys())
                    .cloned()
                    .map(|page_id| ResourceKey::Page { page_id }),
            );
            claims.extend(
                event
                    .database_ids
                    .iter()
                    .cloned()
                    .map(|database_id| ResourceKey::Database { database_id }),
            );
            claims.extend(
                event
                    .view_ids
                    .iter()
                    .cloned()
                    .map(|view_id| ResourceKey::View { view_id }),
            );
            for parent_key in &event.parent_keys {
                if let Some(resource) = parent_resource(parent_key, library_id)? {
                    claims.insert(resource);
                }
            }
        }
        DeliveryAtomPayload::Database { library_id, event } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
            if let Some(project_id) = &event.project_id {
                claims.insert(ResourceKey::Project {
                    project_id: project_id.clone(),
                });
            }
            claims.extend(
                event
                    .database_ids
                    .iter()
                    .cloned()
                    .map(|database_id| ResourceKey::Database { database_id }),
            );
            claims.extend(
                event
                    .data_source_ids
                    .iter()
                    .cloned()
                    .map(|data_source_id| ResourceKey::DataSource { data_source_id }),
            );
            claims.extend(
                event
                    .page_ids
                    .iter()
                    .cloned()
                    .map(|page_id| ResourceKey::Page { page_id }),
            );
            claims.extend(
                event
                    .view_ids
                    .iter()
                    .cloned()
                    .map(|view_id| ResourceKey::View { view_id }),
            );
            claims.extend(
                event
                    .personal_view_changes
                    .iter()
                    .map(|change| ResourceKey::View {
                        view_id: change.view_id().to_owned(),
                    }),
            );
        }
        DeliveryAtomPayload::OwnedDocument {
            library_id,
            canvas_id,
            event,
        } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
            claims.insert(ResourceKey::Document {
                document_id: owned_document_id(event).to_owned(),
            });
            if let Some(canvas_id) = canvas_id {
                claims.insert(ResourceKey::Canvas {
                    canvas_id: canvas_id.clone(),
                });
            }
        }
        DeliveryAtomPayload::ProjectWorkspace { library_id, event } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
            claims.extend(
                event
                    .project_ids
                    .iter()
                    .cloned()
                    .map(|project_id| ResourceKey::Project { project_id }),
            );
        }
        DeliveryAtomPayload::Automation {
            library_id,
            project_id,
            event,
        } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
            claims.insert(ResourceKey::Project {
                project_id: project_id.clone(),
            });
            claims.extend(
                event
                    .page_ids
                    .iter()
                    .cloned()
                    .map(|page_id| ResourceKey::Page { page_id }),
            );
            claims.extend(
                event
                    .document_ids
                    .iter()
                    .cloned()
                    .map(|document_id| ResourceKey::Document { document_id }),
            );
            claims.extend(
                event
                    .database_ids
                    .iter()
                    .cloned()
                    .map(|database_id| ResourceKey::Database { database_id }),
            );
        }
        DeliveryAtomPayload::StoreAdministration { library_id, .. } => {
            claims.insert(ResourceKey::Library {
                library_id: library_id.clone(),
            });
        }
    }
    Ok(claims.into_iter().collect())
}

fn compile_library(
    library_id: &str,
    event: LibraryEvent,
) -> Result<Vec<DeliveryAtomDraft>, StoreError> {
    let mut atoms = Vec::new();
    let page_ids = event
        .page_ids
        .iter()
        .chain(event.page_file_manifest_invalidations.keys())
        .chain(event.page_file_body_usage_revisions.keys())
        .chain(event.page_file_content_invalidations.keys())
        .collect::<BTreeSet<_>>();
    for page_id in page_ids {
        let page_ids = if event.page_ids.contains(page_id) {
            vec![page_id.clone()]
        } else {
            Vec::new()
        };
        let page_file_manifest_invalidations = event
            .page_file_manifest_invalidations
            .get(page_id)
            .cloned()
            .map(|invalidation| BTreeMap::from([(page_id.clone(), invalidation)]))
            .unwrap_or_default();
        let page_file_body_usage_revisions = event
            .page_file_body_usage_revisions
            .get(page_id)
            .map(|revision| BTreeMap::from([(page_id.clone(), *revision)]))
            .unwrap_or_default();
        let page_file_content_invalidations = event
            .page_file_content_invalidations
            .get(page_id)
            .cloned()
            .map(|invalidation| BTreeMap::from([(page_id.clone(), invalidation)]))
            .unwrap_or_default();
        atoms.push(atom(
            DeliveryAtomKind::LibraryNavigationChanged,
            [
                library(library_id),
                ResourceKey::Page {
                    page_id: page_id.clone(),
                },
            ],
            DeliveryAtomPayload::Library {
                library_id: library_id.to_owned(),
                event: LibraryEvent {
                    kind: event.kind,
                    page_ids,
                    database_ids: Vec::new(),
                    view_ids: Vec::new(),
                    parent_keys: Vec::new(),
                    page_file_manifest_invalidations,
                    page_file_body_usage_revisions,
                    page_file_content_invalidations,
                },
            },
        ));
    }
    for database_id in &event.database_ids {
        atoms.push(atom(
            DeliveryAtomKind::LibraryNavigationChanged,
            [
                library(library_id),
                ResourceKey::Database {
                    database_id: database_id.clone(),
                },
            ],
            DeliveryAtomPayload::Library {
                library_id: library_id.to_owned(),
                event: LibraryEvent {
                    kind: event.kind,
                    page_ids: Vec::new(),
                    database_ids: vec![database_id.clone()],
                    view_ids: Vec::new(),
                    parent_keys: Vec::new(),
                    page_file_manifest_invalidations: BTreeMap::new(),
                    page_file_body_usage_revisions: BTreeMap::new(),
                    page_file_content_invalidations: BTreeMap::new(),
                },
            },
        ));
    }
    for view_id in &event.view_ids {
        atoms.push(atom(
            DeliveryAtomKind::LibraryNavigationChanged,
            [
                library(library_id),
                ResourceKey::View {
                    view_id: view_id.clone(),
                },
            ],
            DeliveryAtomPayload::Library {
                library_id: library_id.to_owned(),
                event: LibraryEvent {
                    kind: event.kind,
                    page_ids: Vec::new(),
                    database_ids: Vec::new(),
                    view_ids: vec![view_id.clone()],
                    parent_keys: Vec::new(),
                    page_file_manifest_invalidations: BTreeMap::new(),
                    page_file_body_usage_revisions: BTreeMap::new(),
                    page_file_content_invalidations: BTreeMap::new(),
                },
            },
        ));
    }
    for parent_key in &event.parent_keys {
        let mut requirements = vec![library(library_id)];
        if let Some(resource) = parent_resource(parent_key, library_id)? {
            requirements.push(resource);
        }
        atoms.push(atom(
            DeliveryAtomKind::LibraryNavigationChanged,
            requirements,
            DeliveryAtomPayload::Library {
                library_id: library_id.to_owned(),
                event: LibraryEvent {
                    kind: event.kind,
                    page_ids: Vec::new(),
                    database_ids: Vec::new(),
                    view_ids: Vec::new(),
                    parent_keys: vec![parent_key.clone()],
                    page_file_manifest_invalidations: BTreeMap::new(),
                    page_file_body_usage_revisions: BTreeMap::new(),
                    page_file_content_invalidations: BTreeMap::new(),
                },
            },
        ));
    }
    if atoms.is_empty() {
        atoms.push(atom(
            DeliveryAtomKind::LibraryNavigationChanged,
            [library(library_id)],
            DeliveryAtomPayload::Library {
                library_id: library_id.to_owned(),
                event: LibraryEvent {
                    kind: event.kind,
                    page_ids: Vec::new(),
                    database_ids: Vec::new(),
                    view_ids: Vec::new(),
                    parent_keys: Vec::new(),
                    page_file_manifest_invalidations: BTreeMap::new(),
                    page_file_body_usage_revisions: BTreeMap::new(),
                    page_file_content_invalidations: BTreeMap::new(),
                },
            },
        ));
    }
    Ok(atoms)
}

fn compile_database(library_id: &str, event: DatabaseEvent) -> Vec<DeliveryAtomDraft> {
    let base = database_scope(library_id, event.project_id.as_deref());
    let mut atoms = Vec::new();
    for database_id in &event.database_ids {
        atoms.push(database_atom(
            library_id,
            &event,
            base.iter().cloned().chain([ResourceKey::Database {
                database_id: database_id.clone(),
            }]),
            DatabaseDeliveryChanges {
                database_ids: vec![database_id.clone()],
                ..Default::default()
            },
        ));
    }
    for data_source_id in &event.data_source_ids {
        atoms.push(database_atom(
            library_id,
            &event,
            base.iter().cloned().chain([ResourceKey::DataSource {
                data_source_id: data_source_id.clone(),
            }]),
            DatabaseDeliveryChanges {
                data_source_ids: vec![data_source_id.clone()],
                ..Default::default()
            },
        ));
    }
    for page_id in &event.page_ids {
        atoms.push(database_atom(
            library_id,
            &event,
            base.iter().cloned().chain([ResourceKey::Page {
                page_id: page_id.clone(),
            }]),
            DatabaseDeliveryChanges {
                page_ids: vec![page_id.clone()],
                ..Default::default()
            },
        ));
    }
    for view_id in &event.view_ids {
        atoms.push(database_atom(
            library_id,
            &event,
            base.iter().cloned().chain([ResourceKey::View {
                view_id: view_id.clone(),
            }]),
            DatabaseDeliveryChanges {
                view_ids: vec![view_id.clone()],
                ..Default::default()
            },
        ));
    }
    for change in &event.personal_view_changes {
        atoms.push(database_atom(
            library_id,
            &event,
            base.iter().cloned().chain([ResourceKey::View {
                view_id: change.view_id().to_owned(),
            }]),
            DatabaseDeliveryChanges {
                personal_view_changes: vec![change.clone()],
                ..Default::default()
            },
        ));
    }
    if atoms.is_empty() {
        atoms.push(database_atom(
            library_id,
            &event,
            base,
            DatabaseDeliveryChanges::default(),
        ));
    }
    atoms
}

#[derive(Default)]
struct DatabaseDeliveryChanges {
    database_ids: Vec<String>,
    data_source_ids: Vec<String>,
    page_ids: Vec<String>,
    view_ids: Vec<String>,
    personal_view_changes: Vec<DatabasePersonalViewChange>,
}

fn database_atom(
    library_id: &str,
    source: &DatabaseEvent,
    requirements: impl IntoIterator<Item = ResourceKey>,
    changes: DatabaseDeliveryChanges,
) -> DeliveryAtomDraft {
    atom(
        DeliveryAtomKind::DatabaseChanged,
        requirements,
        DeliveryAtomPayload::Database {
            library_id: library_id.to_owned(),
            event: DatabaseEvent {
                kind: source.kind,
                project_id: source.project_id.clone(),
                database_ids: changes.database_ids,
                data_source_ids: changes.data_source_ids,
                page_ids: changes.page_ids,
                view_ids: changes.view_ids,
                personal_view_changes: changes.personal_view_changes,
            },
        },
    )
}

fn compile_owned_document(
    connection: &Connection,
    library_id: &str,
    event: nodex_core_contracts::document::OwnedDocumentEvent,
) -> Result<Vec<DeliveryAtomDraft>, StoreError> {
    let (
        event,
        document_id,
        generation,
        head_seq,
        page_file_body_usage_changed,
        page_file_reference_change,
    ) = match event {
        nodex_core_contracts::document::OwnedDocumentEvent::DocumentUpdated {
            document_id,
            generation,
            head_seq,
            page_file_body_usage_changed,
            page_file_reference_change,
            ..
        } => (
            None,
            document_id,
            generation,
            head_seq,
            page_file_body_usage_changed,
            page_file_reference_change,
        ),
        nodex_core_contracts::document::OwnedDocumentEvent::DocumentResyncRequired {
            document_id,
            generation,
            head_seq,
            update_id,
            update_hash,
            page_file_body_usage_changed,
            page_file_reference_change,
        } => (
            Some(AuthorizedOwnedDocumentEvent::DocumentResyncRequired {
                document_id: document_id.clone(),
                generation,
                head_seq,
                update_id,
                update_hash,
            }),
            document_id,
            generation,
            head_seq,
            page_file_body_usage_changed,
            page_file_reference_change,
        ),
        nodex_core_contracts::document::OwnedDocumentEvent::CanvasUpdated {
            document_id,
            generation,
            base_head_seq,
            head_seq,
            scene_hash,
            mutation,
        } => (
            Some(AuthorizedOwnedDocumentEvent::CanvasUpdated {
                document_id: document_id.clone(),
                generation,
                base_head_seq,
                head_seq,
                scene_hash,
                mutation,
            }),
            document_id,
            generation,
            head_seq,
            false,
            None,
        ),
        nodex_core_contracts::document::OwnedDocumentEvent::CanvasGenerationChanged {
            document_id,
            previous_generation,
            previous_head_seq,
            generation,
            head_seq,
            scene_hash,
        } => (
            Some(AuthorizedOwnedDocumentEvent::CanvasGenerationChanged {
                document_id: document_id.clone(),
                previous_generation,
                previous_head_seq,
                generation,
                head_seq,
                scene_hash,
            }),
            document_id,
            generation,
            head_seq,
            false,
            None,
        ),
        nodex_core_contracts::document::OwnedDocumentEvent::DocumentInvalidated {
            document_id,
            generation,
            head_seq,
            reason,
            page_file_body_usage_changed,
            page_file_reference_change,
        } => (
            Some(AuthorizedOwnedDocumentEvent::DocumentInvalidated {
                document_id: document_id.clone(),
                reason,
            }),
            document_id,
            generation,
            head_seq,
            page_file_body_usage_changed,
            page_file_reference_change,
        ),
    };
    let mut atoms = if page_file_body_usage_changed {
        compile_page_file_body_usage(connection, library_id, &document_id)?
    } else {
        Vec::new()
    };
    let mut events = Vec::new();
    if let Some(change) = page_file_reference_change {
        events.push(AuthorizedOwnedDocumentEvent::PageFileReferencesChanged {
            document_id: document_id.clone(),
            generation,
            head_seq,
            change,
        });
    }
    if let Some(event) = event {
        events.push(event);
    }
    if events.is_empty() {
        return Ok(atoms);
    }
    let needs_canvas_authority = events.iter().any(|event| {
        !matches!(
            event,
            AuthorizedOwnedDocumentEvent::PageFileReferencesChanged { .. }
        )
    });
    let canvas_id = if needs_canvas_authority {
        connection
            .query_row(
                "SELECT ownership.block_id
                 FROM block_documents ownership
                 JOIN blocks block ON block.id = ownership.block_id
                 JOIN canvas_owners canvas ON canvas.block_id = ownership.block_id
                 WHERE ownership.document_id = ?1 AND canvas.library_id = ?2
                   AND block.type = 'canvas'",
                [&document_id, library_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
    } else {
        None
    };
    atoms.extend(events.into_iter().map(|event| {
        let event_canvas_id = (!matches!(
            &event,
            AuthorizedOwnedDocumentEvent::PageFileReferencesChanged { .. }
        ))
        .then(|| canvas_id.clone())
        .flatten();
        let mut requirements = vec![
            library(library_id),
            ResourceKey::Document {
                document_id: document_id.clone(),
            },
        ];
        if let Some(canvas_id) = &event_canvas_id {
            requirements.push(ResourceKey::Canvas {
                canvas_id: canvas_id.clone(),
            });
        }
        atom(
            DeliveryAtomKind::OwnedDocumentChanged,
            requirements,
            DeliveryAtomPayload::OwnedDocument {
                library_id: library_id.to_owned(),
                canvas_id: event_canvas_id,
                event,
            },
        )
    }));
    Ok(atoms)
}

fn compile_page_file_body_usage(
    connection: &Connection,
    library_id: &str,
    document_id: &str,
) -> Result<Vec<DeliveryAtomDraft>, StoreError> {
    let (page_id, revision) = connection
        .query_row(
            "SELECT projection.page_block_id, manifest.body_usage_revision \
             FROM page_read_model projection \
             JOIN page_file_manifests manifest \
               ON manifest.page_id = projection.page_block_id \
              AND manifest.library_id = projection.library_id \
             WHERE projection.library_id = ?1 AND projection.document_id = ?2",
            [library_id, document_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| corrupt("Page File body usage event has no Page projection"))?;
    compile_library(
        library_id,
        LibraryEvent {
            kind: LibraryEventKind::LibraryChanged,
            page_ids: Vec::new(),
            database_ids: Vec::new(),
            view_ids: Vec::new(),
            parent_keys: Vec::new(),
            page_file_manifest_invalidations: BTreeMap::new(),
            page_file_body_usage_revisions: BTreeMap::from([(page_id, revision)]),
            page_file_content_invalidations: BTreeMap::new(),
        },
    )
}

fn compile_workspace(
    library_id: &str,
    physical_project_id: &str,
    event: ProjectWorkspaceEvent,
) -> Vec<DeliveryAtomDraft> {
    let mut atoms = Vec::new();
    for project_id in &event.project_ids {
        atoms.push(atom(
            DeliveryAtomKind::ProjectWorkspaceChanged,
            [
                library(library_id),
                ResourceKey::Project {
                    project_id: project_id.clone(),
                },
            ],
            DeliveryAtomPayload::ProjectWorkspace {
                library_id: library_id.to_owned(),
                event: ProjectWorkspaceEvent {
                    kind: event.kind,
                    project_catalog_change: event.project_catalog_change,
                    project_ids: vec![project_id.clone()],
                    session_ids: Vec::new(),
                    thread_ids: Vec::new(),
                    session_summary_scopes: Vec::new(),
                    session_detail_ids: Vec::new(),
                },
            },
        ));
    }
    let has_project_payload = !event.session_ids.is_empty()
        || !event.thread_ids.is_empty()
        || !event.session_summary_scopes.is_empty()
        || !event.session_detail_ids.is_empty();
    if has_project_payload || atoms.is_empty() {
        atoms.push(atom(
            DeliveryAtomKind::ProjectWorkspaceChanged,
            [
                library(library_id),
                ResourceKey::Project {
                    project_id: physical_project_id.to_owned(),
                },
            ],
            DeliveryAtomPayload::ProjectWorkspace {
                library_id: library_id.to_owned(),
                event: ProjectWorkspaceEvent {
                    kind: event.kind,
                    project_catalog_change: None,
                    project_ids: vec![physical_project_id.to_owned()],
                    session_ids: event.session_ids,
                    thread_ids: event.thread_ids,
                    session_summary_scopes: event.session_summary_scopes,
                    session_detail_ids: event.session_detail_ids,
                },
            },
        ));
    }
    atoms
}

fn compile_automation(
    library_id: &str,
    project_id: &str,
    mut event: AutomationEvent,
) -> Vec<DeliveryAtomDraft> {
    // Content identities drive projection/document lanes and are not part of
    // the Automation invalidation consumed by Main. Keeping them out of this
    // atom avoids coupling unrelated content authorization to run-list refresh.
    event.page_ids.clear();
    event.document_ids.clear();
    event.database_ids.clear();
    vec![atom(
        DeliveryAtomKind::AutomationChanged,
        [
            library(library_id),
            ResourceKey::Project {
                project_id: project_id.to_owned(),
            },
        ],
        DeliveryAtomPayload::Automation {
            library_id: library_id.to_owned(),
            project_id: project_id.to_owned(),
            event,
        },
    )]
}

fn atom(
    kind: DeliveryAtomKind,
    requirements: impl IntoIterator<Item = ResourceKey>,
    payload: DeliveryAtomPayload,
) -> DeliveryAtomDraft {
    let mut required_resources = requirements.into_iter().collect::<Vec<_>>();
    required_resources.sort();
    required_resources.dedup();
    DeliveryAtomDraft {
        kind,
        required_resources,
        payload,
    }
}

fn validate(atom: &DeliveryAtomDraft) -> Result<(), StoreError> {
    if atom.required_resources.is_empty() {
        return Err(corrupt("DeliveryAtom has no authorization requirements"));
    }
    if payload_claims(&atom.payload)? != atom.required_resources {
        return Err(corrupt(
            "DeliveryAtom payload claims and authorization requirements diverge",
        ));
    }
    Ok(())
}

fn database_scope(library_id: &str, project_id: Option<&str>) -> Vec<ResourceKey> {
    let mut resources = vec![library(library_id)];
    if let Some(project_id) = project_id {
        resources.push(ResourceKey::Project {
            project_id: project_id.to_owned(),
        });
    }
    resources
}

fn library(library_id: &str) -> ResourceKey {
    ResourceKey::Library {
        library_id: library_id.to_owned(),
    }
}

fn parent_resource(parent_key: &str, library_id: &str) -> Result<Option<ResourceKey>, StoreError> {
    if matches!(parent_key, "library" | "catalog" | "standalone_roots") {
        return Ok(None);
    }
    if parent_key == library_id {
        return Ok(None);
    }
    if let Some(parent_library_id) = parent_key.strip_prefix("library:") {
        if parent_library_id != library_id {
            return Err(corrupt("Library parent key names another Library"));
        }
        return Ok(None);
    }
    if let Some(page_id) = parent_key.strip_prefix("page:") {
        let page_id = page_id.strip_suffix(":metadata").unwrap_or(page_id);
        validate_identity(page_id, "Library parent Page")?;
        return Ok(Some(ResourceKey::Page {
            page_id: page_id.to_owned(),
        }));
    }
    if let Some(database_id) = parent_key.strip_prefix("database:") {
        validate_identity(database_id, "Library parent Database")?;
        return Ok(Some(ResourceKey::Database {
            database_id: database_id.to_owned(),
        }));
    }
    if let Some(data_source_id) = parent_key.strip_prefix("data_source:") {
        validate_identity(data_source_id, "Library parent Data Source")?;
        return Ok(Some(ResourceKey::DataSource {
            data_source_id: data_source_id.to_owned(),
        }));
    }
    if let Some(view_id) = parent_key.strip_prefix("view:") {
        validate_identity(view_id, "Library parent View")?;
        return Ok(Some(ResourceKey::View {
            view_id: view_id.to_owned(),
        }));
    }
    Err(corrupt("Library parent key is not a typed Resource"))
}

fn owned_document_id(event: &AuthorizedOwnedDocumentEvent) -> &str {
    match event {
        AuthorizedOwnedDocumentEvent::PageFileReferencesChanged { document_id, .. }
        | AuthorizedOwnedDocumentEvent::DocumentResyncRequired { document_id, .. }
        | AuthorizedOwnedDocumentEvent::CanvasUpdated { document_id, .. }
        | AuthorizedOwnedDocumentEvent::CanvasGenerationChanged { document_id, .. }
        | AuthorizedOwnedDocumentEvent::DocumentInvalidated { document_id, .. } => document_id,
    }
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(corrupt(&format!("{label} identity is invalid")));
    }
    Ok(())
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::database::{
        DatabaseEventKind, DatabasePersonalViewChange, DatabaseViewDisclosureTarget,
    };
    use nodex_core_contracts::document::PageFileReferenceChange;
    use nodex_core_contracts::library::LibraryPageFileInvalidation;

    use super::*;

    #[test]
    fn page_file_invalidations_are_redacted_to_each_page_atom() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        let atoms = compile(
            &connection,
            "library:test",
            "project:test",
            CoreModuleEventPayload::Library(LibraryEvent {
                kind: nodex_core_contracts::library::LibraryEventKind::LibraryChanged,
                page_ids: vec!["page:visible".to_owned(), "page:hidden".to_owned()],
                database_ids: Vec::new(),
                view_ids: Vec::new(),
                parent_keys: Vec::new(),
                page_file_manifest_invalidations: BTreeMap::from([
                    (
                        "page:visible".to_owned(),
                        LibraryPageFileInvalidation::Exact {
                            revision: 7,
                            file_ids: vec!["file:visible".to_owned()],
                        },
                    ),
                    (
                        "page:hidden".to_owned(),
                        LibraryPageFileInvalidation::Reset { revision: 3 },
                    ),
                ]),
                page_file_body_usage_revisions: BTreeMap::new(),
                page_file_content_invalidations: BTreeMap::from([
                    (
                        "page:visible".to_owned(),
                        LibraryPageFileInvalidation::Exact {
                            revision: 11,
                            file_ids: vec!["file:visible".to_owned()],
                        },
                    ),
                    (
                        "page:hidden".to_owned(),
                        LibraryPageFileInvalidation::Reset { revision: 12 },
                    ),
                ]),
            }),
        )
        .expect("compile Page File atoms");

        assert_eq!(atoms.len(), 2);
        for atom in atoms {
            let DeliveryAtomPayload::Library { event, .. } = &atom.payload else {
                panic!("expected Library atom");
            };
            assert_eq!(event.page_ids.len(), 1);
            assert_eq!(event.page_file_manifest_invalidations.len(), 1);
            assert_eq!(event.page_file_content_invalidations.len(), 1);
            assert!(
                event
                    .page_file_manifest_invalidations
                    .contains_key(&event.page_ids[0])
            );
            assert!(
                event
                    .page_file_content_invalidations
                    .contains_key(&event.page_ids[0])
            );
            assert_eq!(
                payload_claims(&atom.payload).expect("atom claims"),
                atom.required_resources,
            );
        }
    }

    #[test]
    fn page_file_placement_change_becomes_inventory_and_document_atoms() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        connection
            .execute_batch(
                "CREATE TABLE page_read_model( \
                   library_id TEXT NOT NULL, page_block_id TEXT NOT NULL, document_id TEXT NOT NULL, \
                   document_generation INTEGER NOT NULL, document_projected_seq INTEGER NOT NULL \
                 ); \
                 CREATE TABLE page_file_manifests( \
                   library_id TEXT NOT NULL, page_id TEXT NOT NULL, body_usage_revision INTEGER NOT NULL \
                 ); \
                 INSERT INTO page_read_model VALUES( \
                   'library:test', 'page:test', 'document:test', 2, 9 \
                 ); \
                 INSERT INTO page_file_manifests VALUES( \
                   'library:test', 'page:test', 4 \
                 );",
            )
            .expect("seed Page projection");

        let atoms = compile(
            &connection,
            "library:test",
            "project:test",
            CoreModuleEventPayload::OwnedDocument(
                nodex_core_contracts::document::OwnedDocumentEvent::DocumentUpdated {
                    document_id: "document:test".to_owned(),
                    generation: 2,
                    head_seq: 9,
                    update: vec![1],
                    page_file_body_usage_changed: true,
                    page_file_reference_change: Some(PageFileReferenceChange::Exact {
                        added_file_ids: vec!["file:test".to_owned()],
                        removed_file_ids: Vec::new(),
                    }),
                },
            ),
        )
        .expect("compile Page File placement atoms");

        assert_eq!(atoms.len(), 2);
        let DeliveryAtomPayload::Library { event, .. } = &atoms[0].payload else {
            panic!("expected Library atom");
        };
        assert!(event.page_ids.is_empty());
        assert_eq!(
            event.page_file_body_usage_revisions.get("page:test"),
            Some(&4),
        );
        assert_eq!(
            payload_claims(&atoms[0].payload).expect("atom claims"),
            atoms[0].required_resources,
        );
        let DeliveryAtomPayload::OwnedDocument { event, .. } = &atoms[1].payload else {
            panic!("expected Owned Document atom");
        };
        assert_eq!(
            event,
            &AuthorizedOwnedDocumentEvent::PageFileReferencesChanged {
                document_id: "document:test".to_owned(),
                generation: 2,
                head_seq: 9,
                change: PageFileReferenceChange::Exact {
                    added_file_ids: vec!["file:test".to_owned()],
                    removed_file_ids: Vec::new(),
                },
            }
        );
        assert_eq!(
            atoms[1].required_resources,
            [
                library("library:test"),
                ResourceKey::Document {
                    document_id: "document:test".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn mixed_database_event_is_split_into_exact_resource_atoms() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        let atoms = compile(
            &connection,
            "library:test",
            "project:test",
            CoreModuleEventPayload::Database(DatabaseEvent {
                kind: DatabaseEventKind::DatabaseChanged,
                project_id: Some("project:test".to_owned()),
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                page_ids: vec!["page:visible".to_owned(), "page:hidden".to_owned()],
                view_ids: Vec::new(),
                personal_view_changes: Vec::new(),
            }),
        )
        .expect("compile atoms");

        assert_eq!(atoms.len(), 2);
        for atom in atoms {
            assert_eq!(
                payload_claims(&atom.payload).unwrap(),
                atom.required_resources
            );
            assert_eq!(atom.required_resources.len(), 3);
        }
    }

    #[test]
    fn personal_database_event_is_view_authorized_without_shared_projection_ids() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        let change = DatabasePersonalViewChange::OccurrenceDisclosure {
            view_id: "view:personal".to_owned(),
            target: DatabaseViewDisclosureTarget::Page {
                occurrence_key: "ITEM_parent/child".to_owned(),
            },
            collapsed: true,
        };
        let atoms = compile(
            &connection,
            "library:test",
            "project:test",
            CoreModuleEventPayload::Database(DatabaseEvent {
                kind: DatabaseEventKind::DatabaseChanged,
                project_id: Some("project:test".to_owned()),
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                page_ids: Vec::new(),
                view_ids: Vec::new(),
                personal_view_changes: vec![change.clone()],
            }),
        )
        .expect("compile personal View atom");

        assert_eq!(atoms.len(), 1);
        assert!(atoms[0].required_resources.contains(&ResourceKey::View {
            view_id: "view:personal".to_owned(),
        }));
        let DeliveryAtomPayload::Database { event, .. } = &atoms[0].payload else {
            panic!("expected Database atom");
        };
        assert!(event.database_ids.is_empty());
        assert!(event.data_source_ids.is_empty());
        assert!(event.page_ids.is_empty());
        assert!(event.view_ids.is_empty());
        assert_eq!(event.personal_view_changes, vec![change]);
        assert_eq!(
            payload_claims(&atoms[0].payload).unwrap(),
            atoms[0].required_resources
        );
    }

    #[test]
    fn canvas_atom_declares_both_document_and_canvas_authority() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        connection
            .execute_batch(
                "CREATE TABLE blocks(id TEXT PRIMARY KEY, type TEXT NOT NULL);
                 CREATE TABLE canvas_owners(
                   block_id TEXT PRIMARY KEY,
                   library_id TEXT NOT NULL
                 );
                 CREATE TABLE block_documents(
                   block_id TEXT PRIMARY KEY,
                   document_id TEXT NOT NULL
                 );
                 INSERT INTO blocks(id, type) VALUES ('canvas:test', 'canvas');
                 INSERT INTO canvas_owners(block_id, library_id)
                 VALUES ('canvas:test', 'library:test');
                 INSERT INTO block_documents(block_id, document_id)
                 VALUES ('canvas:test', 'document:test');",
            )
            .expect("canvas ownership fixture");

        let atoms = compile(
            &connection,
            "library:test",
            "project:test",
            CoreModuleEventPayload::OwnedDocument(
                nodex_core_contracts::document::OwnedDocumentEvent::CanvasUpdated {
                    document_id: "document:test".to_owned(),
                    generation: 1,
                    base_head_seq: 0,
                    head_seq: 1,
                    scene_hash: "0".repeat(64),
                    mutation: serde_json::json!({"kind": "scene_changed"}),
                },
            ),
        )
        .expect("compile Canvas atom");

        assert_eq!(atoms.len(), 1);
        assert_eq!(
            atoms[0].required_resources,
            vec![
                ResourceKey::Library {
                    library_id: "library:test".to_owned(),
                },
                ResourceKey::Document {
                    document_id: "document:test".to_owned(),
                },
                ResourceKey::Canvas {
                    canvas_id: "canvas:test".to_owned(),
                },
            ]
        );
        assert_eq!(
            payload_claims(&atoms[0].payload).unwrap(),
            atoms[0].required_resources
        );
    }
}
