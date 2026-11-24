use std::collections::HashSet;
use std::env;
use std::path::PathBuf;
use std::time::Duration;

use nodex_core_contracts::collection::{CollectionWindowRequest, MAX_COLLECTION_WINDOW_JSON_BYTES};
use nodex_core_contracts::database::{
    DatabaseIntent, DatabaseRead, DatabaseRowsTarget, DatabaseViewReadTarget,
};
use nodex_core_contracts::library::{LibraryIntent, LibraryWriteParent};
use nodex_core_contracts::workspace::{ProjectWorkspaceRead, ProjectWorkspaceReadValue};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, DATABASE_CONTRACT_VERSION, LibraryId, ModuleApplyRequest,
    ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, ProjectId, StoreEpoch,
};
use nodex_core_protocol::MAX_ORDINARY_JSON_RESPONSE_BYTES;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::database::DatabaseModule;
use crate::document::PAGE_SCHEMA_VERSION;
use crate::domain::fractional_rank::evenly_spaced_rank;
use crate::infrastructure::sqlite::{QueryCancellation, with_immediate_transaction};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::library::LibraryModule;
use crate::workspace::ProjectWorkspaceModule;

const PROFILE_ID: &str = "profile:read-budget-gate";
const LIBRARY_ID: &str = "library:read-budget-gate";
const PROJECT_COUNT: usize = 50;
const SESSION_COUNT: usize = 10_000;
const THREAD_COUNT: usize = 12_000;
const DATABASE_ROW_COUNT: usize = 20_000;
const PROJECT_ID: &str = "project:000";
const SIDEBAR_SECTION_ID: &str = "section:read-budget-gate";
const DATABASE_ID: &str = "018f2000-0000-7000-8000-000000000001";
const DATA_SOURCE_ID: &str = "018f2000-0000-7000-8000-000000000002";
const VIEW_ID: &str = "018f2000-0000-7000-8000-000000000003";
const NOW: &str = "2026-07-25T12:00:00.000Z";
const TITLE_RICH_HASH: &str = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const FIXTURE_SEED_BUDGET: Duration = Duration::from_secs(60);

fn profile_home() -> PathBuf {
    let value = env::var_os("NODEX_READ_BUDGET_GATE_PROFILE")
        .expect("NODEX_READ_BUDGET_GATE_PROFILE must name the disposable gate Profile");
    let path = PathBuf::from(value);
    assert!(path.is_absolute(), "gate Profile path must be absolute");
    path
}

fn context() -> BoundModuleContext {
    BoundModuleContext {
        actor: nodex_core_contracts::Actor::Service {
            kind: nodex_core_contracts::ServiceKind::Maintenance,
        },
        authorizing_member_id: None,
        editor_history_owner: None,
        principal: None,
        agent_attribution: None,
        profile_id: ProfileId(PROFILE_ID.to_owned()),
        library_id: LibraryId(LIBRARY_ID.to_owned()),
        project_id: Some(ProjectId(PROJECT_ID.to_owned())),
        connection_id: "connection:read-budget-gate".to_owned(),
        adapter: AdapterKind::Test,
    }
}

