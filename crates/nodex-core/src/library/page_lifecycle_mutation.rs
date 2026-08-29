use std::collections::{BTreeMap, BTreeSet, VecDeque};

use nodex_core_contracts::database::DatabaseRead;
use nodex_core_contracts::library::{
    LibraryCommitValue, LibraryDocumentHead, LibraryLifecycle, LibraryPageLifecycleDeleteEvidence,
    LibraryPageLifecycleDeletedBlock, LibraryPageLifecycleMutation,
    LibraryPageLifecycleMutationMembership, LibraryPageLifecycleMutationReceipt,
    LibraryPageLifecycleNestedParent, LibraryPageLifecycleRestoreEvidence,
    LibraryPageLifecycleRestoreMembership, LibraryPageLifecycleRestorePosition,
    LibraryPageLifecycleState, LibraryPageLifecycleViewPlacement, LibraryPageWorkflowStatus,
    LibraryReceipt, LibraryResourceTarget,
};
use nodex_core_contracts::{BoundModuleContext, ModuleName};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::database;
use crate::document::{
    BlockDocumentSchema, DocumentBlockOperation, DocumentPlacementEvidence, PAGE_SCHEMA_KEY,
    PAGE_SCHEMA_VERSION, PersistYjsGenesis, persist_yjs_genesis_with_local_commit,
    prepare_page_yjs_genesis_with_content, read_document_authority, sha256,
};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::fractional_rank::{
    FractionalRankErrorCode, RankedItem, plan as plan_fractional_rank,
};
use crate::domain::ordered_position::{
    LogicalPositionItem, PositionPlanError, SiblingRankWrite, SiblingRankWriteKind,
    plan_position_run,
};
use crate::domain::rich_text::{RichTextItem, RichTextStyles};
use crate::infrastructure::durable_mutation::{
    self, DurableMutationScope, OperationIdentity, SealedOutcome,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::LibraryApplyOutcome;
use super::mutation::{
    MutationEffects, ParentDocumentPlacement, ParentDocumentWriteContext, insert_page_read_model,
    library_commit_result, persist_parent_operations_detailed_with_local_commit,
    require_project_in_library, seal_mutation, synchronize_library_placement_rank,
};

struct PageAuthority {
    page_id: String,
    library_id: String,
    lifecycle: String,
    containing_document_id: Option<String>,
    metadata_revision: i64,
    parent_revision: i64,
    parent_kind: String,
    parent_id: String,
    document_id: String,
    document_generation: i64,
    document_head_seq: i64,
}

pub(super) struct PageTombstoneCoordinates<'a> {
    pub(super) page_id: &'a str,
    pub(super) metadata_revision: i64,
    pub(super) parent_revision: i64,
    pub(super) document_id: &'a str,
    pub(super) document_generation: i64,
    pub(super) document_head_seq: i64,
}

impl<'a> From<&'a PageAuthority> for PageTombstoneCoordinates<'a> {
    fn from(page: &'a PageAuthority) -> Self {
        Self {
            page_id: &page.page_id,
            metadata_revision: page.metadata_revision,
            parent_revision: page.parent_revision,
            document_id: &page.document_id,
            document_generation: page.document_generation,
            document_head_seq: page.document_head_seq,
        }
    }
}

struct MembershipCoordinates {
    membership_id: String,
    database_id: String,
    data_source_id: String,
    membership_revision: i64,
    status: LibraryPageWorkflowStatus,
    view_id: Option<String>,
    view_rank_key: Option<String>,
}

struct IndexedBlock {
    block_id: String,
    block_type: String,
    lifecycle: String,
    metadata_revision: i64,
    placement_revision: i64,
    resource_metadata_revision: Option<i64>,
}

struct IndexedClosure {
    blocks: Vec<IndexedBlock>,
    document_ids: Vec<String>,
}

struct CreateSource {
    database_id: String,
    view_id: String,
    view_config: Value,
}

