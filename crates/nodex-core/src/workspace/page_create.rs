//! Workspace resolves a new Page's content home and admits its Linked chat atomically.
use nodex_core_contracts::workspace::{
    ProjectWorkspaceCreatedPage, ProjectWorkspaceCreatedPagePlacement,
    ProjectWorkspacePageCreationTarget,
};
use nodex_core_contracts::{BoundModuleContext, ModuleName, ProjectionImpact};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::database::{PageCopyDataSourceDestination, page_copy_view_start_anchor};
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::library::page_genesis::{
    PageGenesisInput, create_page_at_library_start, create_page_in_data_source,
};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{
    WorkspaceMutationEffects, project_session_scope, seal_mutation_with_created_page,
    workspace_commit_result,
};
use super::session_mutation::{require_session, sqlite_now, validate_id};

struct ProjectPageHome {
    database_id: String,
    view_id: String,
    destination: PageCopyDataSourceDestination,
}

/// A Project's content home is exactly its primary Database's active default View and Source.
/// The Database binding follows Project lifecycle, so only an active Project has a home.
fn project_page_home(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<ProjectPageHome, StoreError> {
    super::session_lifecycle::require_project(connection, library_id, project_id, false)?;
    let lifecycle = connection.query_row(
        "SELECT lifecycle FROM projects WHERE id = ?1 AND library_id = ?2",
        params![project_id, library_id],
        |row| row.get::<_, String>(0),
    )?;
    if lifecycle != "active" {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Only an active Project accepts new Pages in its Database",
            false,
        ));
    }
    let (database_id, view_id, data_source_id, source_revision, view_revision) = connection.query_row(
        "SELECT container.block_id, view.id, source.id, source.schema_revision, view.revision \
         FROM project_database_bindings binding \
         JOIN database_containers container ON container.block_id = binding.database_block_id \
           AND container.library_id = binding.library_id AND container.lifecycle = 'active' \
         JOIN blocks block ON block.id = container.block_id AND block.lifecycle = 'active' \
         JOIN database_views view ON view.id = container.default_view_id \
           AND view.database_block_id = container.block_id AND view.lifecycle = 'active' \
         JOIN data_sources source ON source.id = view.data_source_id \
           AND source.home_database_block_id = container.block_id \
           AND source.library_id = binding.library_id AND source.lifecycle = 'active' \
         WHERE binding.project_id = ?1 AND binding.library_id = ?2 AND binding.lifecycle = 'active'",
        params![project_id, library_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, i64>(4)?,
        )),
    ).optional()?.ok_or_else(|| StoreError::new(
        StoreErrorCode::Conflict,
        "The Project has no usable primary Database with an active default View and Data Source",
        false,
    ))?;
    Ok(ProjectPageHome {
        database_id,
        view_id: view_id.clone(),
        destination: PageCopyDataSourceDestination {
            data_source_id,
            expected_data_source_revision: source_revision,
            // Omitted values preserve Source defaults, just like Agent create_pages.
            values: Vec::new(),
            view: Some(crate::database::PageCopyViewPlacement {
                before: page_copy_view_start_anchor(connection, &view_id)?,
                view_id,
                expected_view_revision: view_revision,
                group_key: None,
            }),
        },
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn create_page_for(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    target: &ProjectWorkspacePageCreationTarget,
    page_id: &str,
    document_id: &str,
    title: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    crate::library::validate_uuid_v7("page_id", page_id)?;
    crate::library::validate_uuid_v7("document_id", document_id)?;
    if title.len() > 10_000 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Page title exceeds its bound",
            false,
        ));
    }
    let (project_id, session) = match target {
        ProjectWorkspacePageCreationTarget::Project { project_id } => {
            validate_id("project_id", project_id)?;
            (Some(project_id.clone()), None)
        }
        ProjectWorkspacePageCreationTarget::Session { session_id } => {
            validate_id("session_id", session_id)?;
            let authority = require_session(connection, library_id, session_id)?;
            if authority.archived {
                return Err(StoreError::new(
                    StoreErrorCode::Conflict,
                    "Archived Project Sessions cannot add Linked chats",
                    false,
                ));
            }
            (authority.project_id.clone(), Some((session_id, authority)))
        }
    };
    let home = project_id
        .as_deref()
        .map(|project_id| project_page_home(connection, library_id, project_id))
        .transpose()?;
    let title = if title.trim().is_empty() {
        "Untitled"
    } else {
        title
    };
    let title_markdown = nodex_markdown::write_inline(&[nodex_markdown::Inline::Text {
        text: title.to_owned(),
        style: Default::default(),
    }]);
    let now = sqlite_now(connection)?;
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::ProjectWorkspace,
            module_name: "project_workspace",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let input = PageGenesisInput {
                context,
                commit_context: scope.evidence(),
                library_id,
                actor_project_id: project_id.as_deref(),
                operation_id,
                store_epoch,
                page_id,
                document_id,
                title_markdown: &title_markdown,
                markdown: "",
                now: &now,
            };
            let (page_create, document_head, view_ids, placement) = match &home {
                Some(home) => {
                    let created = create_page_in_data_source(connection, input, &home.destination)?;
                    (
                        created.page_create,
                        created.document_head,
                        created.affected_view_ids,
                        ProjectWorkspaceCreatedPagePlacement::DataSource {
                            database_id: home.database_id.clone(),
                            data_source_id: home.destination.data_source_id.clone(),
                            view_id: home.view_id.clone(),
                        },
                    )
                }
                None => {
                    let created = create_page_at_library_start(connection, input)?;
                    (
                        created.page_create,
                        created.document_head,
                        Vec::new(),
                        ProjectWorkspaceCreatedPagePlacement::Library {
                            library_id: library_id.to_owned(),
                        },
                    )
                }
            };
            if let Some((session_id, _)) = &session {
                super::page_chat::link_pages(connection, session_id, &[page_id.to_owned()], &now)?;
            }
            let database_ids = home
                .iter()
                .map(|home| home.database_id.clone())
                .collect::<Vec<_>>();
            let data_source_ids = home
                .iter()
                .map(|home| home.destination.data_source_id.clone())
                .collect::<Vec<_>>();
            let mut block_ids = vec![page_id.to_owned()];
            block_ids.extend(page_create.block_ids);
            // Library navigation has its own delivery atoms; Workspace invalidation alone does
            // not refresh Space content or the Database catalogs.
            append_change_log(
                connection,
                NewChangeLogEntry {
                    project_id: project_id.as_deref(),
                    store_epoch,
                    kind: "library.changed",
                    operation_id: Some(operation_id),
                    block_ids: &block_ids,
                    document_ids: &[document_id.to_owned()],
                    database_block_ids: &database_ids,
                    payload_json: &json!({
                        "module": "library", "operationKind": "create_page",
                        "affectedPageIds": [page_id], "affectedDatabaseIds": database_ids,
                        "affectedViewIds": view_ids,
                        "affectedParentKeys": [home.as_ref().map_or_else(
                            || format!("library:{library_id}"),
                            |home| format!("data_source:{}", home.destination.data_source_id))],
                    })
                    .to_string(),
                    projection_impact: &ProjectionImpact::None,
                    committed_at: &now,
                },
                scope.evidence(),
            )?;
            seal_mutation_with_created_page(
                scope,
                context,
                operation_id,
                WorkspaceMutationEffects {
                    operation_kind: "create_page_for",
                    project_catalog_change: None,
                    change_project_id: project_id.clone(),
                    project_ids: project_id.iter().cloned().collect(),
                    session_ids: session.iter().map(|(id, _)| (*id).clone()).collect(),
                    thread_ids: session
                        .iter()
                        .flat_map(|(_, authority)| authority.thread_id.iter().cloned())
                        .collect(),
                    session_summary_scopes: session
                        .iter()
                        .map(|_| project_session_scope(project_id.as_deref()))
                        .collect(),
                    session_detail_ids: session.iter().map(|(id, _)| (*id).clone()).collect(),
                    block_ids,
                    document_ids: vec![document_id.to_owned()],
                    database_ids,
                    page_ids: vec![page_id.to_owned()],
                    data_source_ids,
                    view_ids,
                    document_heads: vec![document_head],
                    committed_at: now.clone(),
                },
                Some(ProjectWorkspaceCreatedPage {
                    page_id: page_id.to_owned(),
                    project_id: project_id.clone(),
                    placement,
                    page_key: page_create.page_key,
                }),
            )
        },
    )?;
    workspace_commit_result(connection, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        TestWorkspace, apply, context, create_library_page, read, request, seeded_workspace,
    };
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue,
    };

    fn create(
        workspace: &TestWorkspace,
        operation: &str,
        target: ProjectWorkspacePageCreationTarget,
    ) -> ProjectWorkspaceApplyOutcome {
        workspace
            .module
            .apply(&context(), request(operation, intent(operation, target)))
            .expect("create Page for Workspace")
    }

    fn intent(
        operation: &str,
        target: ProjectWorkspacePageCreationTarget,
    ) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreatePageFor {
            target,
            page_id: crate::domain::identity::stable_uuid_v7(operation, "page", "test"),
            document_id: crate::domain::identity::stable_uuid_v7(operation, "document", "test"),
            title: "A **literal** title".to_owned(),
        }
    }

    fn project() -> ProjectWorkspacePageCreationTarget {
        ProjectWorkspacePageCreationTarget::Project {
            project_id: "project:lab".to_owned(),
        }
    }
    fn session(id: &str) -> ProjectWorkspacePageCreationTarget {
        ProjectWorkspacePageCreationTarget::Session {
            session_id: id.to_owned(),
        }
    }
    fn setup() -> TestWorkspace {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "create-lab",
            ProjectWorkspaceIntent::CreateProject {
                project_id: "project:lab".to_owned(),
                name: "Lab".to_owned(),
                description: String::new(),
                appearance: None,
                source_roots: vec!["/workspace/lab".to_owned()],
                page_key_prefix: Some("LAB".to_owned()),
            },
        );
        workspace
    }
    fn create_session(workspace: &TestWorkspace, id: &str, project_id: Option<&str>) {
        apply(
            &workspace.module,
            &format!("create-{id}"),
            ProjectWorkspaceIntent::CreateSession {
                session_id: id.to_owned(),
                project_id: project_id.map(str::to_owned),
                title: "New chat".to_owned(),
                initial_page_ids: Vec::new(),
            },
        );
    }
    fn created(outcome: &ProjectWorkspaceApplyOutcome) -> &ProjectWorkspaceCreatedPage {
        outcome
            .committed
            .value
            .created_page
            .as_ref()
            .expect("created Page receipt")
    }
    fn assert_source_page(workspace: &TestWorkspace, page: &ProjectWorkspaceCreatedPage) {
        let ProjectWorkspaceCreatedPagePlacement::DataSource {
            database_id,
            data_source_id,
            view_id,
        } = &page.placement
        else {
            panic!("Data Source placement")
        };
        assert!(
            page.page_key
                .as_ref()
                .is_some_and(|key| key.starts_with("LAB-"))
        );
        let home = project_page_home_for_test(workspace);
        assert_eq!(
            (database_id, data_source_id, view_id),
            (&home.0, &home.1, &home.2)
        );
        workspace.kernel.readers().read_default({
            let page = page.clone();
            move |connection| {
                let (parent, status, title) = connection.query_row(
                    "SELECT page.parent_id, value.value_json, model.title FROM pages page \
                     JOIN data_source_page_memberships membership ON membership.page_block_id=page.block_id AND membership.removed_at IS NULL \
                     JOIN data_source_property_values value ON value.membership_id=membership.id AND value.property_id='status' \
                     JOIN page_read_model model ON model.page_block_id=page.block_id WHERE page.block_id=?1",
                    [&page.page_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?)))?;
                assert_eq!(parent, home.1);
                assert_eq!(status, "\"triage\"");
                assert_eq!(title, "A **literal** title");
                let first = connection.query_row(&format!(
                    "SELECT membership.page_block_id FROM data_source_page_memberships membership {} \
                     WHERE membership.data_source_id=?2 AND membership.removed_at IS NULL \
                     ORDER BY {} LIMIT 1", crate::database::view_position_joins("?1", "membership.page_block_id"),
                    crate::database::view_order_rank("membership.page_block_id")),
                    params![home.2, home.1], |row| row.get::<_, String>(0))?;
                assert_eq!(first, page.page_id);
                Ok(())
            }
        }).expect("Source placement, defaults and order");
    }
    fn project_page_home_for_test(workspace: &TestWorkspace) -> (String, String, String) {
        workspace
            .kernel
            .readers()
            .read_default(|connection| {
                let home = project_page_home(connection, "library-1", "project:lab")?;
                Ok((
                    home.database_id,
                    home.destination.data_source_id,
                    home.view_id,
                ))
            })
            .expect("Project home")
    }
    fn edge_count(workspace: &TestWorkspace, session_id: &str) -> i64 {
        let session_id = session_id.to_owned();
        workspace
            .kernel
            .readers()
            .read_default(move |connection| {
                Ok(connection.query_row(
                    "SELECT count(*) FROM project_session_pages WHERE session_id=?1",
                    [session_id],
                    |row| row.get(0),
                )?)
            })
            .expect("Linked chats count")
    }
    fn page_exists(workspace: &TestWorkspace, operation: &str) -> bool {
        let page_id = crate::domain::identity::stable_uuid_v7(operation, "page", "test");
        workspace
            .kernel
            .readers()
            .read_default(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pages WHERE block_id=?1)",
                    [page_id],
                    |row| row.get(0),
                )?)
            })
            .expect("Page existence")
    }

    fn database_view(
        workspace: &TestWorkspace,
    ) -> nodex_core_contracts::database::DatabaseViewRecord {
        use nodex_core_contracts::database::{DatabaseRead, DatabaseReadValue};
        let (_, _, view_id) = project_page_home_for_test(workspace);
        let snapshot =
            crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel)
                .read(
                    &context(),
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                        read: DatabaseRead::View { view_id },
                    },
                )
                .expect("default View");
        let DatabaseReadValue::View { value } = snapshot.value else {
            panic!("View descriptor")
        };
        value
    }

    fn set_view_sort(
        workspace: &TestWorkspace,
        field: nodex_core_contracts::database::DatabaseViewSortField,
        direction: nodex_core_contracts::database::DatabaseViewSortDirection,
    ) {
        use nodex_core_contracts::database::{
            DatabaseIntent, DatabaseViewNullOrder, DatabaseViewSort,
        };
        let mut view = database_view(workspace);
        view.definition.rules.sorts = vec![DatabaseViewSort {
            field,
            direction,
            nulls: DatabaseViewNullOrder::Last,
        }];
        crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel)
            .apply(
                &context(),
                nodex_core_contracts::ModuleApplyRequest {
                    contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                    operation_id: format!("set-sort:{}", view.revision),
                    store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: view.database_id,
                        data_source_id: view.data_source_id,
                        view_id: view.view_id,
                        expected_revision: view.revision,
                        name: view.name,
                        layout: view.layout,
                        definition: view.definition,
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("change default View sorting");
    }

    #[test]
    fn new_page_appears_first_when_default_view_manual_order_is_descending() {
        use nodex_core_contracts::database::{
            DatabaseRead, DatabaseReadValue, DatabaseViewReadTarget, DatabaseViewSortDirection,
            DatabaseViewSortField,
        };
        let workspace = setup();
        create(&workspace, "older", project());
        create(&workspace, "old", project());
        set_view_sort(
            &workspace,
            DatabaseViewSortField::Manual,
            DatabaseViewSortDirection::Desc,
        );
        let outcome = create(&workspace, "new", project());
        let view = database_view(&workspace);
        let snapshot =
            crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel)
                .read(
                    &context(),
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                        read: DatabaseRead::ViewWindow {
                            target: DatabaseViewReadTarget::View {
                                view_id: view.view_id,
                            },
                            window: nodex_core_contracts::collection::CollectionWindowRequest {
                                after: None,
                                first: Some(10),
                            },
                            group_scope: None,
                        },
                    },
                )
                .expect("visible default View order");
        let DatabaseReadValue::ViewWindow { value } = snapshot.value else {
            panic!("View window")
        };
        assert_eq!(value.rows.items.len(), 3);
        assert_eq!(value.rows.items[0].page_id, created(&outcome).page_id);
    }

    #[test]
    fn non_manual_view_sorts_preserve_the_new_pages_manual_start_position() {
        use nodex_core_contracts::database::{DatabaseViewSortDirection, DatabaseViewSortField};
        let workspace = setup();
        create(&workspace, "older", project());
        for (operation, field) in [
            ("title-sorted", DatabaseViewSortField::Title),
            (
                "status-sorted",
                DatabaseViewSortField::Property {
                    property_id: "status".to_owned(),
                },
            ),
        ] {
            set_view_sort(&workspace, field, DatabaseViewSortDirection::Desc);
            let outcome = create(&workspace, operation, project());
            assert_source_page(&workspace, created(&outcome));
        }
    }

    #[test]
    fn exhausted_view_order_schedules_maintenance_and_retries_atomically() {
        let workspace = setup();
        create_session(&workspace, "session:lab", Some("project:lab"));
        for index in 0..145 {
            create(&workspace, &format!("dense-{index}"), project());
        }
        let (_, _, view_id) = project_page_home_for_test(&workspace);
        let pressure_view = view_id.clone();
        workspace.kernel.writer().call(move |connection| {
            crate::infrastructure::sqlite::with_immediate_transaction(connection, |transaction| {
                // Physical pressure fills the first rank interval beyond the bounded repair
                // neighborhood; every Page still came through the public creation command.
                let generation: i64 = transaction.query_row(
                    "SELECT active_generation FROM database_view_order_state WHERE view_id=?1",
                    [&pressure_view], |row| row.get(0))?;
                let ids = transaction.prepare(
                    "SELECT page_block_id FROM database_view_order_rows WHERE view_id=?1 AND generation=?2 ORDER BY rank_key, page_block_id")?
                    .query_map(params![pressure_view, generation], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(ids.len(), 145);
                for (index, page_id) in ids.iter().enumerate() {
                    transaction.execute(
                        "UPDATE database_view_order_rows SET rank_key=?4 WHERE view_id=?1 AND generation=?2 AND page_block_id=?3",
                        params![pressure_view, generation, page_id, format!("{:032x}", index + 1)])?;
                }
                Ok(())
            })
        }).expect("dense physical rank fixture");
        let operation = "retry-after-exhaustion";
        let error = workspace
            .module
            .apply(
                &context(),
                request(operation, intent(operation, session("session:lab"))),
            )
            .expect_err("rank space requires maintenance");
        assert_eq!(error.code, CoreErrorCode::MaintenanceInProgress);
        assert!(!page_exists(&workspace, operation));
        assert_eq!(edge_count(&workspace, "session:lab"), 0);
        workspace
            .kernel
            .readers()
            .read_default(move |connection| {
                let (phase, pending) = connection.query_row(
                "SELECT phase, pending_generation FROM database_view_order_state WHERE view_id=?1",
                [&view_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)))?;
                assert_eq!(
                    phase, "rebalance",
                    "failed Workspace transaction leaves durable preparation"
                );
                assert!(pending.is_some());
                Ok(())
            })
            .expect("pending order maintenance");
        let database =
            crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel);
        let idle = (0..32).any(|_| {
            !database
                .maintain_view_orders()
                .expect("maintain View order")
        });
        assert!(idle, "bounded fixture finishes maintenance");
        let retried = create(&workspace, operation, session("session:lab"));
        assert_source_page(&workspace, created(&retried));
        assert_eq!(created(&retried).page_key.as_deref(), Some("LAB-146"));
        assert_eq!(edge_count(&workspace, "session:lab"), 1);
    }

    #[test]
    fn project_page_starts_default_view_with_source_defaults_and_key() {
        let workspace = setup();
        create(&workspace, "old", project());
        let outcome = create(&workspace, "new", project());
        assert_source_page(&workspace, created(&outcome));
        assert_eq!(created(&outcome).page_key.as_deref(), Some("LAB-2"));
        let page_id = created(&outcome).page_id.clone();
        let event = outcome.event.expect("Workspace event");
        assert!(
            matches!(event.projection_impact, ProjectionImpact::Resources { page_ids, data_source_ids, view_ids, .. }
            if page_ids.contains(&page_id) && !data_source_ids.is_empty() && !view_ids.is_empty())
        );
    }

    #[test]
    fn archived_project_rejects_creation_without_falling_back_to_space() {
        let workspace = setup();
        create_session(&workspace, "session:lab", Some("project:lab"));
        apply(
            &workspace.module,
            "archive-lab",
            ProjectWorkspaceIntent::SetProjectLifecycle {
                project_id: "project:lab".to_owned(),
                lifecycle: nodex_core_contracts::workspace::ProjectLifecycle::Archived,
            },
        );
        // An archived Project's Sessions are unavailable, so only the Project itself can be named.
        for (operation, target, code) in [
            ("archived-project", project(), CoreErrorCode::Conflict),
            (
                "archived-project-session",
                session("session:lab"),
                CoreErrorCode::NotFound,
            ),
        ] {
            let error = workspace
                .module
                .apply(&context(), request(operation, intent(operation, target)))
                .expect_err("archived Project");
            assert_eq!(error.code, code);
            assert!(!page_exists(&workspace, operation));
        }
        assert_eq!(edge_count(&workspace, "session:lab"), 0);
    }

    #[test]
    fn session_in_project_creates_one_link_and_replays_the_original_result() {
        let workspace = setup();
        create_session(&workspace, "session:lab", Some("project:lab"));
        let first = create(&workspace, "linked", session("session:lab"));
        assert_source_page(&workspace, created(&first));
        let replay = create(&workspace, "linked", session("session:lab"));
        assert_eq!(created(&first), created(&replay));
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        assert_eq!(edge_count(&workspace, "session:lab"), 1);
        let ProjectWorkspaceReadValue::SessionLinkedPageSummaries { summaries, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::SessionLinkedPageSummaries {
                session_ids: vec!["session:lab".to_owned()],
            },
        ) else {
            panic!("linked summary")
        };
        assert_eq!(summaries[0].page.page_id, created(&first).page_id);
        let payload = first.event.expect("Workspace event").payload;
        let nodex_core_contracts::CoreModuleEventPayload::ProjectWorkspace(event) = payload else {
            panic!("Workspace invalidation")
        };
        assert_eq!(event.session_detail_ids, vec!["session:lab"]);
        assert_eq!(
            event.session_summary_scopes,
            vec![project_session_scope(Some("project:lab"))]
        );
        let mut changed = intent("linked", session("session:lab"));
        if let ProjectWorkspaceIntent::CreatePageFor { title, .. } = &mut changed {
            *title = "Changed".to_owned();
        }
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("linked", changed))
                .expect_err("reused identity")
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
    }

    #[test]
    fn projectless_session_page_is_first_library_root_with_link() {
        let workspace = setup();
        create_session(&workspace, "session:space", None);
        create_library_page(&workspace, "page:existing", "project:default");
        crate::library::LibraryModule::new("profile-1", "library-1", &workspace.kernel)
            .apply(&context(), nodex_core_contracts::ModuleApplyRequest {
                contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                operation_id: "archive-existing".to_owned(),
                store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".to_owned()),
                intent: nodex_core_contracts::library::LibraryIntent::ApplyPageLifecycle {
                    mutation: Box::new(nodex_core_contracts::library::LibraryPageLifecycleMutation::ArchivePage {
                        page_id: "page:existing".to_owned(), expected_metadata_revision: 1,
                    }),
                },
            }).expect("archive the first Library root");
        let result = create(&workspace, "space", session("session:space"));
        let page = created(&result);
        assert_eq!(
            page.placement,
            ProjectWorkspaceCreatedPagePlacement::Library {
                library_id: "library-1".to_owned()
            }
        );
        assert_eq!(page.page_key, None);
        assert_eq!(edge_count(&workspace, "session:space"), 1);
        let page_id = page.page_id.clone();
        workspace.kernel.readers().read_default(move |connection| {
            let (first, parent_kind) = connection.query_row(
                "SELECT placement.block_id, page.parent_kind FROM library_block_placements placement \
                 JOIN pages page ON page.block_id=placement.block_id WHERE placement.library_id='library-1' \
                 ORDER BY placement.rank_key, placement.block_id LIMIT 1", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            assert_eq!(first, page_id);
            assert_eq!(parent_kind, "library");
            Ok(())
        }).expect("Library root order");
    }

    #[test]
    fn archived_session_rejects_creation_without_page_or_link() {
        let workspace = setup();
        create_session(&workspace, "session:archived", Some("project:lab"));
        apply(
            &workspace.module,
            "archive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:archived".to_owned(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        let error = workspace
            .module
            .apply(
                &context(),
                request("rejected", intent("rejected", session("session:archived"))),
            )
            .expect_err("archived Session");
        assert_eq!(error.code, CoreErrorCode::Conflict);
        assert_eq!(
            error.message,
            "Archived Project Sessions cannot add Linked chats"
        );
        assert!(!page_exists(&workspace, "rejected"));
        assert_eq!(edge_count(&workspace, "session:archived"), 0);
    }

    #[test]
    fn missing_project_or_session_is_not_found() {
        let workspace = setup();
        for (operation, target) in [
            (
                "missing-project",
                ProjectWorkspacePageCreationTarget::Project {
                    project_id: "project:missing".to_owned(),
                },
            ),
            ("missing-session", session("session:missing")),
        ] {
            assert_eq!(
                workspace
                    .module
                    .apply(&context(), request(operation, intent(operation, target)))
                    .expect_err("missing target")
                    .code,
                CoreErrorCode::NotFound
            );
            assert!(!page_exists(&workspace, operation));
        }
    }

    #[test]
    fn unusable_default_view_rejects_creation_without_falling_back() {
        let workspace = setup();
        workspace.kernel.writer().call(|connection| {
            connection.execute("UPDATE database_containers SET default_view_id=NULL WHERE block_id=(SELECT database_block_id FROM project_database_bindings WHERE project_id='project:lab')", [])?;
            Ok(())
        }).expect("default View unavailable");
        let error = workspace
            .module
            .apply(&context(), request("no-home", intent("no-home", project())))
            .expect_err("unusable home");
        assert_eq!(error.code, CoreErrorCode::Conflict);
        assert!(error.message.contains("primary Database"));
        assert!(!page_exists(&workspace, "no-home"));
    }
}