fn seed_identity_and_workspace(kernel: &SqliteStoreKernel, include_workspace: bool) {
    kernel
        .writer()
        .call(move |connection| {
            with_immediate_transaction(connection, |transaction| {
                transaction.execute(
                    "INSERT INTO profiles(id, created_at, updated_at) VALUES (?1, ?2, ?2)",
                    params![PROFILE_ID, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?3)",
                    params![LIBRARY_ID, PROFILE_ID, NOW],
                )?;
                transaction.execute(
                    "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                     VALUES (1, 'epoch:read-budget-gate', ?1, ?1)",
                    [NOW],
                )?;

                {
                    let mut insert_project = transaction.prepare(
                        "INSERT INTO projects(\
                           id, library_id, lifecycle, binding_revision, name, description, \
                           created, updated\
                         ) VALUES (?1, ?2, 'active', 1, ?3, '', ?4, ?4)",
                    )?;
                    let mut insert_order = transaction.prepare(
                        "INSERT INTO project_order(project_id, \"order\", updated) \
                         VALUES (?1, ?2, ?3)",
                    )?;
                    for index in 0..PROJECT_COUNT {
                        let project_id = format!("project:{index:03}");
                        insert_project.execute(params![
                            project_id,
                            LIBRARY_ID,
                            format!("Scale Project {index:03}"),
                            NOW
                        ])?;
                        insert_order.execute(params![project_id, index as i64, NOW])?;
                    }
                }

                if !include_workspace {
                    return Ok(());
                }

                let preview = format!("多字节预览🚀{}", "界".repeat(330));
                let thread_name = "T".repeat(256);
                let cwd = format!("/workspace/{}", "w".repeat(500));
                {
                    let mut insert_thread = transaction.prepare(
                        "INSERT INTO codex_threads(\
                           thread_id, project_id, thread_name, thread_preview, cwd, \
                           status_type, status_active_flags_json, archived, created_at, updated_at, \
                           linked_at\
                         ) VALUES (?1, ?2, ?3, ?4, ?5, 'idle', '[]', 0, ?6, ?6, ?7)",
                    )?;
                    for index in 0..THREAD_COUNT {
                        let project_id = format!("project:{:03}", index % PROJECT_COUNT);
                        insert_thread.execute(params![
                            format!("thread:{index:05}"),
                            project_id,
                            thread_name,
                            preview,
                            cwd,
                            index as i64 + 1,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut insert_session = transaction.prepare(
                        "INSERT INTO project_sessions(\
                           id, project_id, no_thread_fallback_title, activity_at, \
                           archived, archived_at, created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, CAST(round(unixepoch(?5, 'subsec') * 1000) AS INTEGER) + ?4, 0, NULL, ?5, ?5)",
                    )?;
                    let mut link_thread = transaction.prepare(
                        "INSERT INTO project_session_threads(session_id, thread_id, linked_at) \
                         VALUES (?1, ?2, ?3)",
                    )?;
                    for index in 0..SESSION_COUNT {
                        let session_id = format!("session:{index:05}");
                        insert_session.execute(params![
                            session_id,
                            PROJECT_ID,
                            format!("Scale task {index:05}"),
                            index as i64,
                            NOW
                        ])?;
                        link_thread.execute(params![
                            session_id,
                            format!("thread:{index:05}"),
                            NOW
                        ])?;
                    }
                }
                transaction.execute(
                    "INSERT INTO workspace_sidebar_sections(\
                       section_id, library_id, kind, name, rank_key, revision, lifecycle, \
                       deleted_at, created_at, updated_at\
                     ) VALUES (?1, ?2, 'custom', 'Scale Section', 2000000000000, 1, \
                       'active', NULL, ?3, ?3)",
                    params![SIDEBAR_SECTION_ID, LIBRARY_ID, NOW],
                )?;
                {
                    let mut insert_placement = transaction.prepare(
                        "INSERT INTO workspace_sidebar_section_items(\
                           placement_id, library_id, section_id, section_kind, project_id, \
                           session_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'custom', NULL, ?4, ?5, 1, ?6, ?6)",
                    )?;
                    for index in 0..SESSION_COUNT {
                        let session_id = format!("session:{index:05}");
                        insert_placement.execute(params![
                            format!("session:{session_id}"),
                            LIBRARY_ID,
                            SIDEBAR_SECTION_ID,
                            session_id,
                            index as i64,
                            NOW
                        ])?;
                    }
                }
                Ok(())
            })
        })
        .expect("seed large Workspace fixture");
}

fn create_database(kernel: &SqliteStoreKernel) {
    let library = LibraryModule::new(PROFILE_ID, LIBRARY_ID, kernel);
    library
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                operation_id: "operation:read-budget-create-database".to_owned(),
                store_epoch: StoreEpoch("epoch:read-budget-gate".to_owned()),
                intent: LibraryIntent::CreateDatabase {
                    database_id: DATABASE_ID.to_owned(),
                    data_source_id: DATA_SOURCE_ID.to_owned(),
                    view_id: VIEW_ID.to_owned(),
                    name: "Large Database".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .expect("create canonical Database authority");
    kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "UPDATE projects SET database_block_id = ?1 WHERE id = ?2",
                params![DATABASE_ID, PROJECT_ID],
            )?;
            Ok(())
        })
        .expect("bind primary Database");
}

fn seed_database_rows(kernel: &SqliteStoreKernel, row_count: usize) {
    seed_grouped_database_rows(kernel, row_count, &["triage", "doing", "done"], 1_500);
}

fn seed_grouped_database_rows(
    kernel: &SqliteStoreKernel,
    row_count: usize,
    statuses: &'static [&str],
    body_bytes: usize,
) {
    kernel
        .writer()
        .call_with_budget(
            FIXTURE_SEED_BUDGET * if row_count > DATABASE_ROW_COUNT { 3 } else { 1 },
            QueryCancellation::new(),
            move |connection| with_immediate_transaction(connection, |transaction| {
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO documents(\
                           id, library_id, generation, head_seq, schema_key, schema_version, \
                           state_vector, state_hash, readiness, authority, created_at, updated_at\
                         ) VALUES (?1, ?2, 1, 0, 'nodex.page', ?4, X'', '', 'pending_genesis', \
                           'legacy_shadow', ?3, ?3)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            format!("document:scale:{index:05}"),
                            LIBRARY_ID,
                            NOW,
                            PAGE_SCHEMA_VERSION
                        ])?;
                    }
                }
                transaction.execute(
                    "INSERT INTO page_key_namespaces(\
                       database_block_id, library_id, next_number, revision, created_at, updated_at\
                     ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                    params![
                        DATABASE_ID,
                        LIBRARY_ID,
                        i64::try_from(row_count).expect("row count fits i64") + 1,
                        NOW
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO page_key_prefixes(\
                       library_id, normalized_prefix, database_block_id, last_number, revision, \
                       activated_at, retired_at\
                     ) VALUES (?1, 'SCALE', ?2, NULL, 1, ?3, NULL)",
                    params![LIBRARY_ID, DATABASE_ID, NOW],
                )?;
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO blocks(\
                           id, library_id, type, lifecycle, placement_revision, \
                           metadata_revision, created_at, updated_at\
                         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            format!("page:scale:{index:05}"),
                            LIBRARY_ID,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO block_documents(\
                           block_id, document_id, library_id, created_at\
                         ) VALUES (?1, ?2, ?3, ?4)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            format!("page:scale:{index:05}"),
                            format!("document:scale:{index:05}"),
                            LIBRARY_ID,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO pages(\
                           block_id, library_id, document_id, parent_kind, parent_id, \
                           created_at, updated_at\
                         ) VALUES (?1, ?2, ?3, 'data_source', ?4, ?5, ?5)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            format!("page:scale:{index:05}"),
                            LIBRARY_ID,
                            format!("document:scale:{index:05}"),
                            DATA_SOURCE_ID,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO document_materializations(\
                           document_id, generation, projected_seq, schema_version, title, \
                           title_rich_json, title_rich_hash, markdown, plain_text, preview, \
                           block_tree_json, references_json, asset_refs_json, updated_at\
                         ) VALUES (?1, 1, 0, ?7, ?2, '[]', ?3, ?4, ?4, ?5, '[]', '[]', '[]', ?6)",
                    )?;
                    for index in 0..row_count {
                        let title = format!("Scale row {index:05}");
                        let body = format!(
                            "# {title}\n\nBODY-SENTINEL-{index:05}-{}",
                            "x".repeat(body_bytes)
                        );
                        statement.execute(params![
                            format!("document:scale:{index:05}"),
                            title,
                            TITLE_RICH_HASH,
                            body,
                            format!("摘要🚀 {index:05}"),
                            NOW,
                            PAGE_SCHEMA_VERSION
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO data_source_page_memberships(\
                           id, data_source_id, page_block_id, revision, created_at, removed_at\
                         ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            format!("membership:scale:{index:05}"),
                            DATA_SOURCE_ID,
                            format!("page:scale:{index:05}"),
                            NOW
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO page_key_assignments(\
                           database_block_id, page_block_id, number, assigned_at\
                         ) VALUES (?1, ?2, ?3, ?4)",
                    )?;
                    for index in 0..row_count {
                        statement.execute(params![
                            DATABASE_ID,
                            format!("page:scale:{index:05}"),
                            i64::try_from(index).expect("row index fits i64") + 1,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut insert_status = transaction.prepare(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, ?2, 'status', 'select', ?3, 1, ?4)",
                    )?;
                    let mut insert_task_parent = transaction.prepare(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, ?2, 'task_parent', 'relation', 'null', 1, ?3)",
                    )?;
                    for index in 0..row_count {
                        let status = json!(statuses[index % statuses.len()]).to_string();
                        let membership_id = format!("membership:scale:{index:05}");
                        insert_status.execute(params![
                            DATA_SOURCE_ID,
                            membership_id,
                            status,
                            NOW
                        ])?;
                        insert_task_parent.execute(params![DATA_SOURCE_ID, membership_id, NOW])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO database_view_order_rows(\
                           view_id, generation, page_block_id, rank_key, revision, is_active, is_task_root, created_at, updated_at\
                         ) VALUES (?1, (SELECT active_generation FROM database_view_order_state WHERE view_id = ?1), ?2, ?3, 1, 1, 1, ?4, ?4)",
                    )?;
                    for index in 0..row_count {
                        let rank_key = evenly_spaced_rank(index, row_count);
                        statement.execute(params![
                            VIEW_ID,
                            format!("page:scale:{index:05}"),
                            rank_key,
                            NOW
                        ])?;
                    }
                }
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO page_read_model(\
                           page_block_id, library_id, lifecycle, parent_kind, parent_id, \
                           library_rank_key, placement_revision, metadata_revision, document_id, document_generation, \
                           document_projected_seq, document_schema_version, document_authority, \
                           membership_id, database_block_id, view_id, view_group_key, view_rank_key, \
                           title, description_preview, description_length, has_description, \
                           database_values_json, intrinsic_properties_json, \
                           property_revisions_json, projection_version, created_at, updated_at\
                         ) VALUES (?1, ?2, 'active', 'data_source', ?3, NULL, 1, 1, ?4, 1, 0, \
                           ?14, 'legacy_shadow', ?5, ?6, ?7, ?8, ?9, ?10, ?11, 10, 1, ?12, '{}', \
                           '{\"status\":1,\"task_parent\":1}', 1, ?13, ?13)",
                    )?;
                    for index in 0..row_count {
                        let status = statuses[index % statuses.len()];
                        let rank_key = evenly_spaced_rank(index, row_count);
                        statement.execute(params![
                            format!("page:scale:{index:05}"),
                            LIBRARY_ID,
                            DATA_SOURCE_ID,
                            format!("document:scale:{index:05}"),
                            format!("membership:scale:{index:05}"),
                            DATABASE_ID,
                            VIEW_ID,
                            status,
                            rank_key,
                            format!("Scale row {index:05}"),
                            format!("摘要🚀 {index:05}"),
                            format!("{{\"status\":\"{status}\"}}"),
                            NOW,
                            PAGE_SCHEMA_VERSION
                        ])?;
                    }
                }
                Ok(())
            }),
        )
        .expect("seed large Database fixture");
}

