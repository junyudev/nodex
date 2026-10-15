use super::*;
use nodex_core_contracts::document::ContentRoutingContext as Display;
use nodex_core_contracts::library::{
    LibraryAgentSurface as Surface, LibraryAgentSurfaceDescription as Description,
    LibraryAgentSurfaceTarget as Target, LibraryAgentSurfaceViewTarget as ViewTarget,
    LibraryCanvasDestination, LibraryPageInsertion,
};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

pub(super) struct Fixture {
    _directory: tempfile::TempDir,
    pub(super) kernel: SqliteStoreKernel,
    pub(super) library: LibraryModule,
    workspace: ProjectWorkspaceModule,
    pub(super) authorization: AgentExecutionAuthorization,
}

pub(super) fn actor_context() -> BoundModuleContext {
    BoundModuleContext {
        project_id: Some(ProjectId("project:default".into())),
        ..context()
    }
}

impl Fixture {
    pub(super) fn new() -> Self {
        Self::with_actor(Some("project:default"))
    }

    pub(super) fn projectless() -> Self {
        Self::with_actor(None)
    }

    fn with_actor(actor_project_id: Option<&str>) -> Self {
        let directory = tempdir().unwrap();
        let kernel =
            SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
        kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                transaction.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)", [NOW])?;
                transaction.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)", [NOW])?;
                transaction.execute("INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)", [NOW])?;
                Ok(())
            })
        }).unwrap();
        let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap();
        workspace.seed_rootless_default_project_for_test();
        let fixture = Self {
            library: LibraryModule::new("profile-1", "library-1", &kernel),
            workspace,
            kernel,
            _directory: directory,
            authorization: AgentExecutionAuthorization {
                provenance: AgentTurnProvenance {
                    profile_id: "profile-1".into(),
                    authority: ProjectWorkspaceTurnAuthority {
                        thread_id: "thread:actor".into(),
                        turn_id: "turn:actor".into(),
                        root_thread_id: "thread:actor".into(),
                        actor_project_id: actor_project_id.map(str::to_owned),
                        library_id: "library-1".into(),
                        store_epoch: "epoch-1".into(),
                    },
                },
                call_id: "call:description".into(),
            },
        };
        fixture.workspace_apply(
            "actor-thread",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:actor".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(actor_project_id.map(str::to_owned)),
                    ..Default::default()
                }),
            },
        );
        fixture.workspace_apply(
            "freeze-turn",
            ProjectWorkspaceIntent::AdmitTurnAuthority {
                thread_id: "thread:actor".into(),
                turn_id: "turn:actor".into(),
                root_thread_id: "thread:actor".into(),
                actor_project_id: actor_project_id.map(str::to_owned),
            },
        );
        fixture.apply(
            "page",
            LibraryIntent::CreatePage {
                page_id: "page:target".into(),
                document_id: "document:target".into(),
                title: "Canonical Page".into(),
                parent: LibraryWriteParent::Library { before: None },
            },
        );
        fixture
    }

    pub(super) fn restart(self) -> Self {
        let Self {
            _directory,
            kernel,
            library,
            workspace,
            authorization,
        } = self;
        drop(library);
        drop(workspace);
        drop(kernel);
        let kernel =
            SqliteStoreKernel::open_test(&_directory.path().canonicalize().unwrap()).unwrap();
        Self {
            library: LibraryModule::new("profile-1", "library-1", &kernel),
            workspace: ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap(),
            kernel,
            _directory,
            authorization,
        }
    }

    pub(super) fn execution_context(&self) -> BoundModuleContext {
        BoundModuleContext {
            project_id: self
                .authorization
                .provenance
                .authority
                .actor_project_id
                .clone()
                .map(ProjectId),
            ..context()
        }
    }

    pub(super) fn workspace_apply(&self, operation: &str, intent: ProjectWorkspaceIntent) {
        self.workspace
            .apply(
                &self.execution_context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: operation.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent,
                },
            )
            .unwrap();
    }

    pub(super) fn apply(&self, operation: &str, intent: LibraryIntent) {
        self.library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent,
                },
            )
            .unwrap();
    }

    fn describe(
        &self,
        authorization: &AgentExecutionAuthorization,
        target: Target,
        display: Display,
    ) -> Description {
        let result = self
            .library
            .read(
                &self.execution_context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::AgentSurfaceDescription {
                        authorization: Box::new(authorization.clone()),
                        displayed_routing_context: display,
                        target,
                    },
                },
            )
            .unwrap();
        let LibraryReadValue::AgentSurfaceDescription { value } = result.value else {
            panic!("surface description")
        };
        value
    }
}