struct CreateProperty {
    property_id: String,
    value_type: String,
    config_json: String,
    schema_revision: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    mutation: &LibraryPageLifecycleMutation,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page lifecycle mutation requires a bound Project"))?;
    require_project_in_library(connection, project_id, library_id)?;
    match mutation {
        LibraryPageLifecycleMutation::ArchivePage {
            page_id,
            expected_metadata_revision,
        } => transition_lifecycle(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            page_id,
            *expected_metadata_revision,
            false,
        ),
        LibraryPageLifecycleMutation::UnarchivePage {
            page_id,
            expected_metadata_revision,
        } => transition_lifecycle(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            page_id,
            *expected_metadata_revision,
            true,
        ),
        LibraryPageLifecycleMutation::MovePageInLibrary {
            page_id,
            expected_parent_revision,
            before_block_id,
        } => move_in_library(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            page_id,
            *expected_parent_revision,
            before_block_id.as_deref(),
        ),
        LibraryPageLifecycleMutation::DeletePage {
            page_id,
            expected_metadata_revision,
            expected_parent_revision,
            parent_document_head,
        } => delete_page(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            page_id,
            *expected_metadata_revision,
            *expected_parent_revision,
            parent_document_head.as_ref(),
        ),
        LibraryPageLifecycleMutation::RestorePage {
            page_id,
            delete_operation_id,
            expected_metadata_revision,
            expected_parent_revision,
            membership,
            before_block_id,
            parent_document_head,
        } => restore_page(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            page_id,
            delete_operation_id,
            *expected_metadata_revision,
            *expected_parent_revision,
            membership.as_ref(),
            before_block_id.as_deref(),
            parent_document_head.as_ref(),
        ),
        LibraryPageLifecycleMutation::CreatePage { .. } => create_page(
            connection,
            context,
            store_epoch,
            library_id,
            operation_id,
            request_hash,
            mutation,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn delete_with_etag(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_etag: &str,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page deletion requires a bound Project"))?;
    require_project_in_library(connection, project_id, library_id)?;
    let page = read_page(connection, library_id, page_id)?;
    authorize_page_write(connection, context, library_id, &page)?;
    let current_etag = super::page_projection::mint_page_shell_etag(
        connection,
        library_id,
        project_id,
        store_epoch,
        page_id,
    )?;
    if !constant_time_equal(expected_etag.as_bytes(), current_etag.as_bytes()) {
        return Err(conflict("Page shell ETag changed"));
    }
    // The headless CLI has no mounted parent Y.Doc to fence. Its Page ETag
    // already protects the exact owner and placement; resolve the current host
    // head inside this writer transaction so nested deletion still uses the
    // same typed lifecycle path as the desktop editor.
    let parent_document_head = if page.parent_kind == "page" {
        let parent_document_id = page
            .containing_document_id
            .as_deref()
            .ok_or_else(|| corrupt("Nested Page has no containing Document"))?;
        let parent = super::mutation::load_parent_document(connection, parent_document_id)?;
        Some(LibraryDocumentHead {
            document_id: parent_document_id.to_owned(),
            generation: parent.authority.head.generation,
            head_seq: parent.authority.head.head_seq,
        })
    } else {
        None
    };
    delete_page(
        connection,
        context,
        store_epoch,
        library_id,
        operation_id,
        request_hash,
        page_id,
        page.metadata_revision,
        page.parent_revision,
        parent_document_head.as_ref(),
    )
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[allow(clippy::too_many_arguments)]
fn create_page(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    mutation: &LibraryPageLifecycleMutation,
) -> Result<LibraryApplyOutcome, StoreError> {
    let LibraryPageLifecycleMutation::CreatePage {
        page_id,
        title,
        rich_title,
        nfm,
        status,
        priority,
        estimate,
        due_date,
        scheduled_start,
        scheduled_end,
        is_all_day,
        recurrence,
        reminders,
        schedule_timezone,
        assignee,
        run_in_target,
        run_in_local_path,
        run_in_base_branch,
        run_in_worktree_path,
        run_in_environment_path,
        before_block_id: _,
        view_placement,
        data_source_id,
        tag_option_ids,
        new_tag_options,
        expected_tags_property_revision,
    } = mutation
    else {
        unreachable!("create_page receives a CreatePage mutation")
    };
    validate_uuid_v7(page_id, "page_id")?;
    if title.len() > 10_000 {
        return Err(invalid("Page title exceeds its bound"));
    }
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page creation requires a bound Project"))?;
    database::read::read(
        connection,
        library_id,
        context,
        DatabaseRead::DataSource {
            data_source_id: data_source_id.clone(),
        },
    )?;
    let source = read_create_source(connection, library_id, data_source_id)?;
    let mut properties = read_create_properties(connection, data_source_id)?;
    let (selected_tags, tags_config_json) = if let Some(tags_property) = properties.get_mut("tags")
    {
        if tags_property.schema_revision != *expected_tags_property_revision {
            return Err(conflict("Tags Property revision changed"));
        }
        let mut tags_config = parse_option_config(tags_property)?;
        add_tag_options(&mut tags_config, new_tag_options)?;
        let selected_tags = normalize_selected_options(&tags_config, tag_option_ids)?;
        let tags_config_json = serde_json::to_string(&tags_config)
            .map_err(|_| corrupt("Tags Property registry cannot encode"))?;
        tags_property.config_json = tags_config_json.clone();
        (selected_tags, Some(tags_config_json))
    } else {
        if !tag_option_ids.is_empty() || !new_tag_options.is_empty() {
            return Err(invalid(
                "Page tags cannot be selected when the Data Source has no tags Property",
            ));
        }
        (Value::Array(Vec::new()), None)
    };
    let values = validate_create_values(
        &properties,
        *status,
        priority.as_deref(),
        estimate.as_deref(),
        due_date.as_deref(),
        scheduled_start.as_deref(),
        scheduled_end.as_deref(),
        assignee.as_deref(),
        selected_tags,
    )?;
    let view_group_key = if let Some(property_id) = source
        .view_config
        .pointer("/presentation/group/propertyId")
        .and_then(Value::as_str)
    {
        values
            .get(property_id)
            .map(database_group_key)
            .transpose()?
            .flatten()
    } else {
        None
    };
    let view_rank_key = allocate_create_view_position(
        connection,
        &source.view_id,
        data_source_id,
        page_id,
        view_placement,
    )?;
    let document_id = format!("document:{page_id}");
    let membership_id = format!(
        "membership:{}",
        sha256(format!("page-lifecycle:{operation_id}:membership").as_bytes())
    );
    let rich_title = parse_create_rich_title(rich_title.as_ref(), title)?;
    let mut block_ordinal = 0usize;
    let mut allocate_block_id = || {
        let block_id = deterministic_uuid_v7(&format!(
            "page-lifecycle:{operation_id}:body:{block_ordinal}"
        ));
        block_ordinal += 1;
        block_id
    };
    let prepared = prepare_page_yjs_genesis_with_content(
        &document_id,
        &rich_title,
        nfm,
        &mut allocate_block_id,
    )?;
    let created_block_ids = flatten_block_ids(&prepared.materialization.block_tree);
    assert_create_identities(
        connection,
        page_id,
        &document_id,
        &membership_id,
        &created_block_ids,
    )?;
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            if !new_tag_options.is_empty() {
                let tags_config_json = tags_config_json
                    .as_ref()
                    .ok_or_else(|| corrupt("Tags Property disappeared during Page creation"))?;
                let changed = connection.execute(
                    "UPDATE data_source_properties SET config_json = ?1, \
               schema_revision = schema_revision + 1, updated_at = ?2 \
             WHERE data_source_id = ?3 AND id = 'tags' AND lifecycle = 'active' \
               AND schema_revision = ?4",
                    params![
                        tags_config_json,
                        now,
                        data_source_id,
                        expected_tags_property_revision
                    ],
                )?;
                if changed != 1 {
                    return Err(conflict("Tags Property changed during Page creation"));
                }
            }
            let positioned_sibling_page_ids = synchronize_create_view_siblings(
                connection,
                &source.view_id,
                &view_rank_key.sibling_writes,
                &now,
            )?;
            let indexed_scheduled_start = values
                .get("scheduled_start")
                .and_then(|(_, value)| value.as_str());
            let indexed_scheduled_end = values
                .get("scheduled_end")
                .and_then(|(_, value)| value.as_str());
            let indexed_is_all_day =
                *is_all_day && indexed_scheduled_start.is_some() && indexed_scheduled_end.is_some();
            connection.execute(
                "INSERT INTO blocks( \
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at \
         ) VALUES (?1, ?2, 'page', 'active', 1, 1, ?3, ?3)",
                params![page_id, library_id, now],
            )?;
            connection.execute(
                "INSERT INTO documents( \
           id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
           state_hash, readiness, authority, genesis_source_revision, created_at, updated_at, \
           sync_engine \
         ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', '', 'pending_genesis', 'legacy_shadow', \
           NULL, ?5, ?5, 'yjs')",
                params![
                    document_id,
                    library_id,
                    PAGE_SCHEMA_KEY,
                    i64::from(PAGE_SCHEMA_VERSION),
                    now
                ],
            )?;
            connection.execute(
                "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
                params![page_id, document_id, library_id, now],
            )?;
            connection.execute(
                "INSERT INTO pages( \
           block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 'data_source', ?4, ?5, ?5)",
                params![page_id, library_id, document_id, data_source_id, now],
            )?;
            let authority = read_document_authority(connection, &document_id)?
                .ok_or_else(|| corrupt("Created Page has no Document authority"))?;
            if authority.head.schema_key != BlockDocumentSchema::PageV3.schema_key()
                || authority.head.schema_version != i64::from(PAGE_SCHEMA_VERSION)
            {
                return Err(corrupt("Created Page has the wrong Document schema"));
            }
            let genesis_update_id =
                format!("page-lifecycle-genesis:{}", sha256(operation_id.as_bytes()));
            let full_state = prepared.engine.full_state_v1();
            let persisted = persist_yjs_genesis_with_local_commit(
                connection,
                PersistYjsGenesis {
                    authority: &authority,
                    actor_project_id: project_id,
                    materialization: &prepared.materialization,
                    update_id: &genesis_update_id,
                    client_session_id: "page-lifecycle-v2-create",
                    update: &prepared.update_v1,
                    state_vector: &prepared.state_vector_v1,
                    full_state: &full_state,
                    store_epoch,
                    operation_id: &genesis_update_id,
                    placement: DocumentPlacementEvidence::STRUCTURAL,
                    emit_event: false,
                },
                scope.evidence(),
            )?;
            connection.execute(
                "INSERT INTO data_source_page_memberships( \
           id, data_source_id, page_block_id, revision, created_at, removed_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
                params![membership_id, data_source_id, page_id, now],
            )?;
            database::ensure_database_page_key(
                connection,
                library_id,
                &source.database_id,
                page_id,
                &now,
            )?;
            for (property_id, (value_type, value)) in &values {
                connection.execute(
                    "INSERT INTO data_source_property_values( \
               data_source_id, membership_id, property_id, value_type, value_json, \
               revision, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                    params![
                        data_source_id,
                        membership_id,
                        property_id,
                        value_type,
                        serde_json::to_string(value)
                            .map_err(|_| corrupt("Page Property value cannot encode"))?,
                        now
                    ],
                )?;
            }
            database::synchronize_membership_completion_timestamp(
                connection,
                data_source_id,
                &membership_id,
                &now,
            )?;
            let intrinsic_values = create_intrinsic_values(
                run_in_target,
                run_in_local_path.as_deref(),
                run_in_base_branch.as_deref(),
                run_in_worktree_path.as_deref(),
                run_in_environment_path.as_deref(),
                *is_all_day,
                schedule_timezone.as_deref(),
                recurrence.as_ref(),
                reminders,
            );
            insert_intrinsic_properties(connection, page_id, library_id, &intrinsic_values, &now)?;
            connection.execute(
                "INSERT INTO database_view_page_positions( \
           view_id, page_block_id, rank_key, revision, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                params![source.view_id, page_id, view_rank_key.rank_key, now],
            )?;
            connection.execute(
        "INSERT INTO scheduled_page_index( \
           page_block_id, library_id, lifecycle, scheduled_start, scheduled_end, is_all_day, \
           recurrence_json, reminders_json, schedule_timezone, source_metadata_revision, updated_at \
         ) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
        params![
            page_id,
            library_id,
            indexed_scheduled_start,
            indexed_scheduled_end,
            i64::from(indexed_is_all_day),
            serde_json::to_string(recurrence.as_ref().unwrap_or(&Value::Null))
                .map_err(|_| corrupt("Page recurrence cannot encode"))?,
            serde_json::to_string(reminders)
                .map_err(|_| corrupt("Page reminders cannot encode"))?,
            schedule_timezone,
            now
        ],
    )?;
            insert_page_read_model(
                connection,
                page_id,
                &prepared.materialization,
                persisted.head_seq,
                &now,
            )?;
            insert_created_page_projection(
                connection,
                page_id,
                &source,
                &membership_id,
                view_group_key.as_deref(),
                &view_rank_key.rank_key,
                &document_id,
                persisted.head_seq,
                &values,
                &intrinsic_values,
                &now,
            )?;
            let receipt = LibraryPageLifecycleMutationReceipt {
                operation_kind: "create_page".to_owned(),
                page_id: page_id.clone(),
                metadata_revision: 1,
                parent_revision: 1,
                lifecycle: LibraryPageLifecycleState::Active,
                document_id: document_id.clone(),
                document_generation: 1,
                document_head_seq: persisted.head_seq,
                database_id: Some(source.database_id.clone()),
                data_source_id: Some(data_source_id.clone()),
                membership_id: Some(membership_id.clone()),
                view_id: Some(source.view_id.clone()),
                library_rank_key: None,
                view_rank_key: Some(view_rank_key.rank_key),
                created_block_ids: created_block_ids.clone(),
                created_tag_option_ids: if tags_config_json.is_some() {
                    new_tag_options
                        .iter()
                        .map(|option| option.option_id.clone())
                        .collect()
                } else {
                    Vec::new()
                },
                delete_evidence: None,
            };
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: project_id.to_owned(),
                    operation_kind: "create_page",
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: Some(LibraryResourceTarget::Page {
                        page_id: page_id.clone(),
                    }),
                    affected_parent_keys: vec![format!("database:{}", source.database_id)],
                    affected_block_ids: created_block_ids,
                    affected_page_ids: std::iter::once(page_id.clone())
                        .chain(positioned_sibling_page_ids)
                        .collect(),
                    affected_database_ids: vec![source.database_id.clone()],
                    affected_view_ids: vec![source.view_id.clone()],
                    affected_document_ids: vec![document_id],
                    committed_revisions: {
                        let mut revisions = BTreeMap::from([
                            (format!("blockMetadata:{page_id}"), 1),
                            (format!("blockLocation:{page_id}"), 1),
                            (format!("membership:{membership_id}"), 1),
                            (format!("position:{}:{page_id}", source.view_id), 1),
                        ]);
                        if tags_config_json.is_some() {
                            revisions.insert(
                                format!("property:{data_source_id}:tags"),
                                expected_tags_property_revision
                                    + i64::from(!new_tag_options.is_empty()),
                            );
                        }
                        revisions
                    },
                    page_create: None,
                    page_copy: None,
                    page_files: None,
                    canvas_mutation: None,
                    block_transfer: None,
                    block_transfer_undo: None,
                    structural_edit: None,
                    page_lifecycle: Some(receipt),
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: None,
                    committed_at: now.clone(),
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

fn read_create_source(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<CreateSource, StoreError> {
    let row = connection
        .query_row(
            "SELECT source.home_database_block_id, view.id, view.config_json \
             FROM data_sources source \
             JOIN database_containers container ON container.block_id = source.home_database_block_id \
               AND container.library_id = source.library_id AND container.lifecycle = 'active' \
             JOIN database_views view ON view.id = container.default_view_id \
               AND view.database_block_id = container.block_id \
               AND view.data_source_id = source.id AND view.lifecycle = 'active' \
               AND view.layout = 'board' \
             WHERE source.id = ?1 AND source.library_id = ?2 AND source.lifecycle = 'active'",
            params![data_source_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((database_id, view_id, config_json)) = row else {
        return Err(invalid(
            "Data Source or its default Board View is unavailable",
        ));
    };
    let view_config = serde_json::from_str(&config_json)
        .map_err(|_| corrupt("Default View config is invalid JSON"))?;
    if !database::is_exact_primary_board_config(&view_config) {
        return Err(invalid(
            "Default View cannot provide exact primary Board placement",
        ));
    }
    Ok(CreateSource {
        database_id,
        view_id,
        view_config,
    })
}

fn read_create_properties(
    connection: &Connection,
    data_source_id: &str,
) -> Result<BTreeMap<String, CreateProperty>, StoreError> {
    let properties = connection
        .prepare(
            "SELECT id, value_type, config_json, schema_revision \
             FROM data_source_properties WHERE data_source_id = ?1 AND lifecycle = 'active' \
             ORDER BY id",
        )?
        .query_map([data_source_id], |row| {
            Ok(CreateProperty {
                property_id: row.get(0)?,
                value_type: row.get(1)?,
                config_json: row.get(2)?,
                schema_revision: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if properties.iter().any(|property| {
        !database::property_semantics::is_canonical_property_id(&property.property_id)
    }) {
        return Err(corrupt("Stored Property ID is not canonical"));
    }
    Ok(properties
        .into_iter()
        .map(|property| (property.property_id.clone(), property))
        .collect())
}

fn parse_option_config(
    property: &CreateProperty,
) -> Result<database::property_semantics::PropertyOptionConfig, StoreError> {
    database::property_semantics::option_config_from_storage(
        &property.property_id,
        &property.value_type,
        &property.config_json,
    )
}

fn add_tag_options(
    config: &mut database::property_semantics::PropertyOptionConfig,
    new_options: &[nodex_core_contracts::library::LibraryPageLifecycleTagOption],
) -> Result<(), StoreError> {
    for option in new_options {
        if !database::property_semantics::is_canonical_option_id("tags", &option.option_id)
            || !database::property_semantics::is_canonical_option_name("tags", &option.name)
            || config
                .options
                .iter()
                .any(|stored| stored.id == option.option_id || stored.name == option.name)
        {
            return Err(invalid("New tag option identity or name conflicts"));
        }
        if config.options.len() >= database::MAX_PROPERTY_OPTIONS {
            return Err(invalid("Tags Property option registry exceeds its bound"));
        }
        config
            .options
            .push(database::property_semantics::PropertyOption {
                id: option.option_id.clone(),
                name: option.name.clone(),
                color: None,
            });
    }
    Ok(())
}

fn normalize_selected_options(
    config: &database::property_semantics::PropertyOptionConfig,
    selected: &[String],
) -> Result<Value, StoreError> {
    let known = config
        .options
        .iter()
        .map(|option| option.id.as_str())
        .collect::<BTreeSet<_>>();
    let selected = selected.iter().cloned().collect::<BTreeSet<_>>();
    if selected
        .iter()
        .any(|option_id| !known.contains(option_id.as_str()))
    {
        return Err(invalid("Page tags reference an unknown option"));
    }
    Ok(Value::Array(
        selected.into_iter().map(Value::String).collect(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn validate_create_values(
    properties: &BTreeMap<String, CreateProperty>,
    status: LibraryPageWorkflowStatus,
    priority: Option<&str>,
    estimate: Option<&str>,
    due_date: Option<&str>,
    scheduled_start: Option<&str>,
    scheduled_end: Option<&str>,
    assignee: Option<&str>,
    selected_tags: Value,
) -> Result<BTreeMap<String, (String, Value)>, StoreError> {
    let inputs = BTreeMap::from([
        (
            "status",
            (
                "select",
                Value::String(workflow_status_key(status).to_owned()),
            ),
        ),
        (
            "priority",
            (
                "select",
                priority.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "estimate",
            (
                "select",
                estimate.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        ("tags", ("multi_select", selected_tags)),
        (
            "due_date",
            (
                "date",
                due_date.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "scheduled_start",
            (
                "datetime",
                scheduled_start.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "scheduled_end",
            (
                "datetime",
                scheduled_end.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "assignee",
            (
                "text",
                assignee.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        ("task_parent", ("relation", Value::Null)),
    ]);
    inputs
        .into_iter()
        .filter_map(|(property_id, (expected_type, value))| {
            let property = properties.get(property_id)?;
            Some((property_id, expected_type, value, property))
        })
        .map(|(property_id, expected_type, value, property)| {
            if property.value_type != expected_type {
                return Err(corrupt(&format!(
                    "Data Source Property {property_id} has the wrong type"
                )));
            }
            let normalized = normalize_create_value(property, &value)?;
            Ok((
                property_id.to_owned(),
                (property.value_type.clone(), normalized),
            ))
        })
        .collect()
}

fn normalize_create_value(property: &CreateProperty, value: &Value) -> Result<Value, StoreError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    match property.value_type.as_str() {
        "text" => value
            .as_str()
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("Page Property requires a string or null")),
        "date" => value
            .as_str()
            .filter(|value| valid_iso_date(value))
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("Page date must be canonical YYYY-MM-DD")),
        "datetime" => value
            .as_str()
            .filter(|value| valid_datetime(value))
            .map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| invalid("Page datetime must be canonical RFC 3339 UTC")),
        "select" => {
            let option_id = value
                .as_str()
                .ok_or_else(|| invalid("Page select value must be an option identity"))?;
            let config = parse_option_config(property)?;
            config
                .options
                .iter()
                .any(|option| option.id == option_id)
                .then(|| Value::String(option_id.to_owned()))
                .ok_or_else(|| invalid("Page select value references an unknown option"))
        }
        "multi_select" => {
            let config = parse_option_config(property)?;
            normalize_selected_options(
                &config,
                &value
                    .as_array()
                    .ok_or_else(|| invalid("Page multi-select value must be an array"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| invalid("Page option identity must be a string"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        _ => Err(corrupt("Page Property type is unsupported")),
    }
}

fn database_group_key(value: &(String, Value)) -> Result<Option<String>, StoreError> {
    let value = &value.1;
    if value.is_null() || value.as_str() == Some("") || value.as_array().is_some_and(Vec::is_empty)
    {
        return Ok(None);
    }
    if let Some(value) = value.as_str() {
        return Ok(Some(value.to_owned()));
    }
    serde_json::to_string(value)
        .map(Some)
        .map_err(|_| corrupt("Database group value cannot encode"))
}

#[derive(Debug)]
struct CreateViewPositionPlan {
    rank_key: String,
    sibling_writes: Vec<SiblingRankWrite>,
}

fn allocate_create_view_position(
    connection: &Connection,
    view_id: &str,
    data_source_id: &str,
    page_id: &str,
    placement: &LibraryPageLifecycleViewPlacement,
) -> Result<CreateViewPositionPlan, StoreError> {
    let items = connection
        .prepare(
            "SELECT membership.page_block_id, position.rank_key \
             FROM data_source_page_memberships membership \
             JOIN page_read_model model \
               ON model.page_block_id = membership.page_block_id \
               AND model.membership_id = membership.id AND model.lifecycle = 'active' \
               AND model.view_id = ?1 \
             JOIN documents document \
               ON document.id = model.document_id \
               AND document.generation = model.document_generation \
               AND document.head_seq = model.document_projected_seq \
             JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             LEFT JOIN database_view_page_positions position \
               ON position.view_id = ?1 \
               AND position.page_block_id = membership.page_block_id \
             WHERE membership.data_source_id = ?2 AND membership.removed_at IS NULL \
               AND model.view_rank_key IS position.rank_key \
             ORDER BY CASE WHEN position.rank_key IS NULL THEN 1 ELSE 0 END, \
               position.rank_key, membership.page_block_id",
        )?
        .query_map(params![view_id, data_source_id], |row| {
            Ok(LogicalPositionItem {
                page_id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let before_page_id = match placement {
        LibraryPageLifecycleViewPlacement::Start => items.first().map(|item| item.page_id.as_str()),
        LibraryPageLifecycleViewPlacement::End => None,
        LibraryPageLifecycleViewPlacement::Before { page_id } => {
            if !items.iter().any(|item| item.page_id == *page_id) {
                return Err(invalid("View placement anchor is unavailable"));
            }
            Some(page_id.as_str())
        }
    };
    let plan = plan_position_run(&items, &[page_id.to_owned()], before_page_id, false)
        .map_err(create_view_position_plan_error)?;
    let rank_key = plan
        .moved_rank_keys
        .get(page_id)
        .cloned()
        .ok_or_else(|| corrupt("Create View rank plan omitted the new Page"))?;
    Ok(CreateViewPositionPlan {
        rank_key,
        sibling_writes: plan.sibling_writes,
    })
}

fn create_view_position_plan_error(error: PositionPlanError) -> StoreError {
    match error {
        PositionPlanError::InvalidInput(message) | PositionPlanError::AnchorNotFound(message) => {
            invalid(&message)
        }
        PositionPlanError::FractionalRank(error) => rank_error(error),
    }
}

fn synchronize_create_view_siblings(
    connection: &Connection,
    view_id: &str,
    sibling_writes: &[SiblingRankWrite],
    now: &str,
) -> Result<Vec<String>, StoreError> {
    let mut affected_page_ids = Vec::with_capacity(sibling_writes.len());
    for write in sibling_writes {
        match write.kind {
            SiblingRankWriteKind::Materialize => {
                connection.execute(
                    "INSERT INTO database_view_page_positions( \
                       view_id, page_block_id, rank_key, revision, created_at, updated_at \
                     ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                    params![view_id, write.page_id, write.rank_key, now],
                )?;
            }
            SiblingRankWriteKind::Rebalance => {
                let position_changed = connection.execute(
                    "UPDATE database_view_page_positions SET rank_key = ?1, updated_at = ?2 \
                     WHERE view_id = ?3 AND page_block_id = ?4",
                    params![write.rank_key, now, view_id, write.page_id],
                )?;
                if position_changed != 1 {
                    return Err(corrupt(
                        "Database View sibling position disappeared during Page creation",
                    ));
                }
            }
        }
        let projection_changed = connection.execute(
            "UPDATE page_read_model SET view_rank_key = ?1, \
               projection_version = projection_version + 1, updated_at = ?2 \
             WHERE page_block_id = ?3 AND view_id = ?4",
            params![write.rank_key, now, write.page_id, view_id],
        )?;
        if projection_changed != 1 {
            return Err(corrupt(
                "Database View sibling projection disappeared during Page creation",
            ));
        }
        affected_page_ids.push(write.page_id.clone());
    }
    Ok(affected_page_ids)
}

fn parse_create_rich_title(
    rich_title: Option<&Value>,
    title: &str,
) -> Result<Vec<RichTextItem>, StoreError> {
    if let Some(rich_title) = rich_title {
        return serde_json::from_value::<Vec<RichTextItem>>(rich_title.clone())
            .map_err(|_| invalid("Page rich title is invalid"));
    }
    if title.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![RichTextItem::Text {
        text: title.to_owned(),
        styles: RichTextStyles::default(),
    }])
}

fn flatten_block_ids(
    blocks: &[crate::domain::block_materialization::MaterializedBlockNode],
) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| {
            std::iter::once(block.id.clone()).chain(flatten_block_ids(&block.children))
        })
        .collect()
}

fn assert_create_identities(
    connection: &Connection,
    page_id: &str,
    document_id: &str,
    membership_id: &str,
    block_ids: &[String],
) -> Result<(), StoreError> {
    for block_id in std::iter::once(page_id).chain(block_ids.iter().map(String::as_str)) {
        let collision = connection
            .query_row(
                "SELECT 1 WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?1) \
                 OR EXISTS (SELECT 1 FROM retired_block_identities WHERE block_id = ?1)",
                [block_id],
                |_| Ok(()),
            )
            .optional()?;
        if collision.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Page creation Block identity is already reserved",
                false,
            ));
        }
    }
    let collision = connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM data_source_page_memberships WHERE id = ?2)",
            params![document_id, membership_id],
            |_| Ok(()),
        )
        .optional()?;
    if collision.is_none() {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Conflict,
        "Page creation Document or membership identity is already reserved",
        false,
    ))
}

#[allow(clippy::too_many_arguments)]
fn create_intrinsic_values(
    run_in_target: &str,
    run_in_local_path: Option<&str>,
    run_in_base_branch: Option<&str>,
    run_in_worktree_path: Option<&str>,
    run_in_environment_path: Option<&str>,
    is_all_day: bool,
    schedule_timezone: Option<&str>,
    recurrence: Option<&Value>,
    reminders: &[Value],
) -> BTreeMap<String, (String, Value)> {
    BTreeMap::from([
        (
            "run.target".to_owned(),
            ("string".to_owned(), Value::String(run_in_target.to_owned())),
        ),
        (
            "run.localPath".to_owned(),
            (
                "string".to_owned(),
                run_in_local_path.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "run.baseBranch".to_owned(),
            (
                "string".to_owned(),
                run_in_base_branch.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "run.worktreePath".to_owned(),
            (
                "string".to_owned(),
                run_in_worktree_path.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "run.environmentPath".to_owned(),
            (
                "string".to_owned(),
                run_in_environment_path
                    .map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "schedule.isAllDay".to_owned(),
            ("boolean".to_owned(), Value::Bool(is_all_day)),
        ),
        (
            "schedule.timezone".to_owned(),
            (
                "string".to_owned(),
                schedule_timezone.map_or(Value::Null, |value| Value::String(value.to_owned())),
            ),
        ),
        (
            "recurrence.config".to_owned(),
            (
                "json".to_owned(),
                recurrence.cloned().unwrap_or(Value::Null),
            ),
        ),
        (
            "reminders.config".to_owned(),
            ("json".to_owned(), Value::Array(reminders.to_vec())),
        ),
    ])
}

fn insert_intrinsic_properties(
    connection: &Connection,
    page_id: &str,
    library_id: &str,
    values: &BTreeMap<String, (String, Value)>,
    now: &str,
) -> Result<(), StoreError> {
    for (key, (value_type, value)) in values {
        connection.execute(
            "INSERT INTO block_properties( \
               block_id, library_id, property_key, value_type, value_json, revision, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![
                page_id,
                library_id,
                key,
                value_type,
                serde_json::to_string(value)
                    .map_err(|_| corrupt("Page intrinsic Property cannot encode"))?,
                now
            ],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_created_page_projection(
    connection: &Connection,
    page_id: &str,
    source: &CreateSource,
    membership_id: &str,
    group_key: Option<&str>,
    view_rank_key: &str,
    document_id: &str,
    document_head_seq: i64,
    values: &BTreeMap<String, (String, Value)>,
    intrinsic_values: &BTreeMap<String, (String, Value)>,
    now: &str,
) -> Result<(), StoreError> {
    let mut database_values = Map::new();
    let mut database_revisions = Map::new();
    for (property_id, (_, value)) in values {
        database_values.insert(property_id.clone(), value.clone());
        database_revisions.insert(property_id.clone(), Value::from(1));
    }
    let intrinsic_projection = intrinsic_values
        .iter()
        .map(|(key, (_, value))| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    let intrinsic_revisions = intrinsic_values
        .keys()
        .map(|key| (key.clone(), Value::from(1)))
        .collect::<Map<_, _>>();
    let property_revisions = json!({
        "database": database_revisions,
        "intrinsic": intrinsic_revisions,
    });
    let changed = connection.execute(
        "UPDATE page_read_model SET membership_id = ?2, database_block_id = ?3, \
           view_id = ?4, view_group_key = ?5, view_rank_key = ?6, \
           database_values_json = ?7, intrinsic_properties_json = ?8, \
           property_revisions_json = ?9, updated_at = ?10 \
         WHERE page_block_id = ?1 AND document_id = ?11 AND document_projected_seq = ?12",
        params![
            page_id,
            membership_id,
            source.database_id,
            source.view_id,
            group_key,
            view_rank_key,
            serde_json::to_string(&database_values)
                .map_err(|_| corrupt("Created Page Database values cannot encode"))?,
            serde_json::to_string(&intrinsic_projection)
                .map_err(|_| corrupt("Created Page intrinsic values cannot encode"))?,
            serde_json::to_string(&property_revisions)
                .map_err(|_| corrupt("Created Page Property revisions cannot encode"))?,
            now,
            document_id,
            document_head_seq,
        ],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt("Created Page projection authority changed"))
}

fn deterministic_uuid_v7(seed: &str) -> String {
    let entropy = sha256(seed.as_bytes());
    format!(
        "{}-{}-7{}-8{}-{}",
        &entropy[..8],
        &entropy[8..12],
        &entropy[12..15],
        &entropy[15..18],
        &entropy[18..30]
    )
}

fn validate_uuid_v7(value: &str, label: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.get(8) == Some(&b'-')
        && bytes.get(13) == Some(&b'-')
        && bytes.get(14) == Some(&b'7')
        && bytes.get(18) == Some(&b'-')
        && bytes.get(23) == Some(&b'-')
        && bytes
            .get(19)
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        return Ok(());
    }
    Err(invalid(&format!("{label} must be a canonical UUIDv7")))
}

fn valid_iso_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|parsed| parsed.format("%Y-%m-%d").to_string() == value)
        .unwrap_or(false)
}

fn valid_datetime(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.offset().local_minus_utc() == 0 && value.ends_with('Z'))
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn transition_lifecycle(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_metadata_revision: i64,
    restore: bool,
) -> Result<LibraryApplyOutcome, StoreError> {
    let page = read_page(connection, library_id, page_id)?;
    authorize_page_write(connection, context, library_id, &page)?;
    let membership = read_active_membership(connection, page_id)?;
    validate_parent_membership(&page, membership.as_ref())?;
    let (from, to, operation_kind, state) = if restore {
        (
            "archived",
            "active",
            "unarchive_page",
            LibraryPageLifecycleState::Active,
        )
    } else {
        (
            "active",
            "archived",
            "archive_page",
            LibraryPageLifecycleState::Archived,
        )
    };
    if page.lifecycle != from {
        return Err(conflict(&format!(
            "Page {page_id} is {}; {operation_kind} requires {from}",
            page.lifecycle
        )));
    }
    if page.metadata_revision != expected_metadata_revision {
        return Err(conflict("Page metadata revision changed"));
    }
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let metadata_revision = expected_metadata_revision + 1;
            let changed = connection.execute(
                "UPDATE blocks SET lifecycle = ?1, metadata_revision = ?2, updated_at = ?3 \
         WHERE id = ?4 AND library_id = ?5 AND type = 'page' AND lifecycle = ?6 \
           AND metadata_revision = ?7",
                params![
                    to,
                    metadata_revision,
                    now,
                    page_id,
                    page.library_id,
                    from,
                    expected_metadata_revision
                ],
            )?;
            if changed != 1 {
                return Err(conflict("Page changed during lifecycle transition"));
            }
            synchronize_page_lifecycle(connection, &page, to, metadata_revision, &now)?;
            let library_rank_key = read_library_rank(connection, library_id, page_id)?;
            let receipt = lifecycle_receipt(
                operation_kind,
                &page,
                state,
                metadata_revision,
                membership.as_ref(),
                library_rank_key,
            );
            seal_page_lifecycle(
                scope,
                context,
                operation_id,
                &page,
                membership.as_ref(),
                receipt,
                BTreeMap::from([(format!("blockMetadata:{page_id}"), metadata_revision)]),
                Vec::new(),
                Vec::new(),
                vec![page.document_id.clone()],
                now.clone(),
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn move_in_library(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_parent_revision: i64,
    before_block_id: Option<&str>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let page = read_page(connection, library_id, page_id)?;
    authorize_page_write(connection, context, library_id, &page)?;
    let membership = read_active_membership(connection, page_id)?;
    validate_parent_membership(&page, membership.as_ref())?;
    let current_rank = read_library_rank(connection, library_id, page_id)?;
    if page.lifecycle == "deleted"
        || page.parent_kind != "library"
        || page.parent_id != page.library_id
        || membership.is_some()
        || current_rank.is_none()
    {
        return Err(invalid(
            "Page is not a placed non-deleted top-level Library Page",
        ));
    }
    if page.parent_revision != expected_parent_revision {
        return Err(conflict("Page parent revision changed"));
    }
    if before_block_id == Some(page_id) {
        return Err(invalid("Page cannot move before itself"));
    }
    let items = connection
        .prepare(
            "SELECT block_id, rank_key FROM library_block_placements \
             WHERE library_id = ?1 ORDER BY rank_key, block_id",
        )?
        .query_map([library_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(&items, page_id, before_block_id).map_err(|error| {
        if error.code == FractionalRankErrorCode::AnchorNotFound {
            return invalid(&error.message);
        }
        StoreError::new(StoreErrorCode::ResourceExhausted, error.message, false)
    })?;
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            for (sibling_id, rank_key) in &plan.rebalanced_rank_keys {
                synchronize_library_placement_rank(
                    connection, library_id, sibling_id, rank_key, &now,
                )?;
            }
            let changed = connection.execute(
                "UPDATE library_block_placements SET rank_key = ?1, revision = revision + 1, \
           updated_at = ?2 WHERE block_id = ?3 AND library_id = ?4",
                params![plan.rank_key, now, page_id, library_id],
            )?;
            if changed != 1 {
                return Err(corrupt("Page lost its Library placement during move"));
            }
            let parent_revision = expected_parent_revision + 1;
            let changed = connection.execute(
                "UPDATE blocks SET placement_revision = ?1, updated_at = ?2 \
         WHERE id = ?3 AND library_id = ?4 AND type = 'page' AND placement_revision = ?5",
                params![
                    parent_revision,
                    now,
                    page_id,
                    page.library_id,
                    expected_parent_revision
                ],
            )?;
            if changed != 1 {
                return Err(conflict("Page changed during Library move"));
            }
            let changed = connection.execute(
                "UPDATE page_read_model SET library_rank_key = ?1, placement_revision = ?2, \
           updated_at = ?3 WHERE page_block_id = ?4 AND library_id = ?5",
                params![
                    plan.rank_key,
                    parent_revision,
                    now,
                    page_id,
                    page.library_id
                ],
            )?;
            if changed != 1 {
                return Err(corrupt("Page read projection disappeared during move"));
            }
            let receipt = LibraryPageLifecycleMutationReceipt {
                operation_kind: "move_page_in_library".to_owned(),
                page_id: page_id.to_owned(),
                metadata_revision: page.metadata_revision,
                parent_revision,
                lifecycle: lifecycle_state(&page.lifecycle)?,
                document_id: page.document_id.clone(),
                document_generation: page.document_generation,
                document_head_seq: page.document_head_seq,
                database_id: None,
                data_source_id: None,
                membership_id: None,
                view_id: None,
                library_rank_key: Some(plan.rank_key),
                view_rank_key: None,
                created_block_ids: Vec::new(),
                created_tag_option_ids: Vec::new(),
                delete_evidence: None,
            };
            seal_page_lifecycle(
                scope,
                context,
                operation_id,
                &page,
                None,
                receipt,
                BTreeMap::from([(format!("blockLocation:{page_id}"), parent_revision)]),
                Vec::new(),
                Vec::new(),
                vec![page.document_id.clone()],
                now.clone(),
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn delete_page(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_metadata_revision: i64,
    expected_parent_revision: i64,
    parent_document_head: Option<&LibraryDocumentHead>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let page = read_page(connection, library_id, page_id)?;
    authorize_page_write(connection, context, library_id, &page)?;
    let membership = read_active_membership(connection, page_id)?;
    validate_parent_membership(&page, membership.as_ref())?;
    if page.lifecycle == "deleted" {
        return Err(conflict("Page is already deleted"));
    }
    if page.metadata_revision != expected_metadata_revision {
        return Err(conflict("Page metadata revision changed"));
    }
    if page.parent_revision != expected_parent_revision {
        return Err(conflict("Page parent revision changed"));
    }
    let (parent_document, nested_parent) =
        resolve_nested_parent_document(connection, &page, parent_document_head)?;
    let closure = read_indexed_closure(connection, &page)?;
    if closure
        .blocks
        .iter()
        .any(|block| block.lifecycle != "active")
    {
        return Err(corrupt(
            "Page Document closure contains a non-active indexed Block",
        ));
    }
    let previous_lifecycle = match page.lifecycle.as_str() {
        "active" => LibraryLifecycle::Active,
        "archived" => LibraryLifecycle::Archived,
        _ => return Err(corrupt("Page lifecycle is invalid before delete")),
    };
    let library_rank_key = read_library_rank(connection, library_id, page_id)?;
    if page.parent_kind == "library" && library_rank_key.is_none() {
        return Err(corrupt("Top-level Page has no Library placement"));
    }
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            connection.execute(
                "DELETE FROM database_view_page_positions WHERE page_block_id = ?1",
                [page_id],
            )?;
            let relation_outcomes = membership
                .as_ref()
                .map(|membership| {
                    crate::database::remove_membership_task_parent_edges(
                        connection,
                        &membership.data_source_id,
                        &membership.membership_id,
                        &now,
                    )
                })
                .transpose()?
                .unwrap_or_default();
            let relation_metadata_revisions =
                crate::database::synchronize_relation_value_projections(
                    connection,
                    &relation_outcomes,
                    Some(page_id),
                    &now,
                )?;
            if let Some(membership) = &membership {
                let changed = connection.execute(
            "UPDATE data_source_page_memberships SET removed_at = ?1, revision = revision + 1 \
             WHERE id = ?2 AND data_source_id = ?3 AND page_block_id = ?4 \
               AND removed_at IS NULL AND revision = ?5",
            params![
                now,
                membership.membership_id,
                membership.data_source_id,
                page_id,
                membership.membership_revision
            ],
        )?;
                if changed != 1 {
                    return Err(conflict("Page membership changed during delete"));
                }
            }
            connection.execute(
                "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
                params![page_id, library_id],
            )?;
            let metadata_revision = expected_metadata_revision + 1;
            let parent_revision = expected_parent_revision + 1;
            let changed = connection.execute(
                "UPDATE blocks SET lifecycle = 'deleted', metadata_revision = ?1, \
           placement_revision = ?2, updated_at = ?3 \
         WHERE id = ?4 AND library_id = ?5 AND type = 'page' AND lifecycle = ?6 \
           AND metadata_revision = ?7 AND placement_revision = ?8",
                params![
                    metadata_revision,
                    parent_revision,
                    now,
                    page_id,
                    page.library_id,
                    page.lifecycle,
                    expected_metadata_revision,
                    expected_parent_revision
                ],
            )?;
            if changed != 1 {
                return Err(conflict("Page changed during delete"));
            }
            let mut tombstoned_blocks = Vec::with_capacity(closure.blocks.len());
            for block in &closure.blocks {
                let committed_revision = block.metadata_revision + 1;
                let changed = connection.execute(
            "UPDATE blocks SET lifecycle = 'deleted', metadata_revision = ?1, updated_at = ?2 \
             WHERE id = ?3 AND library_id = ?4 AND lifecycle = 'active' \
               AND metadata_revision = ?5",
            params![
                committed_revision,
                now,
                block.block_id,
                page.library_id,
                block.metadata_revision
            ],
        )?;
                if changed != 1 {
                    return Err(conflict("Indexed Block changed during Page delete"));
                }
                tombstoned_blocks.push(LibraryPageLifecycleDeletedBlock {
                    block_id: block.block_id.clone(),
                    metadata_revision: committed_revision,
                    resource_metadata_revision: (block.block_type == "database")
                        .then_some(block.resource_metadata_revision)
                        .flatten()
                        .map(|revision| revision + 1),
                });
            }
            synchronize_deleted_page(connection, &page, metadata_revision, parent_revision, &now)?;
            synchronize_deleted_indexed_owners(connection, &page, &closure, &now)?;
            let parent_commit = parent_document
                .as_ref()
                .map(|parent| {
                    persist_parent_operations_detailed_with_local_commit(
                        connection,
                        ParentDocumentWriteContext {
                            actor_project_id: context
                                .project_id
                                .as_ref()
                                .map(|project_id| project_id.0.as_str())
                                .ok_or_else(|| corrupt("Page delete lost its actor Project"))?,
                            store_epoch,
                            operation_id,
                            commit: scope.evidence(),
                        },
                        "page-delete",
                        parent,
                        &[DocumentBlockOperation::DeleteBlock {
                            block_id: page_id.to_owned(),
                        }],
                        ParentDocumentPlacement::Derived {
                            attachment_advances: &[],
                        },
                    )
                })
                .transpose()?;
            let restore_membership =
                membership
                    .as_ref()
                    .map(|membership| LibraryPageLifecycleMutationMembership {
                        membership_id: membership.membership_id.clone(),
                        database_id: membership.database_id.clone(),
                        data_source_id: membership.data_source_id.clone(),
                        status: membership.status,
                        position: membership.view_id.as_ref().map(|view_id| {
                            LibraryPageLifecycleRestorePosition {
                                view_id: view_id.clone(),
                                before_view_page_id: None,
                            }
                        }),
                    });
            let delete_evidence = LibraryPageLifecycleDeleteEvidence {
                previous_lifecycle,
                membership: restore_membership,
                tombstoned_blocks: tombstoned_blocks.clone(),
                indexed_document_ids: closure.document_ids.clone(),
                nested_parent,
            };
            let receipt = LibraryPageLifecycleMutationReceipt {
                operation_kind: "delete_page".to_owned(),
                page_id: page_id.to_owned(),
                metadata_revision,
                parent_revision,
                lifecycle: LibraryPageLifecycleState::Deleted,
                document_id: page.document_id.clone(),
                document_generation: page.document_generation,
                document_head_seq: page.document_head_seq,
                database_id: membership
                    .as_ref()
                    .map(|membership| membership.database_id.clone()),
                data_source_id: membership
                    .as_ref()
                    .map(|membership| membership.data_source_id.clone()),
                membership_id: membership
                    .as_ref()
                    .map(|membership| membership.membership_id.clone()),
                view_id: membership
                    .as_ref()
                    .and_then(|membership| membership.view_id.clone()),
                library_rank_key: None,
                view_rank_key: None,
                created_block_ids: Vec::new(),
                created_tag_option_ids: Vec::new(),
                delete_evidence: Some(delete_evidence),
            };
            let mut affected_document_ids = closure.document_ids.clone();
            if let Some(parent) = &parent_commit {
                affected_document_ids.push(parent.document_id.clone());
            }
            affected_document_ids.sort();
            affected_document_ids.dedup();
            let mut committed_revisions = BTreeMap::from_iter(
                [
                    (format!("blockMetadata:{page_id}"), metadata_revision),
                    (format!("blockLocation:{page_id}"), parent_revision),
                ]
                .into_iter()
                .chain(tombstoned_blocks.iter().map(|block| {
                    (
                        format!("indexedBlockMetadata:{}", block.block_id),
                        block.metadata_revision,
                    )
                }))
                .chain(closure.blocks.iter().filter_map(|block| {
                    if block.block_type != "database" {
                        return None;
                    }
                    block.resource_metadata_revision.map(|revision| {
                        (format!("databaseMetadata:{}", block.block_id), revision + 1)
                    })
                })),
            );
            if let Some(parent) = &parent_commit {
                committed_revisions.insert(
                    format!("documentHead:{}", parent.document_id),
                    parent.head_seq,
                );
            }
            committed_revisions.extend(relation_outcomes.iter().map(|value| {
                (
                    format!(
                        "value:{}:{}:{}",
                        value.data_source_id, value.membership_id, value.property_id
                    ),
                    value.value_revision,
                )
            }));
            committed_revisions.extend(relation_metadata_revisions.iter().map(
                |(affected_page_id, revision)| {
                    (format!("page:{affected_page_id}:metadata"), *revision)
                },
            ));
            seal_page_lifecycle(
                scope,
                context,
                operation_id,
                &page,
                membership.as_ref(),
                receipt,
                committed_revisions,
                closure
                    .blocks
                    .iter()
                    .map(|block| block.block_id.clone())
                    .collect(),
                relation_metadata_revisions.keys().cloned().collect(),
                affected_document_ids,
                now.clone(),
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn restore_page(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    delete_operation_id: &str,
    expected_metadata_revision: i64,
    expected_parent_revision: i64,
    requested_membership: Option<&LibraryPageLifecycleMutationMembership>,
    before_block_id: Option<&str>,
    parent_document_head: Option<&LibraryDocumentHead>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let page = read_page(connection, library_id, page_id)?;
    if page.lifecycle != "deleted" {
        return Err(conflict("Page restore requires a deleted Page"));
    }
    if page.metadata_revision != expected_metadata_revision {
        return Err(conflict("Page metadata revision changed"));
    }
    if page.parent_revision != expected_parent_revision {
        return Err(conflict("Page parent revision changed"));
    }
    if read_active_membership(connection, page_id)?.is_some() {
        return Err(corrupt(
            "Deleted Page unexpectedly has an active membership",
        ));
    }
    let coordinates = PageTombstoneCoordinates::from(&page);
    let stored = read_delete_receipt(connection, delete_operation_id, &coordinates)?;
    let evidence = stored
        .delete_evidence
        .as_ref()
        .ok_or_else(|| corrupt("Delete receipt has no restore evidence"))?;
    authorize_page_restore(connection, context, library_id, &page, evidence)?;
    let (parent_document, nested_parent) =
        resolve_nested_parent_for_restore(connection, &page, evidence, parent_document_head)?;
    if evidence.membership.as_ref() != requested_membership {
        return Err(invalid(
            "Restore membership does not match the durable delete evidence",
        ));
    }
    if page.parent_kind == "page" {
        if requested_membership.is_some() || evidence.membership.is_some() {
            return Err(corrupt(
                "Nested Page restore cannot carry a Data Source membership",
            ));
        }
    } else if (requested_membership.is_none() && page.parent_kind != "library")
        || (requested_membership.is_some() && page.parent_kind != "data_source")
    {
        return Err(corrupt("Restore parent does not match the Page tombstone"));
    }
    let closure = read_indexed_closure(connection, &page)?;
    validate_delete_evidence(&page, evidence, &closure)?;
    let now = sqlite_now(connection)?;
    let commit_result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let mut library_rank_key = None;
            let mut restored_membership = None;
            let mut view_id = None;
            let mut view_rank_key = None;
            if let Some(requested) = requested_membership {
                restored_membership = Some(restore_membership(
                    connection, library_id, page_id, requested, &now,
                )?);
                if let Some(position) = &requested.position {
                    let rank_key =
                        restore_view_position(connection, page_id, requested, position, &now)?;
                    view_id = Some(position.view_id.clone());
                    view_rank_key = Some(rank_key);
                }
            }
            let target_lifecycle = match evidence.previous_lifecycle {
                LibraryLifecycle::Active => "active",
                LibraryLifecycle::Archived => "archived",
            };
            let metadata_revision = expected_metadata_revision + 1;
            let parent_revision = expected_parent_revision + 1;
            let changed = connection.execute(
                "UPDATE blocks SET lifecycle = ?1, metadata_revision = ?2, placement_revision = ?3, \
           updated_at = ?4 WHERE id = ?5 AND library_id = ?6 AND type = 'page' \
           AND lifecycle = 'deleted' AND metadata_revision = ?7 AND placement_revision = ?8",
                params![
                    target_lifecycle,
                    metadata_revision,
                    parent_revision,
                    now,
                    page_id,
                    page.library_id,
                    expected_metadata_revision,
                    expected_parent_revision
                ],
            )?;
            if changed != 1 {
                return Err(conflict("Page changed during restore"));
            }
            if requested_membership.is_none() && page.parent_kind == "library" {
                library_rank_key = Some(restore_library_placement(
                    connection,
                    library_id,
                    page_id,
                    before_block_id,
                    &now,
                )?);
            }
            for block in &evidence.tombstoned_blocks {
                let changed = connection.execute(
            "UPDATE blocks SET lifecycle = 'active', metadata_revision = metadata_revision + 1, \
               updated_at = ?1 WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'deleted' \
               AND metadata_revision = ?4",
            params![
                now,
                block.block_id,
                page.library_id,
                block.metadata_revision
            ],
        )?;
                if changed != 1 {
                    return Err(conflict("Indexed Block changed during Page restore"));
                }
            }
            synchronize_restored_indexed_owners(
                connection,
                &page,
                &closure,
                &evidence.tombstoned_blocks,
                &now,
            )?;
            synchronize_restored_page(
                connection,
                &page,
                target_lifecycle,
                metadata_revision,
                parent_revision,
                restored_membership.as_ref(),
                view_id.as_deref(),
                view_rank_key.as_deref(),
                library_rank_key.as_deref(),
                &now,
            )?;
            let parent_commit = match (parent_document.as_ref(), nested_parent.as_ref()) {
                (Some(parent), Some(nested_parent)) => {
                    Some(persist_parent_operations_detailed_with_local_commit(
                        connection,
                        ParentDocumentWriteContext {
                            actor_project_id: context
                                .project_id
                                .as_ref()
                                .map(|project_id| project_id.0.as_str())
                                .ok_or_else(|| corrupt("Page restore lost its actor Project"))?,
                            store_epoch,
                            operation_id,
                            commit: scope.evidence(),
                        },
                        "page-restore",
                        parent,
                        &[DocumentBlockOperation::InsertBlock {
                            block: MaterializedBlockNode {
                                id: page_id.to_owned(),
                                block_type: "page".to_owned(),
                                props: BTreeMap::new(),
                                content: None,
                                children: Vec::new(),
                            },
                            parent_block_id: nested_parent.parent_block_id.clone(),
                            before_block_id: nested_parent.before_block_id.clone(),
                        }],
                        ParentDocumentPlacement::Preapplied(&[page_id.to_owned()]),
                    )?)
                }
                (None, None) => None,
                _ => {
                    return Err(corrupt(
                        "Nested Page restore parent resolution is incomplete",
                    ));
                }
            };
            let receipt = LibraryPageLifecycleMutationReceipt {
                operation_kind: "restore_page".to_owned(),
                page_id: page_id.to_owned(),
                metadata_revision,
                parent_revision,
                lifecycle: lifecycle_state(target_lifecycle)?,
                document_id: page.document_id.clone(),
                document_generation: page.document_generation,
                document_head_seq: page.document_head_seq,
                database_id: restored_membership
                    .as_ref()
                    .map(|membership| membership.database_id.clone()),
                data_source_id: restored_membership
                    .as_ref()
                    .map(|membership| membership.data_source_id.clone()),
                membership_id: restored_membership
                    .as_ref()
                    .map(|membership| membership.membership_id.clone()),
                view_id,
                library_rank_key,
                view_rank_key,
                created_block_ids: Vec::new(),
                created_tag_option_ids: Vec::new(),
                delete_evidence: None,
            };
            let mut committed_revisions = BTreeMap::from_iter(
                [
                    (format!("blockMetadata:{page_id}"), metadata_revision),
                    (format!("blockLocation:{page_id}"), parent_revision),
                ]
                .into_iter()
                .chain(evidence.tombstoned_blocks.iter().map(|block| {
                    (
                        format!("indexedBlockMetadata:{}", block.block_id),
                        block.metadata_revision + 1,
                    )
                }))
                .chain(evidence.tombstoned_blocks.iter().filter_map(|block| {
                    block.resource_metadata_revision.map(|revision| {
                        (format!("databaseMetadata:{}", block.block_id), revision + 1)
                    })
                })),
            );
            if let Some(parent) = &parent_commit {
                committed_revisions.insert(
                    format!("documentHead:{}", parent.document_id),
                    parent.head_seq,
                );
            }
            let mut affected_document_ids = closure.document_ids.clone();
            if let Some(parent) = &parent_commit {
                affected_document_ids.push(parent.document_id.clone());
            }
            affected_document_ids.sort();
            affected_document_ids.dedup();
            seal_page_lifecycle(
                scope,
                context,
                operation_id,
                &page,
                restored_membership.as_ref(),
                receipt,
                committed_revisions,
                closure
                    .blocks
                    .iter()
                    .map(|block| block.block_id.clone())
                    .collect(),
                Vec::new(),
                affected_document_ids,
                now.clone(),
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

fn resolve_nested_parent_document(
    connection: &Connection,
    page: &PageAuthority,
    requested_head: Option<&LibraryDocumentHead>,
) -> Result<
    (
        Option<super::mutation::ResolvedParentDocument>,
        Option<LibraryPageLifecycleNestedParent>,
    ),
    StoreError,
> {
    if page.parent_kind != "page" {
        if requested_head.is_some() {
            return Err(invalid(
                "Only a nested Page deletion may carry a parent Document head",
            ));
        }
        return Ok((None, None));
    }

    let parent_document_id = page
        .containing_document_id
        .as_deref()
        .ok_or_else(|| corrupt("Nested Page has no containing Document"))?;
    let requested_head = requested_head
        .ok_or_else(|| invalid("Nested Page deletion requires the host Page Document head"))?;
    if requested_head.document_id != parent_document_id {
        return Err(conflict("Nested Page host Document changed"));
    }
    let parent = super::mutation::load_parent_document(connection, parent_document_id)?;
    if parent.authority.owner_lifecycle != "active"
        || parent.authority.owner_block_id != page.parent_id
    {
        return Err(corrupt("Nested Page host Page authority is invalid"));
    }
    if parent.authority.head.generation != requested_head.generation
        || parent.authority.head.head_seq != requested_head.head_seq
    {
        return Err(conflict("Nested Page host Document changed"));
    }
    let Some((parent_block_id, before_block_id, has_children)) =
        locate_block_position(&parent.base_materialization.block_tree, &page.page_id, None)
    else {
        return Err(corrupt(
            "Nested Page shell is missing from its host Document",
        ));
    };
    if has_children {
        return Err(corrupt("Nested Page shell unexpectedly contains children"));
    }
    Ok((
        Some(parent),
        Some(LibraryPageLifecycleNestedParent {
            document_id: parent_document_id.to_owned(),
            parent_block_id,
            before_block_id,
        }),
    ))
}

fn resolve_nested_parent_for_restore(
    connection: &Connection,
    page: &PageAuthority,
    evidence: &LibraryPageLifecycleDeleteEvidence,
    requested_head: Option<&LibraryDocumentHead>,
) -> Result<
    (
        Option<super::mutation::ResolvedParentDocument>,
        Option<LibraryPageLifecycleNestedParent>,
    ),
    StoreError,
> {
    if page.parent_kind != "page" {
        if requested_head.is_some() || evidence.nested_parent.is_some() {
            return Err(corrupt(
                "Non-nested Page delete evidence carries a host Document",
            ));
        }
        return Ok((None, None));
    }
    let nested_parent = evidence
        .nested_parent
        .clone()
        .ok_or_else(|| corrupt("Nested Page delete evidence has no host position"))?;
    // Deletion intentionally removes the Page shell from the host Document
    // index, so the current physical projection cannot name that Document.
    // The durable delete receipt owns the exact restore coordinate; the typed
    // parent authority below independently proves that it is still valid.
    let parent_document_id = nested_parent.document_id.as_str();
    let requested_head = requested_head
        .ok_or_else(|| invalid("Nested Page restore requires the host Page Document head"))?;
    if requested_head.document_id != parent_document_id {
        return Err(conflict("Nested Page host Document changed"));
    }
    let parent = super::mutation::load_parent_document(connection, parent_document_id)?;
    if parent.authority.owner_lifecycle != "active"
        || parent.authority.owner_block_id != page.parent_id
    {
        return Err(corrupt("Nested Page host Page authority is invalid"));
    }
    if parent.authority.head.generation != requested_head.generation
        || parent.authority.head.head_seq != requested_head.head_seq
    {
        return Err(conflict("Nested Page host Document changed"));
    }
    if locate_block_position(&parent.base_materialization.block_tree, &page.page_id, None).is_some()
    {
        return Err(conflict("Nested Page shell is already present"));
    }
    Ok((Some(parent), Some(nested_parent)))
}

fn locate_block_position(
    blocks: &[MaterializedBlockNode],
    target_id: &str,
    parent_block_id: Option<&str>,
) -> Option<(Option<String>, Option<String>, bool)> {
    for (index, block) in blocks.iter().enumerate() {
        if block.id == target_id {
            return Some((
                parent_block_id.map(str::to_owned),
                blocks.get(index + 1).map(|next| next.id.clone()),
                !block.children.is_empty(),
            ));
        }
        if let Some(position) =
            locate_block_position(&block.children, target_id, Some(block.id.as_str()))
        {
            return Some(position);
        }
    }
    None
}

fn synchronize_deleted_indexed_owners(
    connection: &Connection,
    page: &PageAuthority,
    closure: &IndexedClosure,
    now: &str,
) -> Result<(), StoreError> {
    for block in &closure.blocks {
        match block.block_type.as_str() {
            "page" => {
                if connection
                    .query_row(
                        "SELECT 1 FROM data_source_page_memberships \
                         WHERE page_block_id = ?1 AND removed_at IS NULL LIMIT 1",
                        [&block.block_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some()
                {
                    return Err(corrupt(
                        "Nested Page closure contains an active Data Source membership",
                    ));
                }
                let changed = connection.execute(
                    "UPDATE page_read_model SET lifecycle = 'deleted', metadata_revision = ?1, \
                       placement_revision = ?2, library_rank_key = NULL, membership_id = NULL, \
                       database_block_id = NULL, view_id = NULL, view_group_key = NULL, \
                       view_rank_key = NULL, database_values_json = '{}', updated_at = ?3 \
                     WHERE page_block_id = ?4 AND library_id = ?5",
                    params![
                        block.metadata_revision + 1,
                        block.placement_revision,
                        now,
                        block.block_id,
                        page.library_id,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt("Nested Page lifecycle projection disappeared"));
                }
                connection.execute(
                    "UPDATE scheduled_page_index SET lifecycle = 'deleted', \
                       source_metadata_revision = ?1, updated_at = ?2 \
                     WHERE page_block_id = ?3 AND library_id = ?4",
                    params![
                        block.metadata_revision + 1,
                        now,
                        block.block_id,
                        page.library_id,
                    ],
                )?;
            }
            "database" => {
                let expected_resource_revision = block
                    .resource_metadata_revision
                    .ok_or_else(|| corrupt("Database closure has no lifecycle metadata"))?;
                let changed = connection.execute(
                    "UPDATE database_containers SET lifecycle = 'deleted', \
                       metadata_revision = ?1, updated_at = ?2 \
                     WHERE block_id = ?3 AND library_id = ?4 AND lifecycle = 'active' \
                       AND metadata_revision = ?5",
                    params![
                        expected_resource_revision + 1,
                        now,
                        block.block_id,
                        page.library_id,
                        expected_resource_revision,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt("Nested Database lifecycle authority disappeared"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn synchronize_restored_indexed_owners(
    connection: &Connection,
    page: &PageAuthority,
    closure: &IndexedClosure,
    tombstoned_blocks: &[LibraryPageLifecycleDeletedBlock],
    now: &str,
) -> Result<(), StoreError> {
    for block in &closure.blocks {
        let Some(tombstone) = tombstoned_blocks
            .iter()
            .find(|candidate| candidate.block_id == block.block_id)
        else {
            return Err(corrupt("Nested Page restore evidence is incomplete"));
        };
        match block.block_type.as_str() {
            "page" => {
                let metadata_revision = tombstone.metadata_revision + 1;
                let changed = connection.execute(
                    "UPDATE page_read_model SET lifecycle = 'active', metadata_revision = ?1, \
                       placement_revision = ?2, updated_at = ?3 \
                     WHERE page_block_id = ?4 AND library_id = ?5 AND lifecycle = 'deleted' \
                       AND metadata_revision = ?6 AND placement_revision = ?7",
                    params![
                        metadata_revision,
                        block.placement_revision,
                        now,
                        block.block_id,
                        page.library_id,
                        tombstone.metadata_revision,
                        block.placement_revision,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt(
                        "Nested Page lifecycle projection disappeared during restore",
                    ));
                }
                connection.execute(
                    "UPDATE scheduled_page_index SET lifecycle = 'active', \
                       source_metadata_revision = ?1, updated_at = ?2 \
                     WHERE page_block_id = ?3 AND library_id = ?4",
                    params![metadata_revision, now, block.block_id, page.library_id],
                )?;
            }
            "database" => {
                let expected_resource_revision =
                    tombstone.resource_metadata_revision.ok_or_else(|| {
                        corrupt("Database restore evidence has no lifecycle metadata")
                    })?;
                let changed = connection.execute(
                    "UPDATE database_containers SET lifecycle = 'active', \
                       metadata_revision = ?1, updated_at = ?2 \
                     WHERE block_id = ?3 AND library_id = ?4 AND lifecycle = 'deleted' \
                       AND metadata_revision = ?5",
                    params![
                        expected_resource_revision + 1,
                        now,
                        block.block_id,
                        page.library_id,
                        expected_resource_revision,
                    ],
                )?;
                if changed != 1 {
                    return Err(corrupt(
                        "Nested Database lifecycle authority disappeared during restore",
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_indexed_closure(
    connection: &Connection,
    page: &PageAuthority,
) -> Result<IndexedClosure, StoreError> {
    let mut pending = VecDeque::from([page.document_id.clone()]);
    let mut document_ids = BTreeSet::new();
    let mut blocks = BTreeMap::<String, IndexedBlock>::new();
    while let Some(document_id) = pending.pop_front() {
        if !document_ids.insert(document_id.clone()) {
            continue;
        }
        let authority = connection
            .query_row(
                "SELECT library_id, head_seq, readiness, authority FROM documents WHERE id = ?1",
                [&document_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((document_library_id, head_seq, readiness, authority)) = authority else {
            return Err(corrupt(
                "Indexed Page ownership references a missing Document",
            ));
        };
        if document_library_id != page.library_id
            || readiness != "ready"
            || authority != "ydoc_primary"
        {
            return Err(corrupt("Indexed Page Document authority is invalid"));
        }
        let indexed = connection
            .prepare(
                "SELECT index_row.block_id, index_row.projected_seq, block.type, block.lifecycle, \
                   block.metadata_revision, block.placement_revision, \
                   CASE WHEN block.type = 'page' THEN page.block_id \
                        WHEN block.type = 'database' THEN container.block_id END, \
                   CASE WHEN block.type = 'page' THEN block.lifecycle \
                        WHEN block.type = 'database' THEN container.lifecycle END, \
                   CASE WHEN block.type = 'page' THEN block.metadata_revision \
                        WHEN block.type = 'database' THEN container.metadata_revision END \
                 FROM document_block_index index_row \
                 JOIN blocks block ON block.id = index_row.block_id AND block.library_id = ?2 \
                 LEFT JOIN pages page ON page.block_id = block.id AND page.library_id = block.library_id \
                 LEFT JOIN database_containers container \
                   ON container.block_id = block.id AND container.library_id = block.library_id \
                 WHERE index_row.document_id = ?1 ORDER BY index_row.block_id",
            )?
            .query_map(params![document_id, page.library_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (
            block_id,
            projected_seq,
            block_type,
            lifecycle,
            metadata_revision,
            placement_revision,
            typed_owner_id,
            resource_lifecycle,
            resource_metadata_revision,
        ) in indexed
        {
            if projected_seq != head_seq || blocks.contains_key(&block_id) {
                return Err(corrupt("Page Document Block index is stale or ambiguous"));
            }
            if matches!(block_type.as_str(), "page" | "database")
                && (typed_owner_id.is_none()
                    || resource_lifecycle.as_deref() != Some(lifecycle.as_str())
                    || resource_metadata_revision.is_none())
            {
                return Err(corrupt(
                    "Typed Block lifecycle authority is missing or diverged",
                ));
            }
            let owned_documents = connection
                .prepare(
                    "SELECT document_id FROM block_documents WHERE block_id = ?1 ORDER BY document_id",
                )?
                .query_map([&block_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            pending.extend(owned_documents);
            blocks.insert(
                block_id.clone(),
                IndexedBlock {
                    block_id,
                    block_type,
                    lifecycle,
                    metadata_revision,
                    placement_revision,
                    resource_metadata_revision,
                },
            );
        }
    }
    Ok(IndexedClosure {
        blocks: blocks.into_values().collect(),
        document_ids: document_ids.into_iter().collect(),
    })
}

fn read_delete_receipt(
    connection: &Connection,
    delete_operation_id: &str,
    page: &PageTombstoneCoordinates<'_>,
) -> Result<LibraryPageLifecycleMutationReceipt, StoreError> {
    let stored = connection
        .query_row(
            "SELECT result_json, event_sequence, store_epoch FROM core_module_receipts \
             WHERE module_name = 'library' AND operation_id = ?1 \
               AND operation_kind = 'delete_page'",
            [delete_operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((result_json, event_sequence, receipt_store_epoch)) = stored else {
        return Err(invalid("Durable Page delete evidence does not exist"));
    };
    let committed = serde_json::from_str::<
        crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>,
    >(&result_json)
    .map_err(|_| corrupt("Durable Page delete receipt is invalid"))?;
    let lifecycle = committed
        .value
        .page_lifecycle
        .ok_or_else(|| corrupt("Durable Page delete receipt has no lifecycle result"))?;
    let valid = event_sequence == Some(committed.event_sequence)
        && committed.store_epoch.0 == receipt_store_epoch
        && committed.receipt.mutation.operation_id == delete_operation_id
        && committed.receipt.operation_kind == "delete_page"
        && lifecycle.operation_kind == "delete_page"
        && lifecycle.page_id == page.page_id
        && lifecycle.lifecycle == LibraryPageLifecycleState::Deleted
        && lifecycle.metadata_revision == page.metadata_revision
        && lifecycle.parent_revision == page.parent_revision
        && lifecycle.document_id == page.document_id
        && lifecycle.document_generation == page.document_generation
        && lifecycle.document_head_seq == page.document_head_seq;
    if valid {
        return Ok(lifecycle);
    }
    Err(corrupt(
        "Durable Page delete receipt does not name the current tombstone",
    ))
}

fn validate_delete_evidence(
    page: &PageAuthority,
    evidence: &LibraryPageLifecycleDeleteEvidence,
    closure: &IndexedClosure,
) -> Result<(), StoreError> {
    if evidence.indexed_document_ids != closure.document_ids
        || evidence.tombstoned_blocks.len() != closure.blocks.len()
    {
        return Err(corrupt("Delete evidence closure changed before restore"));
    }
    for evidence_block in &evidence.tombstoned_blocks {
        let Some(current) = closure
            .blocks
            .iter()
            .find(|block| block.block_id == evidence_block.block_id)
        else {
            return Err(corrupt(
                "Delete evidence references an unknown indexed Block",
            ));
        };
        if current.lifecycle != "deleted"
            || current.metadata_revision != evidence_block.metadata_revision
            || (current.block_type == "database"
                && current.resource_metadata_revision != evidence_block.resource_metadata_revision)
        {
            return Err(conflict("Indexed Page tombstone changed before restore"));
        }
    }
    if evidence.membership.is_some() != (page.parent_kind == "data_source") {
        return Err(corrupt(
            "Delete evidence membership disagrees with Page parent",
        ));
    }
    if evidence.nested_parent.is_some() != (page.parent_kind == "page") {
        return Err(corrupt(
            "Delete evidence host position disagrees with Page parent",
        ));
    }
    Ok(())
}

pub(super) fn read_restore_evidence(
    connection: &Connection,
    lifecycle: &str,
    page: &PageTombstoneCoordinates<'_>,
) -> Result<Option<LibraryPageLifecycleRestoreEvidence>, StoreError> {
    if lifecycle != "deleted" {
        return Ok(None);
    }
    let operation_id = connection
        .query_row(
            "SELECT operation_id FROM core_module_receipts \
             WHERE module_name = 'library' AND operation_kind = 'delete_page' \
               AND json_extract(result_json, '$.value.page_lifecycle.page_id') = ?1 \
             ORDER BY event_sequence DESC LIMIT 1",
            [page.page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(operation_id) = operation_id else {
        return Ok(None);
    };
    let receipt = read_delete_receipt(connection, &operation_id, page)?;
    let evidence = receipt
        .delete_evidence
        .ok_or_else(|| corrupt("Durable Page delete receipt has no restore evidence"))?;
    Ok(Some(LibraryPageLifecycleRestoreEvidence {
        delete_operation_id: operation_id,
        previous_lifecycle: evidence.previous_lifecycle,
        membership: evidence
            .membership
            .map(|membership| LibraryPageLifecycleRestoreMembership {
                membership_id: membership.membership_id,
                database_id: membership.database_id,
                data_source_id: membership.data_source_id,
                status: membership.status,
                view_id: membership.position.map(|position| position.view_id),
            }),
        nested_parent: evidence.nested_parent,
    }))
}

fn synchronize_deleted_page(
    connection: &Connection,
    page: &PageAuthority,
    metadata_revision: i64,
    parent_revision: i64,
    now: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE page_read_model SET lifecycle = 'deleted', metadata_revision = ?1, \
           placement_revision = ?2, library_rank_key = NULL, membership_id = NULL, \
           database_block_id = NULL, view_id = NULL, view_group_key = NULL, \
           view_rank_key = NULL, database_values_json = '{}', \
           property_revisions_json = json_set(property_revisions_json, '$.database', json('{}')), \
           updated_at = ?3 WHERE page_block_id = ?4 AND library_id = ?5",
        params![
            metadata_revision,
            parent_revision,
            now,
            page.page_id,
            page.library_id
        ],
    )?;
    if changed != 1 {
        return Err(corrupt("Page tombstone projection disappeared"));
    }
    connection.execute(
        "UPDATE scheduled_page_index SET lifecycle = 'deleted', source_metadata_revision = ?1, \
           updated_at = ?2 WHERE page_block_id = ?3 AND library_id = ?4",
        params![metadata_revision, now, page.page_id, page.library_id],
    )?;
    Ok(())
}

fn restore_membership(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    requested: &LibraryPageLifecycleMutationMembership,
    now: &str,
) -> Result<MembershipCoordinates, StoreError> {
    let row = connection
        .query_row(
            "SELECT membership.revision, source.home_database_block_id \
             FROM data_source_page_memberships membership \
             JOIN data_sources source ON source.id = membership.data_source_id \
               AND source.lifecycle = 'active' \
             WHERE membership.id = ?1 AND membership.data_source_id = ?2 \
               AND membership.page_block_id = ?3 AND membership.removed_at IS NOT NULL",
            params![requested.membership_id, requested.data_source_id, page_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((revision, database_id)) = row else {
        return Err(invalid("Deleted Page membership is unavailable"));
    };
    if database_id != requested.database_id {
        return Err(corrupt("Restore membership Database identity diverges"));
    }
    let changed = connection.execute(
        "UPDATE data_source_page_memberships SET removed_at = NULL, revision = revision + 1 \
         WHERE id = ?1 AND data_source_id = ?2 AND page_block_id = ?3 \
           AND removed_at IS NOT NULL AND revision = ?4",
        params![
            requested.membership_id,
            requested.data_source_id,
            page_id,
            revision
        ],
    )?;
    if changed != 1 {
        return Err(conflict("Deleted Page membership changed during restore"));
    }
    database::ensure_database_page_key(connection, library_id, &database_id, page_id, now)?;
    Ok(MembershipCoordinates {
        membership_id: requested.membership_id.clone(),
        database_id,
        data_source_id: requested.data_source_id.clone(),
        membership_revision: revision + 1,
        status: requested.status,
        view_id: requested
            .position
            .as_ref()
            .map(|position| position.view_id.clone()),
        view_rank_key: None,
    })
}

fn restore_library_placement(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    before_block_id: Option<&str>,
    now: &str,
) -> Result<String, StoreError> {
    if before_block_id == Some(page_id) {
        return Err(invalid("Page cannot restore before itself"));
    }
    let items = connection
        .prepare(
            "SELECT block_id, rank_key FROM library_block_placements \
             WHERE library_id = ?1 ORDER BY rank_key, block_id",
        )?
        .query_map([library_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(&items, page_id, before_block_id).map_err(rank_error)?;
    for (block_id, rank_key) in &plan.rebalanced_rank_keys {
        synchronize_library_placement_rank(connection, library_id, block_id, rank_key, now)?;
    }
    connection.execute(
        "INSERT INTO library_block_placements( \
           block_id, library_id, rank_key, revision, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![page_id, library_id, plan.rank_key, now],
    )?;
    Ok(plan.rank_key)
}

fn restore_view_position(
    connection: &Connection,
    page_id: &str,
    membership: &LibraryPageLifecycleMutationMembership,
    position: &LibraryPageLifecycleRestorePosition,
    now: &str,
) -> Result<String, StoreError> {
    let valid_view = connection
        .query_row(
            "SELECT 1 FROM database_views WHERE id = ?1 AND database_block_id = ?2 \
             AND data_source_id = ?3 AND lifecycle = 'active'",
            params![
                position.view_id,
                membership.database_id,
                membership.data_source_id
            ],
            |_| Ok(()),
        )
        .optional()?;
    if valid_view.is_none() {
        return Err(invalid("Restore View is unavailable"));
    }
    let items = connection
        .prepare(
            "SELECT page_block_id, rank_key FROM database_view_page_positions \
             WHERE view_id = ?1 ORDER BY rank_key, page_block_id",
        )?
        .query_map([&position.view_id], |row| {
            Ok(RankedItem {
                id: row.get(0)?,
                rank_key: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let plan = plan_fractional_rank(&items, page_id, position.before_view_page_id.as_deref())
        .map_err(rank_error)?;
    for (positioned_page_id, rank_key) in &plan.rebalanced_rank_keys {
        connection.execute(
            "UPDATE database_view_page_positions SET rank_key = ?1, revision = revision + 1, \
               updated_at = ?2 WHERE view_id = ?3 AND page_block_id = ?4 AND rank_key <> ?1",
            params![rank_key, now, position.view_id, positioned_page_id],
        )?;
    }
    connection.execute(
        "INSERT INTO database_view_page_positions( \
           view_id, page_block_id, rank_key, revision, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![position.view_id, page_id, plan.rank_key, now],
    )?;
    Ok(plan.rank_key)
}

#[allow(clippy::too_many_arguments)]
fn synchronize_restored_page(
    connection: &Connection,
    page: &PageAuthority,
    lifecycle: &str,
    metadata_revision: i64,
    parent_revision: i64,
    membership: Option<&MembershipCoordinates>,
    view_id: Option<&str>,
    view_rank_key: Option<&str>,
    library_rank_key: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    let (database_values_json, database_revisions) = membership.map_or_else(
        || Ok(("{}".to_owned(), Map::new())),
        |membership| read_database_projection(connection, membership),
    )?;
    let projection_revisions = connection.query_row(
        "SELECT property_revisions_json FROM page_read_model WHERE page_block_id = ?1",
        [&page.page_id],
        |row| row.get::<_, String>(0),
    )?;
    let intrinsic_revisions = serde_json::from_str::<Value>(&projection_revisions)
        .ok()
        .and_then(|value| value.get("intrinsic").cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let property_revisions_json = serde_json::to_string(&json!({
        "database": database_revisions,
        "intrinsic": intrinsic_revisions,
    }))
    .map_err(|_| corrupt("Restored Page Property revisions cannot encode"))?;
    let view_group_key = membership.map(|membership| workflow_status_key(membership.status));
    let changed = connection.execute(
        "UPDATE page_read_model SET lifecycle = ?1, metadata_revision = ?2, \
           placement_revision = ?3, library_rank_key = ?4, membership_id = ?5, \
           database_block_id = ?6, view_id = ?7, view_group_key = ?8, view_rank_key = ?9, \
           database_values_json = ?10, property_revisions_json = ?11, updated_at = ?12 \
         WHERE page_block_id = ?13 AND library_id = ?14",
        params![
            lifecycle,
            metadata_revision,
            parent_revision,
            library_rank_key,
            membership.map(|membership| membership.membership_id.as_str()),
            membership.map(|membership| membership.database_id.as_str()),
            view_id,
            view_group_key,
            view_rank_key,
            database_values_json,
            property_revisions_json,
            now,
            page.page_id,
            page.library_id
        ],
    )?;
    if changed != 1 {
        return Err(corrupt("Restored Page projection disappeared"));
    }
    connection.execute(
        "UPDATE scheduled_page_index SET lifecycle = ?1, source_metadata_revision = ?2, \
           updated_at = ?3 WHERE page_block_id = ?4 AND library_id = ?5",
        params![
            lifecycle,
            metadata_revision,
            now,
            page.page_id,
            page.library_id
        ],
    )?;
    Ok(())
}

fn read_database_projection(
    connection: &Connection,
    membership: &MembershipCoordinates,
) -> Result<(String, Map<String, Value>), StoreError> {
    let rows = connection
        .prepare(
            "SELECT value.property_id, value.value_json, value.revision, property.config_json \
             FROM data_source_property_values value \
             JOIN data_source_properties property ON property.data_source_id = value.data_source_id \
               AND property.id = value.property_id AND property.lifecycle = 'active' \
             WHERE value.data_source_id = ?1 AND value.membership_id = ?2 \
             ORDER BY value.property_id",
        )?
        .query_map(
            params![membership.data_source_id, membership.membership_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut values = Map::new();
    let mut revisions = Map::new();
    for (property_id, value_json, revision, config_json) in rows {
        let mut value = serde_json::from_str::<Value>(&value_json)
            .map_err(|_| corrupt("Restored Page Property value is invalid JSON"))?;
        if property_id == "tags" {
            value = project_tag_names(&value, &config_json)?;
        }
        values.insert(property_id.clone(), value);
        revisions.insert(property_id, Value::from(revision));
    }
    let values = serde_json::to_string(&values)
        .map_err(|_| corrupt("Restored Page values cannot encode"))?;
    Ok((values, revisions))
}

fn project_tag_names(value: &Value, config_json: &str) -> Result<Value, StoreError> {
    let selected = value
        .as_array()
        .ok_or_else(|| corrupt("Restored Page tags are not an array"))?;
    let config = database::property_semantics::option_config_from_storage(
        "tags",
        "multi_select",
        config_json,
    )?;
    let names = config
        .options
        .iter()
        .map(|option| (option.id.as_str(), option.name.as_str()))
        .collect::<BTreeMap<_, _>>();
    selected
        .iter()
        .map(|option_id| {
            let option_id = option_id
                .as_str()
                .ok_or_else(|| corrupt("Restored tag identity is invalid"))?;
            names
                .get(option_id)
                .map(|name| Value::String((*name).to_owned()))
                .ok_or_else(|| corrupt("Restored tag identity is not registered"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn read_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<PageAuthority, StoreError> {
    let page = connection
        .query_row(
            "SELECT block.lifecycle, block.metadata_revision, block.placement_revision, \
               page.library_id, page.parent_kind, page.parent_id, page.document_id, \
               document.generation, document.head_seq, block_index.document_id \
             FROM blocks block JOIN pages page \
               ON page.block_id = block.id AND page.library_id = block.library_id \
             JOIN documents document \
               ON document.id = page.document_id AND document.library_id = page.library_id \
             LEFT JOIN document_block_index block_index ON block_index.block_id = block.id \
             WHERE block.id = ?1 AND block.type = 'page' AND page.library_id = ?2",
            params![page_id, library_id],
            |row| {
                Ok(PageAuthority {
                    page_id: page_id.to_owned(),
                    library_id: row.get(3)?,
                    lifecycle: row.get(0)?,
                    containing_document_id: row.get(9)?,
                    metadata_revision: row.get(1)?,
                    parent_revision: row.get(2)?,
                    parent_kind: row.get(4)?,
                    parent_id: row.get(5)?,
                    document_id: row.get(6)?,
                    document_generation: row.get(7)?,
                    document_head_seq: row.get(8)?,
                })
            },
        )
        .optional()?;
    page.ok_or_else(|| StoreError::new(StoreErrorCode::NotFound, "Page does not exist", false))
}

fn read_active_membership(
    connection: &Connection,
    page_id: &str,
) -> Result<Option<MembershipCoordinates>, StoreError> {
    let row = connection
        .query_row(
            "SELECT membership.id, source.home_database_block_id, membership.data_source_id, \
               membership.revision, status.value_json, position.view_id, position.rank_key \
             FROM data_source_page_memberships membership \
             JOIN data_sources source ON source.id = membership.data_source_id \
             JOIN data_source_property_values status ON status.data_source_id = membership.data_source_id \
               AND status.membership_id = membership.id AND status.property_id = 'status' \
             LEFT JOIN database_view_page_positions position ON position.page_block_id = membership.page_block_id \
               AND position.view_id = (SELECT view.id FROM database_views view \
                 JOIN database_containers container ON container.block_id = view.database_block_id \
                 WHERE view.data_source_id = membership.data_source_id AND view.lifecycle = 'active' \
                 ORDER BY CASE WHEN view.id = container.default_view_id THEN 0 ELSE 1 END, \
                   view.rank_key, view.id LIMIT 1) \
             WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL \
             ORDER BY membership.id LIMIT 1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(StoreError::from)?;
    let Some((
        membership_id,
        database_id,
        data_source_id,
        membership_revision,
        status_json,
        view_id,
        view_rank_key,
    )) = row
    else {
        return Ok(None);
    };
    let status = serde_json::from_str::<String>(&status_json)
        .ok()
        .and_then(|status| workflow_status(&status))
        .ok_or_else(|| corrupt("Page membership has no valid workflow status"))?;
    Ok(Some(MembershipCoordinates {
        membership_id,
        database_id,
        data_source_id,
        membership_revision,
        status,
        view_id,
        view_rank_key,
    }))
}

fn validate_parent_membership(
    page: &PageAuthority,
    membership: Option<&MembershipCoordinates>,
) -> Result<(), StoreError> {
    let valid = match (page.parent_kind.as_str(), membership) {
        ("library", None) => page.parent_id == page.library_id,
        ("page", None) => page.containing_document_id.is_some(),
        ("data_source", Some(membership)) => page.parent_id == membership.data_source_id,
        _ => false,
    };
    if valid {
        return Ok(());
    }
    Err(corrupt("Page parent and Data Source membership disagree"))
}

fn authorize_page_write(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    page: &PageAuthority,
) -> Result<(), StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page lifecycle mutation requires a bound Project"))?;
    super::history::require_page_write_access(connection, library_id, project_id, &page.page_id)
}

fn authorize_page_restore(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    page: &PageAuthority,
    evidence: &LibraryPageLifecycleDeleteEvidence,
) -> Result<(), StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page restore requires a bound Project"))?;
    if super::page_grant_ownership_proof(connection, project_id, &page.page_id, true)?.is_some() {
        return Ok(());
    }
    let Some(membership) = evidence.membership.as_ref() else {
        return Err(not_found("Page is not available to the bound Project"));
    };
    let database_access = connection
        .query_row(
            "SELECT 1 FROM projects project \
             WHERE project.id = ?1 AND project.library_id = ?2 AND project.lifecycle = 'active' \
               AND (project.database_block_id = ?3 OR EXISTS( \
                 SELECT 1 FROM project_resource_grants grant_row \
                 WHERE grant_row.project_id = project.id AND grant_row.root_kind = 'database' \
                   AND grant_row.root_id = ?3 AND grant_row.access = 'read_write' \
                   AND grant_row.lifecycle = 'active' \
               ))",
            params![project_id, library_id, membership.database_id],
            |_| Ok(()),
        )
        .optional()?;
    if database_access.is_some() {
        return Ok(());
    }
    Err(not_found("Page is not available to the bound Project"))
}

fn synchronize_page_lifecycle(
    connection: &Connection,
    page: &PageAuthority,
    lifecycle: &str,
    metadata_revision: i64,
    now: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE page_read_model SET lifecycle = ?1, metadata_revision = ?2, updated_at = ?3 \
         WHERE page_block_id = ?4 AND library_id = ?5",
        params![
            lifecycle,
            metadata_revision,
            now,
            page.page_id,
            page.library_id
        ],
    )?;
    if changed != 1 {
        return Err(corrupt("Page lifecycle projection disappeared"));
    }
    connection.execute(
        "UPDATE scheduled_page_index SET lifecycle = ?1, source_metadata_revision = ?2, \
           updated_at = ?3 WHERE page_block_id = ?4 AND library_id = ?5",
        params![
            lifecycle,
            metadata_revision,
            now,
            page.page_id,
            page.library_id
        ],
    )?;
    Ok(())
}

fn lifecycle_receipt(
    operation_kind: &str,
    page: &PageAuthority,
    lifecycle: LibraryPageLifecycleState,
    metadata_revision: i64,
    membership: Option<&MembershipCoordinates>,
    library_rank_key: Option<String>,
) -> LibraryPageLifecycleMutationReceipt {
    LibraryPageLifecycleMutationReceipt {
        operation_kind: operation_kind.to_owned(),
        page_id: page.page_id.clone(),
        metadata_revision,
        parent_revision: page.parent_revision,
        lifecycle,
        document_id: page.document_id.clone(),
        document_generation: page.document_generation,
        document_head_seq: page.document_head_seq,
        database_id: membership.map(|membership| membership.database_id.clone()),
        data_source_id: membership.map(|membership| membership.data_source_id.clone()),
        membership_id: membership.map(|membership| membership.membership_id.clone()),
        view_id: membership.and_then(|membership| membership.view_id.clone()),
        library_rank_key,
        view_rank_key: membership.and_then(|membership| membership.view_rank_key.clone()),
        created_block_ids: Vec::new(),
        created_tag_option_ids: Vec::new(),
        delete_evidence: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn seal_page_lifecycle(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    page: &PageAuthority,
    membership: Option<&MembershipCoordinates>,
    receipt: LibraryPageLifecycleMutationReceipt,
    committed_revisions: BTreeMap<String, i64>,
    affected_block_ids: Vec<String>,
    additional_affected_page_ids: Vec<String>,
    affected_document_ids: Vec<String>,
    committed_at: String,
) -> Result<SealedOutcome<crate::ModuleWriterResult<LibraryCommitValue, LibraryReceipt>>, StoreError>
{
    let connection = scope.connection();
    let operation_kind = match receipt.operation_kind.as_str() {
        "archive_page" => "archive_page",
        "unarchive_page" => "unarchive_page",
        "delete_page" => "delete_page",
        "restore_page" => "restore_page",
        "move_page_in_library" => "move_page_in_library",
        _ => return Err(corrupt("Page lifecycle receipt kind is invalid")),
    };
    let parent_key = match page.parent_kind.as_str() {
        "library" => "library".to_owned(),
        "page" => format!("page:{}", page.parent_id),
        "data_source" => membership.map_or_else(
            || format!("data_source:{}", page.parent_id),
            |membership| format!("database:{}", membership.database_id),
        ),
        _ => return Err(corrupt("Page parent kind is invalid")),
    };
    let mut affected_database_ids = membership
        .map(|membership| vec![membership.database_id.clone()])
        .unwrap_or_default();
    for block_id in &affected_block_ids {
        if connection
            .query_row(
                "SELECT 1 FROM blocks WHERE id = ?1 AND type = 'database'",
                [block_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            affected_database_ids.push(block_id.clone());
        }
    }
    affected_database_ids.sort();
    affected_database_ids.dedup();
    let mut affected_page_ids = std::iter::once(page.page_id.clone())
        .chain(additional_affected_page_ids)
        .collect::<Vec<_>>();
    affected_page_ids.sort();
    affected_page_ids.dedup();
    seal_mutation(
        scope,
        context,
        operation_id,
        MutationEffects {
            project_id: context
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.clone())
                .ok_or_else(|| corrupt("Page lifecycle commit lost its actor Project"))?,
            operation_kind,
            change_kind: "library.changed",
            did_mutate: true,
            created_target: None,
            affected_parent_keys: vec![parent_key],
            affected_block_ids,
            affected_page_ids,
            affected_database_ids,
            affected_view_ids: membership
                .and_then(|membership| membership.view_id.clone())
                .into_iter()
                .collect(),
            affected_document_ids,
            committed_revisions,
            page_create: None,
            page_copy: None,
            page_files: None,
            canvas_mutation: None,
            block_transfer: None,
            block_transfer_undo: None,
            structural_edit: None,
            page_lifecycle: Some(receipt),
            block_property_mutation: None,
            agent_page_copy: None,
            agent_create_pages: None,
            agent_move_pages: None,
            change_payload: None,
            committed_at,
        },
    )
}

fn read_library_rank(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT rank_key FROM library_block_placements \
             WHERE library_id = ?1 AND block_id = ?2",
            params![library_id, page_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn lifecycle_state(value: &str) -> Result<LibraryPageLifecycleState, StoreError> {
    match value {
        "active" => Ok(LibraryPageLifecycleState::Active),
        "archived" => Ok(LibraryPageLifecycleState::Archived),
        "deleted" => Ok(LibraryPageLifecycleState::Deleted),
        _ => Err(corrupt("Page lifecycle is invalid")),
    }
}

fn workflow_status(value: &str) -> Option<LibraryPageWorkflowStatus> {
    match value {
        "triage" => Some(LibraryPageWorkflowStatus::Triage),
        "plan" => Some(LibraryPageWorkflowStatus::Plan),
        "build" => Some(LibraryPageWorkflowStatus::Build),
        "review" => Some(LibraryPageWorkflowStatus::Review),
        "ship" => Some(LibraryPageWorkflowStatus::Ship),
        _ => None,
    }
}

fn workflow_status_key(value: LibraryPageWorkflowStatus) -> &'static str {
    match value {
        LibraryPageWorkflowStatus::Triage => "triage",
        LibraryPageWorkflowStatus::Plan => "plan",
        LibraryPageWorkflowStatus::Build => "build",
        LibraryPageWorkflowStatus::Review => "review",
        LibraryPageWorkflowStatus::Ship => "ship",
    }
}

fn rank_error(error: crate::domain::fractional_rank::FractionalRankError) -> StoreError {
    if error.code == FractionalRankErrorCode::AnchorNotFound {
        return invalid(&error.message);
    }
    StoreError::new(StoreErrorCode::ResourceExhausted, error.message, false)
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(StoreError::from)
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn unauthorized(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nodex_core_contracts::library::LibraryPageLifecycleViewPlacement;
    use rusqlite::Connection;
    use serde_json::{Value, json};

    use crate::infrastructure::sqlite::StoreErrorCode;

    use super::{
        CreateProperty, LibraryPageWorkflowStatus, allocate_create_view_position,
        read_create_source, synchronize_create_view_siblings, validate_create_values,
    };

    fn exact_primary_board_config() -> Value {
        json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 6,
            "rules": {
                "propertyFilters": [],
                "advancedFilter": null,
                "sorts": [{
                    "field": { "kind": "manual" },
                    "direction": "asc",
                    "nulls": "last"
                }]
            },
            "presentation": {
                "group": { "propertyId": "status" },
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "display": { "fields": [], "showEmptyGroups": false }
            }
        })
    }

    #[test]
    fn create_source_rejects_inexact_default_board_configs() {
        let connection = Connection::open_in_memory().expect("in-memory Database");
        connection
            .execute_batch(
                "CREATE TABLE data_sources( \
                   id TEXT NOT NULL, library_id TEXT NOT NULL, lifecycle TEXT NOT NULL, \
                   home_database_block_id TEXT NOT NULL); \
                 CREATE TABLE database_containers( \
                   block_id TEXT NOT NULL, library_id TEXT NOT NULL, lifecycle TEXT NOT NULL, \
                   default_view_id TEXT); \
                 CREATE TABLE database_views( \
                   id TEXT NOT NULL, database_block_id TEXT NOT NULL, data_source_id TEXT NOT NULL, \
                   lifecycle TEXT NOT NULL, layout TEXT NOT NULL, config_json TEXT NOT NULL); \
                 INSERT INTO data_sources VALUES \
                   ('source-1', 'library-1', 'active', 'database-1'); \
                 INSERT INTO database_containers VALUES \
                   ('database-1', 'library-1', 'active', 'view-1'); \
                 INSERT INTO database_views VALUES \
                   ('view-1', 'database-1', 'source-1', 'active', 'board', '{}');",
            )
            .expect("seed default View authority");
        let set_config = |config: &Value| {
            connection
                .execute(
                    "UPDATE database_views SET config_json = ?1 WHERE id = 'view-1'",
                    [config.to_string()],
                )
                .expect("set View config");
        };

        let exact = exact_primary_board_config();
        set_config(&exact);
        read_create_source(&connection, "library-1", "source-1")
            .expect("exact primary Board source");

        let mut filtered = exact.clone();
        filtered["filter"] = json!({
            "kind": "clause",
            "propertyId": "status",
            "operator": "equals",
            "value": "triage"
        });
        let mut sorted = exact.clone();
        sorted["presentation"]["sort"] = json!([{
            "field": { "kind": "title" },
            "direction": "asc",
            "nulls": "last"
        }]);
        let mut custom_group = exact;
        custom_group["presentation"]["group"] = json!({ "propertyId": "priority" });

        for (label, config) in [
            ("filtered", filtered),
            ("custom sorted", sorted),
            ("custom grouped", custom_group),
        ] {
            set_config(&config);
            let error = read_create_source(&connection, "library-1", "source-1")
                .err()
                .expect(label);
            assert_eq!(error.code, StoreErrorCode::InvalidInput, "{label}");
        }
    }

    #[test]
    fn create_view_placement_resolves_start_end_and_before_in_core() {
        let connection = Connection::open_in_memory().expect("in-memory Database");
        connection
            .execute_batch(
                "CREATE TABLE database_view_page_positions( \
                   view_id TEXT NOT NULL, page_block_id TEXT NOT NULL, \
                   rank_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, \
                   created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''); \
                 CREATE TABLE data_source_page_memberships( \
                   id TEXT NOT NULL, data_source_id TEXT NOT NULL, page_block_id TEXT NOT NULL, \
                   removed_at TEXT); \
                 CREATE TABLE page_read_model( \
                   page_block_id TEXT NOT NULL, membership_id TEXT, lifecycle TEXT NOT NULL, \
                   document_id TEXT NOT NULL, document_generation INTEGER NOT NULL, \
                   document_projected_seq INTEGER NOT NULL, view_id TEXT, view_group_key TEXT, \
                   view_rank_key TEXT); \
                 CREATE TABLE documents( \
                   id TEXT NOT NULL, generation INTEGER NOT NULL, head_seq INTEGER NOT NULL, \
                   schema_version INTEGER NOT NULL); \
                 CREATE TABLE document_materializations( \
                   document_id TEXT NOT NULL, generation INTEGER NOT NULL, \
                   projected_seq INTEGER NOT NULL, schema_version INTEGER NOT NULL); \
                 INSERT INTO database_view_page_positions( \
                   view_id, page_block_id, rank_key) VALUES \
                   ('view-1', 'first', '55555555555555555555555555555555'), \
                   ('view-1', 'second', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), \
                   ('view-1', 'other-group', '66666666666666666666666666666666'), \
                   ('view-1', 'archived', '11111111111111111111111111111111'), \
                   ('view-1', 'foreign-source', '00000000000000000000000000000000'), \
                   ('view-1', 'removed', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), \
                   ('view-1', 'stale-position', '77777777777777777777777777777777'), \
                   ('view-1', 'stale-head', '88888888888888888888888888888888'); \
                 INSERT INTO data_source_page_memberships VALUES \
                   ('membership-first', 'source-1', 'first', NULL), \
                   ('membership-second', 'source-1', 'second', NULL), \
                   ('membership-unpositioned', 'source-1', 'unpositioned', NULL), \
                   ('membership-other-group', 'source-1', 'other-group', NULL), \
                   ('membership-archived', 'source-1', 'archived', NULL), \
                   ('membership-foreign-source', 'source-2', 'foreign-source', NULL), \
                   ('membership-removed', 'source-1', 'removed', '2026-08-09T00:00:00.000Z'), \
                   ('membership-stale-position', 'source-1', 'stale-position', NULL), \
                   ('membership-stale-head', 'source-1', 'stale-head', NULL); \
                 INSERT INTO page_read_model VALUES \
                   ('first', 'membership-first', 'active', 'document-first', 1, 1, \
                     'view-1', 'triage', '55555555555555555555555555555555'), \
                   ('second', 'membership-second', 'active', 'document-second', 1, 1, \
                     'view-1', 'triage', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), \
                   ('unpositioned', 'membership-unpositioned', 'active', \
                     'document-unpositioned', 1, 1, 'view-1', 'triage', NULL), \
                   ('other-group', 'membership-other-group', 'active', 'document-other-group', 1, 1, \
                     'view-1', 'build', '55555555555555555555555555555555'), \
                   ('archived', 'membership-archived', 'archived', 'document-archived', 1, 1, \
                     'view-1', 'triage', '11111111111111111111111111111111'), \
                   ('foreign-source', 'membership-foreign-source', 'active', \
                     'document-foreign-source', 1, 1, 'view-1', 'triage', \
                     '00000000000000000000000000000000'), \
                   ('removed', 'membership-removed', 'active', 'document-removed', 1, 1, \
                     'view-1', 'triage', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), \
                   ('stale-position', 'membership-stale-position', 'active', \
                     'document-stale-position', 1, 1, 'view-1', 'triage', 'old-rank'), \
                   ('stale-head', 'membership-stale-head', 'active', 'document-stale-head', 1, 1, \
                     'view-1', 'triage', '88888888888888888888888888888888'); \
                 INSERT INTO documents VALUES \
                   ('document-first', 1, 1, 2), \
                   ('document-second', 1, 1, 2), \
                   ('document-unpositioned', 1, 1, 2), \
                   ('document-other-group', 1, 1, 2), \
                   ('document-archived', 1, 1, 2), \
                   ('document-foreign-source', 1, 1, 2), \
                   ('document-removed', 1, 1, 2), \
                   ('document-stale-position', 1, 1, 2), \
                   ('document-stale-head', 1, 2, 2); \
                 INSERT INTO document_materializations VALUES \
                   ('document-first', 1, 1, 2), \
                   ('document-second', 1, 1, 2), \
                   ('document-unpositioned', 1, 1, 2), \
                   ('document-other-group', 1, 1, 2), \
                   ('document-archived', 1, 1, 2), \
                   ('document-foreign-source', 1, 1, 2), \
                   ('document-removed', 1, 1, 2), \
                   ('document-stale-position', 1, 1, 2), \
                   ('document-stale-head', 1, 2, 2); \
                 ALTER TABLE page_read_model \
                   ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 1; \
                 ALTER TABLE page_read_model \
                   ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';",
            )
            .expect("seed exact and stale View positions");

        let start = allocate_create_view_position(
            &connection,
            "view-1",
            "source-1",
            "new-start",
            &LibraryPageLifecycleViewPlacement::Start,
        )
        .expect("start placement");
        let end = allocate_create_view_position(
            &connection,
            "view-1",
            "source-1",
            "new-end",
            &LibraryPageLifecycleViewPlacement::End,
        )
        .expect("end placement");
        let before_second = allocate_create_view_position(
            &connection,
            "view-1",
            "source-1",
            "new-before",
            &LibraryPageLifecycleViewPlacement::Before {
                page_id: "second".to_owned(),
            },
        )
        .expect("before placement");
        let before_unpositioned = allocate_create_view_position(
            &connection,
            "view-1",
            "source-1",
            "new-before-unpositioned",
            &LibraryPageLifecycleViewPlacement::Before {
                page_id: "unpositioned".to_owned(),
            },
        )
        .expect("before unpositioned placement");

        assert!(start.rank_key.as_str() < "55555555555555555555555555555555");
        assert!(end.rank_key.as_str() > before_unpositioned.rank_key.as_str());
        assert!(before_second.rank_key.as_str() > "55555555555555555555555555555555");
        assert!(before_second.rank_key.as_str() < "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(!before_unpositioned.sibling_writes.is_empty());

        synchronize_create_view_siblings(
            &connection,
            "view-1",
            &before_unpositioned.sibling_writes,
            "2026-08-09T00:00:00.000Z",
        )
        .expect("materialize the logical group");
        let materialized = connection
            .query_row(
                "SELECT count(*) FROM database_view_page_positions \
                 WHERE view_id = 'view-1' AND page_block_id = 'unpositioned'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read materialized position");
        assert_eq!(materialized, 1);

        for unavailable_anchor in [
            "other-group",
            "archived",
            "foreign-source",
            "removed",
            "stale-position",
            "stale-head",
        ] {
            let error = allocate_create_view_position(
                &connection,
                "view-1",
                "source-1",
                "new-invalid",
                &LibraryPageLifecycleViewPlacement::Before {
                    page_id: unavailable_anchor.to_owned(),
                },
            )
            .expect_err("inactive or stale anchor");
            assert_eq!(error.code, StoreErrorCode::InvalidInput);
        }

        connection
            .execute_batch(
                "UPDATE database_view_page_positions \
                   SET rank_key = '00000000000000000000000000000001' \
                   WHERE page_block_id = 'first'; \
                 UPDATE database_view_page_positions \
                   SET rank_key = '00000000000000000000000000000002' \
                   WHERE page_block_id = 'second'; \
                 UPDATE page_read_model \
                   SET view_rank_key = '00000000000000000000000000000001' \
                   WHERE page_block_id = 'first'; \
                 UPDATE page_read_model \
                   SET view_rank_key = '00000000000000000000000000000002' \
                   WHERE page_block_id = 'second';",
            )
            .expect("exhaust rank interval");
        let rebalanced = allocate_create_view_position(
            &connection,
            "view-1",
            "source-1",
            "new-rebalanced",
            &LibraryPageLifecycleViewPlacement::Before {
                page_id: "second".to_owned(),
            },
        )
        .expect("rebalance placement");
        assert!(!rebalanced.sibling_writes.is_empty());
        let affected_page_ids = synchronize_create_view_siblings(
            &connection,
            "view-1",
            &rebalanced.sibling_writes,
            "2026-08-09T00:00:00.000Z",
        )
        .expect("synchronize rebalance");
        assert!(affected_page_ids.contains(&"first".to_owned()));
        assert!(affected_page_ids.contains(&"second".to_owned()));
        let mismatched_ranks = connection
            .query_row(
                "SELECT count(*) FROM database_view_page_positions position \
                 JOIN page_read_model model ON model.page_block_id = position.page_block_id \
                 WHERE position.view_id = 'view-1' \
                   AND position.page_block_id IN ('first', 'second') \
                   AND model.lifecycle = 'active' \
                   AND position.rank_key <> model.view_rank_key",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read synchronized ranks");
        assert_eq!(mismatched_ranks, 0);
    }

    #[test]
    fn create_values_follow_the_active_sparse_schema() {
        let properties = BTreeMap::from([
            (
                "status".to_owned(),
                CreateProperty {
                    property_id: "status".to_owned(),
                    value_type: "select".to_owned(),
                    config_json: json!({
                        "options": [{ "id": "build", "name": "Build" }]
                    })
                    .to_string(),
                    schema_revision: 1,
                },
            ),
            (
                "p_confid00".to_owned(),
                CreateProperty {
                    property_id: "p_confid00".to_owned(),
                    value_type: "number".to_owned(),
                    config_json: "{}".to_owned(),
                    schema_revision: 1,
                },
            ),
        ]);

        let values = validate_create_values(
            &properties,
            LibraryPageWorkflowStatus::Build,
            Some("p1-high"),
            Some("m"),
            Some("2026-08-04"),
            None,
            None,
            Some("alex"),
            Value::Array(Vec::new()),
        )
        .expect("sparse schema should accept absent optional semantics");

        assert_eq!(values.len(), 1);
        assert_eq!(values["status"].1, Value::String("build".to_owned()));
        assert!(!values.contains_key("due_date"));
        assert!(!values.contains_key("assignee"));
    }
}