fn legacy_thread_payload_bytes(connection: &Connection) -> usize {
    let rows = connection
        .prepare(
            "SELECT thread_id, project_id, thread_name, thread_preview, cwd, status_type, \
               status_active_flags_json, created_at, updated_at FROM codex_threads ORDER BY thread_id",
        )
        .expect("legacy Thread query")
        .query_map([], |row| {
            Ok(json!({
                "threadId": row.get::<_, String>(0)?,
                "projectId": row.get::<_, Option<String>>(1)?,
                "threadName": row.get::<_, Option<String>>(2)?,
                "threadPreview": row.get::<_, String>(3)?,
                "cwd": row.get::<_, Option<String>>(4)?,
                "statusType": row.get::<_, String>(5)?,
                "statusActiveFlags": row.get::<_, String>(6)?,
                "createdAt": row.get::<_, i64>(7)?,
                "updatedAt": row.get::<_, i64>(8)?,
            }))
        })
        .expect("legacy Thread rows")
        .collect::<rusqlite::Result<Vec<Value>>>()
        .expect("legacy Thread payload");
    serde_json::to_vec(&rows)
        .expect("serialize legacy Thread payload")
        .len()
}

fn legacy_database_payload_bytes(connection: &Connection) -> usize {
    let rows = connection
        .prepare(
            "SELECT model.page_block_id, model.title, materialization.markdown, \
               materialization.plain_text, model.database_values_json \
             FROM page_read_model model \
             JOIN document_materializations materialization \
               ON materialization.document_id = model.document_id \
             WHERE model.view_id = ?1 ORDER BY model.page_block_id",
        )
        .expect("legacy Database query")
        .query_map([VIEW_ID], |row| {
            Ok(json!({
                "pageId": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "bodyMarkdown": row.get::<_, String>(2)?,
                "plainText": row.get::<_, String>(3)?,
                "values": row.get::<_, String>(4)?,
            }))
        })
        .expect("legacy Database rows")
        .collect::<rusqlite::Result<Vec<Value>>>()
        .expect("legacy Database payload");
    serde_json::to_vec(&rows)
        .expect("serialize legacy Database payload")
        .len()
}