fn page() -> Target {
    Target::Page {
        page_id: "page:target".into(),
    }
}

#[test]
fn semantic_view_defaults_resolve_current_canonical_identity_with_independent_actor_access() {
    let fixture = Fixture::new();
    let display = Display::Project {
        project_id: "project:default".into(),
    };
    let target = Target::DatabaseView {
        target: ViewTarget::ProjectDefault,
    };
    let Description::Available {
        surface:
            Surface::DatabaseView {
                database_id,
                data_source_id,
                view_id,
                ..
            },
    } = fixture.describe(&fixture.authorization, target.clone(), display.clone())
    else {
        panic!("Project default View")
    };
    let database = DatabaseModule::new("profile-1", "library-1", &fixture.kernel);
    let DatabaseReadValue::View { value: view } = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::View {
                    view_id: view_id.clone(),
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("View definition")
    };
    database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "new-default-view".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PutView {
                    database_id: database_id.clone(),
                    data_source_id: data_source_id.clone(),
                    view_id: "01980000-0000-7000-8000-000000000008".into(),
                    expected_revision: 0,
                    name: "Current List".into(),
                    layout: DatabaseViewLayout::List,
                    definition: view.definition,
                    is_default: true,
                    before_view_id: None,
                }],
            },
        )
        .unwrap();
    for selector in [
        ViewTarget::ProjectDefault,
        ViewTarget::DatabaseDefault {
            database_id: database_id.clone(),
        },
        ViewTarget::View {
            view_id: "01980000-0000-7000-8000-000000000008".into(),
        },
    ] {
        let result = fixture.describe(
            &fixture.authorization,
            Target::DatabaseView { target: selector },
            display.clone(),
        );
        assert!(
            matches!(result, Description::Available { surface: Surface::DatabaseView { database_id: actual_database, data_source_id: actual_source, view_id, layout: DatabaseViewLayout::List, metadata } } if actual_database == database_id && actual_source == data_source_id && view_id == "01980000-0000-7000-8000-000000000008" && metadata.title == "Current List")
        );
    }
    fixture.apply(
        "foreign-database",
        LibraryIntent::CreateDatabase {
            database_id: "01980000-0000-7000-8000-000000000005".into(),
            data_source_id: "01980000-0000-7000-8000-000000000006".into(),
            view_id: "01980000-0000-7000-8000-000000000007".into(),
            name: "Foreign Database".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
    assert!(
        matches!(fixture.describe(&fixture.authorization, Target::DatabaseView {target: ViewTarget::DatabaseDefault {database_id:"01980000-0000-7000-8000-000000000005".into()}}, Display::Library), Description::Available {surface: Surface::DatabaseView {metadata, ..}} if metadata.library_id == "library-1")
    );
    assert_eq!(
        fixture.describe(&fixture.authorization, target, Display::Library),
        Description::Unavailable,
    );
}

#[test]
fn canvas_descriptions_follow_current_canonical_owners() {
    let fixture = Fixture::new();
    fixture.apply(
        "standalone-canvas",
        LibraryIntent::CreateCanvas {
            canvas_id: "01980000-0000-7000-8000-000000000001".into(),
            document_id: "01980000-0000-7000-8000-000000000002".into(),
            display_name: "Standalone Canvas".into(),
            destination: LibraryCanvasDestination::Library { before: None },
        },
    );
    fixture.apply(
        "embedded-canvas",
        LibraryIntent::CreateCanvas {
            canvas_id: "01980000-0000-7000-8000-000000000003".into(),
            document_id: "01980000-0000-7000-8000-000000000004".into(),
            display_name: "Embedded Canvas".into(),
            destination: LibraryCanvasDestination::Page {
                page_id: "page:target".into(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                insertion: LibraryPageInsertion::Append {
                    parent_block_id: None,
                },
            },
        },
    );
    let standalone = Target::Canvas {
        canvas_id: "01980000-0000-7000-8000-000000000001".into(),
    };
    let embedded = Target::Canvas {
        canvas_id: "01980000-0000-7000-8000-000000000003".into(),
    };
    for (target, title) in [
        (standalone, "Standalone Canvas"),
        (embedded, "Embedded Canvas"),
    ] {
        assert!(
            matches!(fixture.describe(&fixture.authorization, target, Display::Library), Description::Available { surface: Surface::Canvas {metadata, ..}} if metadata.title == title)
        );
    }
    let primary = Target::Canvas {
        canvas_id: crate::document::primary_canvas_block_id("project:default"),
    };
    assert!(matches!(
        fixture.describe(&fixture.authorization, primary, Display::Library),
        Description::Available {
            surface: Surface::Canvas { .. }
        }
    ));
}

#[test]
fn atomic_metadata_read_succeeds_when_document_bodies_and_database_rows_are_inaccessible() {
    let fixture = Fixture::new();
    fixture.apply(
        "full-access-canvas",
        LibraryIntent::CreateCanvas {
            canvas_id: "01980000-0000-7000-8000-000000000001".into(),
            document_id: "01980000-0000-7000-8000-000000000002".into(),
            display_name: "Full access Canvas".into(),
            destination: LibraryCanvasDestination::Library { before: None },
        },
    );
    let authorization = fixture.authorization.clone();
    fixture
        .kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            transaction.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "document_materializations",
                    column_name:
                        "nfm" | "plain_text" | "preview" | "references_json" | "asset_refs_json",
                }
                | AuthAction::Read {
                    table_name:
                        "document_updates"
                        | "document_snapshots"
                        | "canvas_scenes"
                        | "canvas_scene_elements"
                        | "canvas_scene_files"
                        | "data_source_page_memberships"
                        | "data_source_property_values"
                        | "database_view_order_rows",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))?;
            let result = [
                page(),
                Target::DatabaseView {
                    target: ViewTarget::ProjectDefault,
                },
                Target::Canvas {
                    canvas_id: "01980000-0000-7000-8000-000000000001".into(),
                },
            ]
            .into_iter()
            .map(|target| {
                super::super::agent_surface::describe(
                    &transaction,
                    "library-1",
                    &actor_context(),
                    &authorization,
                    Display::Project {
                        project_id: "project:default".into(),
                    },
                    target,
                )
            })
            .collect::<Result<Vec<_>, _>>();
            transaction.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            assert!(
                result?
                    .iter()
                    .all(|value| matches!(value, Description::Available { .. }))
            );
            transaction.commit()?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn descriptions_validate_execution_and_report_only_physical_availability() {
    let fixture = Fixture::new();
    assert!(
        matches!(fixture.describe(&fixture.authorization, page(), Display::Library), Description::Available { surface: Surface::Page {metadata, ..}} if metadata.title == "Canonical Page")
    );
    assert_eq!(
        fixture.describe(
            &fixture.authorization,
            Target::Page {
                page_id: "missing".into()
            },
            Display::Library
        ),
        Description::Unavailable
    );
    for field in ["turn", "epoch", "profile"] {
        let mut execution = fixture.authorization.clone();
        match field {
            "turn" => execution.provenance.authority.turn_id = "missing".into(),
            "epoch" => execution.provenance.authority.store_epoch = "stale".into(),
            _ => execution.provenance.profile_id = "foreign".into(),
        }
        assert!(
            fixture
                .library
                .read(
                    &fixture.execution_context(),
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read: LibraryRead::AgentSurfaceDescription {
                            authorization: Box::new(execution),
                            displayed_routing_context: Display::Library,
                            target: page()
                        }
                    }
                )
                .is_err()
        );
    }
}