fn assert_store_health(connection: &Connection) {
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .expect("integrity check");
    assert_eq!(integrity, "ok");
    let foreign_key_violations = connection
        .prepare("PRAGMA foreign_key_check")
        .expect("foreign key check")
        .query_map([], |_| Ok(()))
        .expect("foreign key rows")
        .count();
    assert_eq!(foreign_key_violations, 0);

    let plan = connection
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT page_block_id FROM database_view_order_rows \
             WHERE view_id = ?1 AND generation = (SELECT active_generation FROM database_view_order_state WHERE view_id = ?1) AND is_active = 1 \
             ORDER BY rank_key, page_block_id LIMIT 201",
        )
        .expect("prepare Database View order query plan")
        .query_map([VIEW_ID], |row| row.get::<_, String>(3))
        .expect("read Database View order query plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect Database View order query plan")
        .join("\n");
    assert!(
        plan.contains("idx_database_view_order_active"),
        "Database View window order lost its covering index:\n{plan}",
    );
    assert!(
        !plan.contains("USE TEMP B-TREE"),
        "Database View window order regressed to a temporary sort:\n{plan}",
    );

    let page_key_plan = connection
        .prepare(
            "EXPLAIN QUERY PLAN \
             SELECT assignment.number, prefix.normalized_prefix \
             FROM data_source_page_memberships membership \
             LEFT JOIN page_key_assignments assignment \
               ON assignment.database_block_id = ?1 \
              AND assignment.page_block_id = membership.page_block_id \
             LEFT JOIN page_key_prefixes prefix \
               ON prefix.database_block_id = assignment.database_block_id \
              AND prefix.retired_at IS NULL \
             WHERE membership.data_source_id = ?2 \
               AND membership.removed_at IS NULL \
             LIMIT 201",
        )
        .expect("prepare populated Page-key query plan")
        .query_map(params![DATABASE_ID, DATA_SOURCE_ID], |row| {
            row.get::<_, String>(3)
        })
        .expect("read populated Page-key query plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect populated Page-key query plan")
        .join("\n");
    assert!(
        page_key_plan.contains("SEARCH assignment USING PRIMARY KEY"),
        "Page-key assignment lookup lost its composite primary key:\n{page_key_plan}",
    );
    assert!(
        page_key_plan.contains("SEARCH prefix USING COVERING INDEX")
            && (page_key_plan.contains("idx_page_key_prefixes_current_database")
                || page_key_plan.contains("idx_page_key_prefixes_database_history")),
        "Current Page-key prefix lookup lost its Database/current-prefix index:\n{page_key_plan}",
    );
    assert!(
        !page_key_plan.contains("USE TEMP B-TREE"),
        "Page-key projection introduced a temporary sort:\n{page_key_plan}",
    );
}

fn assert_sidebar_section_window_budget(workspace: &ProjectWorkspaceModule) {
    let first = workspace
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::SidebarSectionItemWindow {
                    section_id: SIDEBAR_SECTION_ID.to_owned(),
                    include_archived: Some(false),
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(200),
                    },
                },
            },
        )
        .expect("read first Sidebar Section item window");
    let ProjectWorkspaceReadValue::SidebarSectionItemWindow {
        items: first_window,
    } = &first.value
    else {
        panic!("Workspace returned the wrong Sidebar Section window");
    };
    assert_eq!(first_window.items.len(), 200);
    assert!(
        serde_json::to_vec(&first)
            .expect("serialize Sidebar Section item window")
            .len()
            < MAX_COLLECTION_WINDOW_JSON_BYTES
    );
    let cursor = first_window
        .next_cursor
        .clone()
        .expect("Sidebar Section continuation");
    let first_placement_ids = first_window
        .items
        .iter()
        .map(|item| item.placement_id.as_str())
        .collect::<HashSet<_>>();
    let second = workspace
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::SidebarSectionItemWindow {
                    section_id: SIDEBAR_SECTION_ID.to_owned(),
                    include_archived: Some(false),
                    window: CollectionWindowRequest {
                        after: Some(cursor),
                        first: Some(200),
                    },
                },
            },
        )
        .expect("read second Sidebar Section item window");
    let ProjectWorkspaceReadValue::SidebarSectionItemWindow {
        items: second_window,
    } = second.value
    else {
        panic!("Workspace returned the wrong Sidebar Section continuation");
    };
    assert_eq!(second_window.items.len(), 200);
    assert!(
        second_window
            .items
            .iter()
            .all(|item| !first_placement_ids.contains(item.placement_id.as_str()))
    );
}

#[test]
#[ignore = "explicit Sidebar Section large-data reliability gate"]
fn sidebar_section_large_window_budget() {
    let home = profile_home();
    let kernel = SqliteStoreKernel::open_test(&home).expect("open disposable gate Profile");
    seed_identity_and_workspace(&kernel, true);
    let workspace = ProjectWorkspaceModule::new(PROFILE_ID, LIBRARY_ID, &kernel)
        .expect("open Workspace module");
    assert_sidebar_section_window_budget(&workspace);
}

#[test]
#[ignore = "explicit large-data reliability gate"]
fn read_budget_gate_large_fixture() {
    let home = profile_home();
    let kernel = SqliteStoreKernel::open_test(&home).expect("open disposable gate Profile");
    seed_identity_and_workspace(&kernel, true);
    create_database(&kernel);
    seed_database_rows(&kernel, DATABASE_ROW_COUNT);

    let workspace = ProjectWorkspaceModule::new(PROFILE_ID, LIBRARY_ID, &kernel)
        .expect("open Workspace module");
    let database = DatabaseModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
    let first_workspace = workspace
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::TaskWindow {
                    project_id: Some(PROJECT_ID.to_owned()),
                    whole_library: false,
                    include_archived: Some(false),
                    placement_scope: Default::default(),
                    lifecycle: Default::default(),
                    order: Default::default(),
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(200),
                    },
                },
            },
        )
        .expect("read first Workspace window");
    let ProjectWorkspaceReadValue::TaskWindow {
        tasks: workspace_window,
    } = &first_workspace.value
    else {
        panic!("Workspace returned the wrong window");
    };
    let workspace_bytes = serde_json::to_vec(&first_workspace)
        .expect("serialize Workspace window")
        .len();
    assert!(workspace_bytes < MAX_COLLECTION_WINDOW_JSON_BYTES);
    assert!(!workspace_window.items.is_empty());
    let workspace_cursor = workspace_window
        .next_cursor
        .clone()
        .expect("Workspace continuation");
    let second_workspace = workspace
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::TaskWindow {
                    project_id: Some(PROJECT_ID.to_owned()),
                    whole_library: false,
                    include_archived: Some(false),
                    placement_scope: Default::default(),
                    lifecycle: Default::default(),
                    order: Default::default(),
                    window: CollectionWindowRequest {
                        after: Some(workspace_cursor),
                        first: Some(200),
                    },
                },
            },
        )
        .expect("read second Workspace window");
    let ProjectWorkspaceReadValue::TaskWindow {
        tasks: second_workspace_window,
    } = second_workspace.value
    else {
        panic!("Workspace returned the wrong continuation");
    };
    let first_task_ids = workspace_window
        .items
        .iter()
        .map(|task| task.session.id.as_str())
        .collect::<HashSet<_>>();
    assert!(
        second_workspace_window
            .items
            .iter()
            .all(|task| !first_task_ids.contains(task.session.id.as_str()))
    );

    assert_sidebar_section_window_budget(&workspace);

    let first_database = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(200),
                    },
                    group_scope: None,
                },
            },
        )
        .expect("read first Database window");
    let nodex_core_contracts::database::DatabaseReadValue::ViewWindow {
        value: database_window,
    } = &first_database.value
    else {
        panic!("Database returned the wrong window");
    };
    let database_bytes = serde_json::to_vec(&first_database)
        .expect("serialize Database window")
        .len();
    assert!(database_bytes < MAX_COLLECTION_WINDOW_JSON_BYTES);
    assert_eq!(
        database_window.rows.items.len(),
        200,
        "full Database window"
    );
    let encoded_database = serde_json::to_string(&first_database).expect("encode Database window");
    assert!(!encoded_database.contains("BODY-SENTINEL"));
    assert!(
        database_window.rows.items.iter().all(|row| row
            .page_key
            .as_deref()
            .is_some_and(|key| key.starts_with("SCALE-"))),
        "populated Page-key assignments must survive the production View window",
    );
    let database_cursor = database_window
        .rows
        .next_cursor
        .clone()
        .expect("Database continuation");
    let first_database_ids = database_window
        .rows
        .items
        .iter()
        .map(|row| row.page_id.clone())
        .collect::<HashSet<_>>();
    let second_database = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: Some(database_cursor.clone()),
                        first: Some(200),
                    },
                    group_scope: None,
                },
            },
        )
        .expect("read second Database window");
    let nodex_core_contracts::database::DatabaseReadValue::ViewWindow {
        value: second_database_window,
    } = second_database.value
    else {
        panic!("Database returned the wrong continuation");
    };
    assert!(
        second_database_window
            .rows
            .items
            .iter()
            .all(|row| !first_database_ids.contains(&row.page_id))
    );

    let rows_by_id = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::RowsById {
                    target: DatabaseRowsTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    page_ids: vec!["page:scale:00000".to_owned(), "page:scale:19999".to_owned()],
                },
            },
        )
        .expect("read exact Database rows");
    let nodex_core_contracts::database::DatabaseReadValue::RowsById { value } = rows_by_id.value
    else {
        panic!("Database returned the wrong rows-by-id value");
    };
    assert_eq!(value.rows.len(), 2);
    assert_eq!(
        value
            .rows
            .iter()
            .map(|row| row.page_id.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from(["page:scale:00000", "page:scale:19999"])
    );

    let detail = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::RowDetail {
                    page_id: "page:scale:19999".to_owned(),
                },
            },
        )
        .expect("read Database row detail");
    let nodex_core_contracts::database::DatabaseReadValue::RowDetail { value } = detail.value
    else {
        panic!("Database returned the wrong detail");
    };
    assert!(value.body_markdown.contains("BODY-SENTINEL-19999"));

    let mutation = database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "operation:read-budget-move".to_owned(),
                store_epoch: StoreEpoch("epoch:read-budget-gate".to_owned()),
                intent: vec![DatabaseIntent::PositionPage {
                    view_id: VIEW_ID.to_owned(),
                    page_id: "page:scale:00000".to_owned(),
                    expected_position_revision: 1,
                    before_page_id: Some("page:scale:00006".to_owned()),
                }],
            },
        )
        .expect("apply local Database mutation");
    assert!(
        serde_json::to_vec(&mutation.committed)
            .expect("serialize mutation receipt")
            .len()
            < MAX_COLLECTION_WINDOW_JSON_BYTES
    );
    let stale_cursor = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: Some(database_cursor),
                        first: Some(200),
                    },
                    group_scope: None,
                },
            },
        )
        .expect_err("sorting mutations invalidate physical order cursors");
    assert_eq!(
        stale_cursor.code,
        nodex_core_contracts::CoreErrorCode::InvalidInput
    );

    let refreshed = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(200),
                    },
                    group_scope: None,
                },
            },
        )
        .expect("refresh Database window after sorting mutation");
    let nodex_core_contracts::database::DatabaseReadValue::ViewWindow {
        value: refreshed_window,
    } = refreshed.value
    else {
        panic!("Database returned the wrong refreshed window");
    };
    assert_eq!(refreshed_window.rows.items.len(), 200);
    let first_database_ids = refreshed_window
        .rows
        .items
        .iter()
        .map(|row| row.page_id.clone())
        .collect::<HashSet<_>>();
    let continued = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: Some(
                            refreshed_window
                                .rows
                                .next_cursor
                                .expect("refreshed Database continuation"),
                        ),
                        first: Some(200),
                    },
                    group_scope: None,
                },
            },
        )
        .expect("continue the refreshed Database query");
    let nodex_core_contracts::database::DatabaseReadValue::ViewWindow {
        value: continued_window,
    } = continued.value
    else {
        panic!("Database returned the wrong post-mutation continuation");
    };
    assert!(
        continued_window
            .rows
            .items
            .iter()
            .all(|row| !first_database_ids.contains(&row.page_id))
    );

    // Regression fence: pagination must keep progressing while unrelated
    // writes land between windows. The former global change-log fence made
    // this loop fail on its first continuation.
    let mut interleaved_cursor = continued_window.rows.next_cursor.clone();
    let mut seen_interleaved_ids = HashSet::new();
    for round in 0..3 {
        let Some(cursor) = interleaved_cursor.take() else {
            break;
        };
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO change_log( \
                       project_id, store_epoch, kind, block_ids_json, document_ids_json, \
                       database_block_ids_json, payload_json, projection_impact_json, \
                       committed_at \
                     ) VALUES (?1, ?2, 'unrelated_write', '[]', '[]', '[]', '{}', \
                       '{\"kind\":\"none\"}', ?3)",
                    params![PROJECT_ID, "epoch:read-budget-gate", NOW],
                )?;
                Ok(())
            })
            .expect("interleave an unrelated write");
        let window = database
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        search_query: None,
                        target: DatabaseViewReadTarget::View {
                            view_id: VIEW_ID.to_owned(),
                        },
                        window: CollectionWindowRequest {
                            after: Some(cursor),
                            first: Some(200),
                        },
                        group_scope: None,
                    },
                },
            )
            .unwrap_or_else(|error| {
                panic!("interleaved continuation {round} must succeed: {error:?}")
            });
        let nodex_core_contracts::database::DatabaseReadValue::ViewWindow { value: window } =
            window.value
        else {
            panic!("Database returned the wrong interleaved continuation");
        };
        for row in &window.rows.items {
            assert!(
                seen_interleaved_ids.insert(row.page_id.clone()),
                "interleaved pagination repeated a row"
            );
        }
        interleaved_cursor = window.rows.next_cursor.clone();
    }

    // Group totals stay bounded on the large fixture and agree with the
    // group-scoped window predicate.
    let groups = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewGroups {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            },
        )
        .expect("read Database view groups");
    let nodex_core_contracts::database::DatabaseReadValue::ViewGroups { value: groups } =
        groups.value
    else {
        panic!("Database returned the wrong groups value");
    };
    assert!(groups.grouped);
    assert!(!groups.truncated);
    assert_eq!(groups.total_rows, DATABASE_ROW_COUNT as i64);
    assert_eq!(
        groups
            .groups
            .iter()
            .map(|group| group.total_rows)
            .sum::<i64>(),
        DATABASE_ROW_COUNT as i64,
    );
    assert!(
        serde_json::to_vec(&groups)
            .expect("serialize view groups")
            .len()
            < MAX_COLLECTION_WINDOW_JSON_BYTES
    );
    let scoped = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    search_query: None,
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(200),
                    },
                    group_scope: Some(nodex_core_contracts::database::DatabaseGroupScope::Path {
                        group_key: Some("doing".to_owned()),
                        subgroup_key: None,
                    }),
                },
            },
        )
        .expect("read group-scoped Database window");
    let nodex_core_contracts::database::DatabaseReadValue::ViewWindow { value: scoped } =
        scoped.value
    else {
        panic!("Database returned the wrong scoped window");
    };
    assert_eq!(scoped.rows.items.len(), 200);
    assert!(
        scoped
            .rows
            .items
            .iter()
            .all(|row| row.effective_group_key.as_deref() == Some("doing"))
    );
    assert!(
        serde_json::to_vec(&scoped)
            .expect("serialize scoped window")
            .len()
            < MAX_COLLECTION_WINDOW_JSON_BYTES
    );
    println!("database view groups: grouped, {} rows", groups.total_rows);

    let (thread_bytes, database_legacy_bytes) = kernel
        .writer()
        .call(|connection| {
            let thread_bytes = legacy_thread_payload_bytes(connection);
            let database_bytes = legacy_database_payload_bytes(connection);
            assert_store_health(connection);
            Ok((thread_bytes, database_bytes))
        })
        .expect("measure legacy-equivalent payloads");
    assert!(thread_bytes > MAX_ORDINARY_JSON_RESPONSE_BYTES);
    assert!(database_legacy_bytes > MAX_ORDINARY_JSON_RESPONSE_BYTES);

    println!("transport ordinary response max: {MAX_ORDINARY_JSON_RESPONSE_BYTES}");
    println!(
        "sidebar first window: {} items, {workspace_bytes} bytes",
        workspace_window.items.len()
    );
    println!(
        "database view first window: {} items, {database_bytes} bytes",
        database_window.rows.items.len()
    );
    println!("legacy-equivalent thread payload: {thread_bytes} bytes");
    println!("legacy-equivalent database payload: {database_legacy_bytes} bytes");
    println!("sidebar Core requests for first window: 1 (N+1 requests: 0)");
    println!("integrity_check: ok");
    println!("foreign_key_check: 0 rows");
    println!("Database View order plan: covering index, no temporary sort");
}

/// Run against a disposable Profile with the optimized Core test binary.
#[test]
#[ignore = "explicit 50,000-row Database search measurement"]
fn measure_database_view_search() {
    use nodex_core_contracts::database::{DatabaseGroupScope, DatabaseReadValue};
    use std::time::Instant;

    const ROWS: usize = 50_000;
    let kernel = SqliteStoreKernel::open_test(&profile_home()).expect("open search fixture");
    seed_identity_and_workspace(&kernel, false);
    create_database(&kernel);
    seed_database_rows(&kernel, ROWS);
    kernel
        .writer()
        .call_with_budget(
            FIXTURE_SEED_BUDGET * 3,
            QueryCancellation::new(),
            |connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE documents SET readiness='ready'
    WHERE id LIKE 'document:scale:%'",
                        [],
                    )?;
                    let mut unit = transaction.prepare(
                        "INSERT INTO block_search_units (
        unit_key, library_id, block_id, owner_block_id, document_id, document_generation,
        projected_seq, source_kind, field_key, text, text_hash, updated_at
    ) VALUES (?1, ?2, ?1, ?1, ?3, 1, 0, 'document_block', 'body', ?4, ?5, ?6)",
                    )?;
                    let mut state = transaction.prepare(
    "INSERT INTO page_search_documents (document_id, analyzer_version, page_updated_at)
     VALUES (?1, ?2, ?3) ON CONFLICT (document_id)
     DO UPDATE SET analyzer_version=excluded.analyzer_version"
)?;
                    for index in 0..ROWS {
                        let page = format!("page:scale:{index:05}");
                        let document = format!("document:scale:{index:05}");
                        let text = if index >= ROWS - 10 {
                            "zirconium 数据库 refinery"
                        } else if index % 4 == 0 {
                            "deployment"
                        } else {
                            "review"
                        };
                        unit.execute(params![
                            page,
                            LIBRARY_ID,
                            document,
                            text,
                            TITLE_RICH_HASH,
                            NOW
                        ])?;
                        crate::document::search_projection::write_words(
                            transaction,
                            transaction.last_insert_rowid(),
                            text,
                        )?;
                        state.execute(params![
                            document,
                            nodex_search_kernel::ANALYZER_VERSION,
                            NOW
                        ])?;
                    }
                    Ok(())
                })
            },
        )
        .expect("seed searchable Page bodies");
    let database = DatabaseModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
    let target = DatabaseViewReadTarget::View {
        view_id: VIEW_ID.into(),
    };
    let try_read = |read| {
        database.read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read,
            },
        )
    };
    let read = |read| try_read(read).unwrap().value;
    let first = Some(50);
    let groups = |query: &str| {
        let DatabaseReadValue::ViewGroups { value } = read(DatabaseRead::ViewGroups {
            target: target.clone(),
            search_query: Some(query.to_owned()),
        }) else {
            panic!("expected Board groups")
        };
        value
    };
    let started = Instant::now();
    let grouped = groups("deployment");
    assert_eq!(grouped.total_rows, 12_498);
    println!(
        "cold query + groups: {:.1}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let group = grouped
        .groups
        .iter()
        .find(|group| group.total_rows > 0)
        .unwrap();
    let DatabaseReadValue::ViewWindow { value } = read(DatabaseRead::ViewWindow {
        target: target.clone(),
        search_query: Some("deployment".into()),
        window: CollectionWindowRequest { first, after: None },
        group_scope: Some(DatabaseGroupScope::Path {
            group_key: group.group_key.clone(),
            subgroup_key: group.subgroup_key.clone(),
        }),
    }) else {
        panic!("expected Board window")
    };
    assert_eq!(value.rows.items.len(), 50);
    println!(
        "cold first Board window: {:.1}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    for (query, total) in [
        ("deployment", 12_498),
        ("zirconium", 10),
        ("数据", 10),
        ("refinrey", 10),
    ] {
        let mut timings = Vec::new();
        for _ in 0..7 {
            // Evict the one-query cache without rebuilding the metadata index.
            groups("nonexistenttoken");
            let started = Instant::now();
            let grouped = groups(query);
            let search_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(grouped.total_rows, total);
            let group = grouped
                .groups
                .iter()
                .find(|group| group.total_rows > 0)
                .unwrap();
            let DatabaseReadValue::ViewWindow { value } = read(DatabaseRead::ViewWindow {
                target: target.clone(),
                search_query: Some(query.into()),
                window: CollectionWindowRequest { first, after: None },
                group_scope: Some(DatabaseGroupScope::Path {
                    group_key: group.group_key.clone(),
                    subgroup_key: group.subgroup_key.clone(),
                }),
            }) else {
                panic!("expected Board window")
            };
            let board_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(value.rows.items.len() as i64, group.total_rows.min(50));
            assert!(
                value
                    .rows
                    .items
                    .iter()
                    .all(|row| row.search_evidence.is_some())
            );
            groups("nonexistenttoken");
            let started = Instant::now();
            let DatabaseReadValue::ListWindow { value } = read(DatabaseRead::ListWindow {
                target: target.clone(),
                search_query: Some(query.into()),
                window: CollectionWindowRequest { first, after: None },
            }) else {
                panic!("expected List window")
            };
            assert_eq!(value.total_model_count, total);
            timings.push((
                search_ms,
                board_ms,
                started.elapsed().as_secs_f64() * 1000.0,
            ));
        }
        println!(
            "{query} ({total} matches) query+groups / first Board group window / first List window in ms: {timings:.1?}"
        );
    }

    drop(database);
    drop(kernel);
    let kernel = SqliteStoreKernel::open_test(&profile_home()).expect("reopen search fixture");
    let database = DatabaseModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
    let started = Instant::now();
    let DatabaseReadValue::ListWindow { value } = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ListWindow {
                    target,
                    search_query: Some("deployment".into()),
                    window: CollectionWindowRequest { first, after: None },
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("expected List window")
    };
    assert_eq!(value.total_model_count, 12_498);
    println!(
        "cold first List window: {:.1}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
}

/// Measure all first Board windows when real-sized Pages have many indexed Blocks.
#[test]
#[ignore = "explicit long-body Board search measurement"]
fn measure_long_body_board_search() {
    use nodex_core_contracts::database::{DatabaseGroupScope, DatabaseReadValue};
    use std::time::Instant;

    const ROWS: usize = 740;
    const MATCHES: usize = 68;
    const FIRST: u32 = 12;
    const BLOCKS: usize = 24;
    let kernel = SqliteStoreKernel::open_test(&profile_home()).expect("open search fixture");
    seed_identity_and_workspace(&kernel, false);
    create_database(&kernel);
    seed_grouped_database_rows(
        &kernel,
        ROWS,
        &["triage", "plan", "doing", "review", "done"],
        32_000,
    );
    kernel
        .writer()
        .call_with_budget(
            FIXTURE_SEED_BUDGET,
            QueryCancellation::new(),
            |connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE documents SET readiness = 'ready' WHERE id LIKE 'document:scale:%'",
                        [],
                    )?;
                    let mut block = transaction.prepare(
                        "INSERT INTO blocks (id, library_id, type, lifecycle, placement_revision,
                    metadata_revision, created_at, updated_at)
                 VALUES (?1, ?2, 'paragraph', 'active', 1, 1, ?3, ?3)",
                    )?;
                    let mut block_index = transaction.prepare(
                        "INSERT INTO document_block_index (document_id, block_id, ordinal,
                            block_type, text, projected_seq)
                         VALUES (?1, ?2, ?3, 'paragraph', ?4, 0)",
                    )?;
                    let mut unit = transaction.prepare(
                "INSERT INTO block_search_units (unit_key, library_id, block_id, owner_block_id,
                    document_id, document_generation, projected_seq, source_kind, field_key,
                    text, text_hash, updated_at)
                 VALUES (?1, ?2, ?1, ?3, ?4, 1, 0, 'document_block', 'body', ?5, ?6, ?7)",
            )?;
                    let mut state = transaction.prepare(
                "INSERT INTO page_search_documents (document_id, analyzer_version, page_updated_at)
                 VALUES (?1, ?2, ?3) ON CONFLICT (document_id)
                 DO UPDATE SET analyzer_version = excluded.analyzer_version",
            )?;
                    let paragraph =
                        "The team reviewed the notes and recorded the outcome of the discussion. "
                            .repeat(19);
                    for index in 0..ROWS {
                        let page = format!("page:scale:{index:05}");
                        let document = format!("document:scale:{index:05}");
                        for part in 0..BLOCKS {
                            let block_id = format!("block:scale:{index:05}:{part:02}");
                            let mut text = paragraph.clone();
                            if index < MATCHES && part % 3 == 2 {
                                text.push_str("The deployment is scheduled for tomorrow.");
                            }
                            block.execute(params![block_id, LIBRARY_ID, NOW])?;
                            block_index.execute(params![document, block_id, part as i64, text])?;
                            unit.execute(params![
                                block_id,
                                LIBRARY_ID,
                                page,
                                document,
                                text,
                                TITLE_RICH_HASH,
                                NOW
                            ])?;
                            crate::document::search_projection::write_words(
                                transaction,
                                transaction.last_insert_rowid(),
                                &text,
                            )?;
                        }
                        state.execute(params![
                            document,
                            nodex_search_kernel::ANALYZER_VERSION,
                            NOW
                        ])?;
                    }
                    Ok(())
                })
            },
        )
        .expect("seed indexed Blocks");

    let database = DatabaseModule::new(PROFILE_ID, LIBRARY_ID, &kernel);
    let target = DatabaseViewReadTarget::View {
        view_id: VIEW_ID.into(),
    };
    let read = |read| {
        database
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read,
                },
            )
            .unwrap()
            .value
    };
    let groups = |query: &str| {
        let DatabaseReadValue::ViewGroups { value } = read(DatabaseRead::ViewGroups {
            target: target.clone(),
            search_query: Some(query.into()),
        }) else {
            panic!("expected Board groups");
        };
        value
    };

    let mut timings = Vec::new();
    for _ in 0..21 {
        groups("nonexistenttoken");
        let start = Instant::now();
        let grouped = groups("deployment");
        let counts = start.elapsed();
        assert_eq!(grouped.total_rows, MATCHES as i64);
        let populated = grouped.groups.iter().filter(|group| group.total_rows > 0);
        assert_eq!(populated.clone().count(), 5);
        for group in populated {
            let DatabaseReadValue::ViewWindow { value } = read(DatabaseRead::ViewWindow {
                target: target.clone(),
                search_query: Some("deployment".into()),
                window: CollectionWindowRequest {
                    first: Some(FIRST),
                    after: None,
                },
                group_scope: Some(DatabaseGroupScope::Path {
                    group_key: group.group_key.clone(),
                    subgroup_key: group.subgroup_key.clone(),
                }),
            }) else {
                panic!("expected Board window");
            };
            assert_eq!(value.rows.items.len(), FIRST as usize);
            assert!(
                value
                    .rows
                    .items
                    .iter()
                    .all(
                        |row| row.search_evidence.as_ref().is_some_and(|evidence| evidence
                            .excerpt_parts
                            .iter()
                            .flatten()
                            .any(|part| part.highlighted && part.text == "deployment"))
                    )
            );
        }
        let total = start.elapsed();
        timings.push((
            counts.as_secs_f64() * 1000.0,
            (total - counts).as_secs_f64() * 1000.0,
            total.as_secs_f64() * 1000.0,
        ));
    }
    println!("long-body Board groups / all first windows / total in ms: {timings:.1?}");
}
