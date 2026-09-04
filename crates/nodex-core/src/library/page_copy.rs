use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use nodex_core_contracts::library::{
    LibraryBlockTransferDocumentCommit, LibraryBlockTransferDocumentHead,
    LibraryPageCopyDestination, LibraryPageCopyResult, LibraryResourceTarget, LibraryWriteParent,
};
use nodex_core_contracts::{BoundModuleContext, ModuleName};
use rusqlite::{Connection, OptionalExtension, params};

use crate::database::{
    PageCopyDataSourceDestination, PageCopyPositionAnchor, PageCopyValueDraft,
    PageCopyViewPlacement, copy_relation_edges, current_page_key_for_page,
    ensure_database_page_key, place_copied_page_in_data_source,
    place_copied_page_in_data_source_prevalidated, synchronize_membership_completion_timestamp,
    validate_page_copy_data_source_destination,
    validate_page_copy_data_source_destination_prevalidated,
};
use crate::document::{
    BlockDocumentSchema, DocumentMaterialization, DocumentPlacementEvidence, PersistYjsGenesis,
    clone_canvas_genesis, decode_block_document, materialize_decoded_document,
    mint_document_semantic_etags, persist_yjs_genesis_with_local_commit, prepare_yjs_clone_genesis,
    read_document_authority, reconstruct_yjs_engine, sha256,
};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::block_tree::TextDelta;
use crate::domain::identity::stable_uuid_v7;
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::local_commit::CommitContext;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::LibraryApplyOutcome;
use super::mutation::{
    MutationEffects, ParentDocumentWriteContext, ensure_default_page_intrinsic_properties,
    insert_creator_resource_grant, insert_library_placement, insert_page_read_model,
    library_commit_result, persist_parent_insert, refresh_page_intrinsic_projection,
    resolve_write_parent, seal_mutation, sqlite_now,
};

const MAX_COPY_BLOCKS: usize = 10_000;
const MAX_COPY_DOCUMENTS: usize = 1_024;
const YJS_OWNER_TYPES: &[&str] = &["page", "synced_block_source", "reusable_template_source"];
const TYPED_BLOCK_TYPES: &[&str] = &[
    "page",
    "database",
    "synced_block_source",
    "reusable_template_source",
    "canvas",
];

struct CopyDocument {
    source_owner_id: String,
    source_document_id: String,
    target_owner_id: String,
    target_document_id: String,
    owner_type: String,
    source_containing_document_id: Option<String>,
    schema_key: String,
    schema_version: i64,
    source_generation: i64,
    source_head_seq: i64,
    body: CopyDocumentBody,
}

enum CopyDocumentBody {
    Yjs {
        schema: BlockDocumentSchema,
        title: Option<Vec<TextDelta>>,
        materialization: Box<DocumentMaterialization>,
    },
    Canvas,
}

struct CopyPlan {
    source_library_id: String,
    source_root_document_id: String,
    block_ids: BTreeMap<String, String>,
    document_ids: BTreeMap<String, String>,
    documents: Vec<CopyDocument>,
}

struct SourcePageCopyAuthority {
    lifecycle: String,
    placement_revision: i64,
    active_membership_revision: i64,
    document_id: String,
    document_generation: i64,
    document_head_seq: i64,
    document_readiness: String,
}

pub(super) struct PageCopyPlanPreview {
    pub(super) page_id: String,
    pub(super) block_ids: BTreeMap<String, String>,
    pub(super) document_heads: Vec<LibraryBlockTransferDocumentHead>,
    pub(super) body_block_count: u32,
}

pub(super) struct PageCopyExecution {
    pub(super) actor_project_id: String,
    pub(super) parent_key: String,
    pub(super) affected_page_ids: Vec<String>,
    pub(super) affected_database_ids: Vec<String>,
    pub(super) affected_view_ids: Vec<String>,
    pub(super) affected_document_ids: Vec<String>,
    pub(super) committed_revisions: BTreeMap<String, i64>,
    pub(super) result: LibraryPageCopyResult,
    pub(super) document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    pub(super) committed_at: String,
}

#[derive(Clone, Copy)]
pub(super) enum PageCopyParentDocumentMode {
    Commit,
    Defer,
}

struct PersistedCopyDocuments {
    heads: BTreeMap<String, i64>,
    commits: Vec<LibraryBlockTransferDocumentCommit>,
}

struct ExplicitRootIdentity<'a> {
    page_id: &'a str,
    document_id: &'a str,
}

pub(crate) struct OccurrencePageCloneInput<'a> {
    pub(crate) commit_context: &'a CommitContext,
    pub(crate) actor_project_id: &'a str,
    pub(crate) operation_id: &'a str,
    pub(crate) source_page_id: &'a str,
    pub(crate) new_page_id: &'a str,
    pub(crate) lifecycle: &'a str,
    pub(crate) status: &'a str,
    pub(crate) scheduled_start: &'a str,
    pub(crate) scheduled_end: &'a str,
    pub(crate) is_all_day: bool,
    pub(crate) recurrence_json: &'a str,
    pub(crate) reminders_json: &'a str,
    pub(crate) schedule_timezone: Option<&'a str>,
    pub(crate) primary_placement: crate::database::ViewOrderPlacement<'a>,
    pub(crate) now: &'a str,
}

pub(crate) struct OccurrencePageCloneResult {
    pub(crate) page_id: String,
    pub(crate) database_id: String,
    pub(crate) affected_document_ids: Vec<String>,
}

struct OccurrenceSourceAuthority {
    lifecycle: String,
    document_id: String,
    document_readiness: String,
    document_authority: String,
    membership_id: String,
    data_source_id: String,
    database_id: String,
}

pub(super) fn write_parent(
    destination: &LibraryPageCopyDestination,
) -> Result<LibraryWriteParent, StoreError> {
    match destination {
        LibraryPageCopyDestination::Library { before } => Ok(LibraryWriteParent::Library {
            before: before.clone(),
        }),
        LibraryPageCopyDestination::Page {
            page_id,
            expected_document_generation,
            expected_document_head_seq,
            before,
        } => Ok(LibraryWriteParent::Page {
            page_id: page_id.clone(),
            expected_document_generation: *expected_document_generation,
            expected_document_head_seq: *expected_document_head_seq,
            before: before.clone(),
            insertion: None,
        }),
        LibraryPageCopyDestination::DataSource { .. } => {
            Ok(LibraryWriteParent::Library { before: None })
        }
    }
}

pub(super) fn data_source_destination(
    destination: &LibraryPageCopyDestination,
) -> Option<PageCopyDataSourceDestination> {
    let LibraryPageCopyDestination::DataSource {
        data_source_id,
        expected_data_source_revision,
        values,
        view,
    } = destination
    else {
        return None;
    };
    Some(PageCopyDataSourceDestination {
        data_source_id: data_source_id.clone(),
        expected_data_source_revision: *expected_data_source_revision,
        values: values
            .iter()
            .map(|value| PageCopyValueDraft {
                property_id: value.property_id.clone(),
                value: value.value.clone(),
            })
            .collect(),
        view: view.as_ref().map(|view| PageCopyViewPlacement {
            view_id: view.view_id.clone(),
            expected_view_revision: view.expected_view_revision,
            group_key: view.group_key.clone(),
            before: view.before.as_ref().map(|anchor| PageCopyPositionAnchor {
                page_id: anchor.page_id.clone(),
                expected_position_revision: anchor.expected_position_revision,
            }),
        }),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn copy_page(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    source_page_id: &str,
    expected_location_revision: i64,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    expected_document_generation: i64,
    expected_document_head_seq: i64,
    destination: &LibraryPageCopyDestination,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
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
            let execution = execute_page_copy(
                connection,
                context,
                scope.evidence(),
                store_epoch,
                library_id,
                operation_id,
                source_page_id,
                expected_location_revision,
                expected_parent_revision,
                expected_active_membership_revision,
                expected_document_generation,
                expected_document_head_seq,
                destination,
                PageCopyParentDocumentMode::Commit,
                false,
                assets_root,
                &now,
            )?;
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::new(),
                    file_mutation: Default::default(),
                    project_id: execution.actor_project_id,
                    operation_kind: "copy_page",
                    change_kind: "library.changed",
                    did_mutate: true,
                    created_target: Some(LibraryResourceTarget::Page {
                        page_id: execution.result.page_id.clone(),
                    }),
                    affected_parent_keys: vec![execution.parent_key],
                    affected_block_ids: Vec::new(),
                    affected_page_ids: execution.affected_page_ids,
                    affected_database_ids: execution.affected_database_ids,
                    affected_view_ids: execution.affected_view_ids,
                    affected_document_ids: execution.affected_document_ids,
                    committed_revisions: execution.committed_revisions,
                    page_create: None,
                    page_copy: Some(execution.result),
                    canvas_mutation: None,
                    block_transfer: None,
                    block_transfer_undo: None,
                    page_relocation_undo: None,
                    structural_edit: None,
                    page_lifecycle: None,
                    block_property_mutation: None,
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: None,
                    committed_at: execution.committed_at,
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_page_copy(
    connection: &Connection,
    context: &BoundModuleContext,
    commit_context: &CommitContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    source_page_id: &str,
    expected_location_revision: i64,
    expected_parent_revision: i64,
    expected_active_membership_revision: i64,
    expected_document_generation: i64,
    expected_document_head_seq: i64,
    destination: &LibraryPageCopyDestination,
    parent_document_mode: PageCopyParentDocumentMode,
    access_prevalidated: bool,
    assets_root: &Path,
    committed_at: &str,
) -> Result<PageCopyExecution, StoreError> {
    let requesting_project_id = context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Page copy requires a bound Project"))?;
    if !access_prevalidated {
        super::history::require_page_read_access(
            connection,
            library_id,
            requesting_project_id,
            source_page_id,
        )?;
    }
    let source = connection
        .query_row(
            "SELECT block.lifecycle, block.placement_revision, COALESCE(( \
                 SELECT membership.revision FROM data_source_page_memberships membership \
                 WHERE membership.page_block_id = page.block_id \
                   AND membership.removed_at IS NULL), 0), page.document_id, \
               document.generation, document.head_seq, document.readiness \
             FROM pages page JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
               AND block.library_id = page.library_id \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2",
            params![source_page_id, library_id],
            |row| {
                Ok(SourcePageCopyAuthority {
                    lifecycle: row.get(0)?,
                    placement_revision: row.get(1)?,
                    active_membership_revision: row.get(2)?,
                    document_id: row.get(3)?,
                    document_generation: row.get(4)?,
                    document_head_seq: row.get(5)?,
                    document_readiness: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Source Page is unavailable"))?;
    if source.lifecycle != "active" || source.document_readiness != "ready" {
        return Err(not_found("Source Page is unavailable"));
    }
    if source.placement_revision != expected_location_revision {
        return Err(revision_conflict("Source Page location changed"));
    }
    if source.placement_revision != expected_parent_revision
        || source.active_membership_revision != expected_active_membership_revision
    {
        return Err(revision_conflict("Source Page parent changed"));
    }
    if source.document_generation != expected_document_generation
        || source.document_head_seq != expected_document_head_seq
    {
        return Err(head_conflict("Source Page content changed"));
    }

    let parent = write_parent(destination)?;
    let data_source_destination = data_source_destination(destination);
    let mut resolved_parent = if access_prevalidated {
        super::mutation::resolve_write_parent_prevalidated(
            connection,
            library_id,
            requesting_project_id,
            &parent,
        )?
    } else {
        resolve_write_parent(connection, library_id, requesting_project_id, &parent)?
    };
    if matches!(parent_document_mode, PageCopyParentDocumentMode::Defer)
        && resolved_parent.document.is_none()
    {
        return Err(corrupt(
            "Deferred Page copy insertion requires a target Document",
        ));
    }
    if let Some(destination) = &data_source_destination {
        if access_prevalidated {
            validate_page_copy_data_source_destination_prevalidated(
                connection,
                library_id,
                requesting_project_id,
                &destination.data_source_id,
                destination.expected_data_source_revision,
            )?
        } else {
            validate_page_copy_data_source_destination(
                connection,
                library_id,
                requesting_project_id,
                &destination.data_source_id,
                destination.expected_data_source_revision,
            )?
        }
        resolved_parent.parent_key = format!("data_source:{}", destination.data_source_id);
    }
    let plan = build_copy_plan(
        connection,
        operation_id,
        library_id,
        source_page_id,
        &source.document_id,
        None,
    )?;
    let target_page_id = plan
        .block_ids
        .get(source_page_id)
        .cloned()
        .ok_or_else(|| corrupt("Page copy omitted its root identity"))?;
    let target_document_id = plan
        .document_ids
        .get(&plan.source_root_document_id)
        .cloned()
        .ok_or_else(|| corrupt("Page copy omitted its root Document identity"))?;
    assert_fresh_identities(connection, &plan)?;
    let now = committed_at.to_owned();
    stage_copy_authority(
        connection,
        library_id,
        &resolved_parent,
        source_page_id,
        &target_page_id,
        &plan,
        &parent,
        &now,
    )?;
    if matches!(parent, LibraryWriteParent::Library { .. }) {
        insert_creator_resource_grant(
            connection,
            requesting_project_id,
            library_id,
            "page",
            &target_page_id,
            &now,
        )?;
    }

    let source_to_target_page_ids = plan
        .documents
        .iter()
        .filter(|document| document.owner_type == "page")
        .map(|document| {
            (
                document.source_owner_id.clone(),
                document.target_owner_id.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let page_file_manifest_revisions = super::page_file_entries::copy_for_pages(
        connection,
        library_id,
        &source_to_target_page_ids,
        &now,
    )?;
    let mut persisted_documents = persist_copy_documents(
        connection,
        commit_context,
        requesting_project_id,
        &plan,
        store_epoch,
        operation_id,
        &now,
        assets_root,
    )?;

    let data_source_placement = data_source_destination
        .as_ref()
        .map(|destination| {
            if access_prevalidated {
                place_copied_page_in_data_source_prevalidated(
                    connection,
                    library_id,
                    requesting_project_id,
                    source_page_id,
                    &target_page_id,
                    destination,
                    &now,
                )
            } else {
                place_copied_page_in_data_source(
                    connection,
                    library_id,
                    requesting_project_id,
                    source_page_id,
                    &target_page_id,
                    destination,
                    &now,
                )
            }
        })
        .transpose()?;
    let parent_commit = resolved_parent
        .document
        .as_ref()
        .filter(|_| matches!(parent_document_mode, PageCopyParentDocumentMode::Commit))
        .map(|parent_document| {
            persist_parent_insert(
                connection,
                ParentDocumentWriteContext {
                    actor_project_id: requesting_project_id,
                    store_epoch,
                    operation_id,
                    commit: commit_context,
                },
                parent_document,
                embedded_page(&target_page_id),
                resolved_parent.before_block_id.clone(),
            )
        })
        .transpose()?;
    let copied_page_ids = plan
        .documents
        .iter()
        .filter(|document| document.owner_type == "page")
        .map(|document| document.target_owner_id.clone())
        .collect::<Vec<_>>();
    let mut affected_page_ids = copied_page_ids
        .iter()
        .cloned()
        .chain(resolved_parent.page_id.clone())
        .collect::<Vec<_>>();
    affected_page_ids.sort();
    affected_page_ids.dedup();
    let mut affected_document_ids = persisted_documents
        .heads
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    if let Some(parent_document) = resolved_parent.document.as_ref() {
        affected_document_ids.push(parent_document.authority.head.id.clone());
    }
    affected_document_ids.sort();
    affected_document_ids.dedup();
    let mut committed_revisions = BTreeMap::new();
    for page_id in &copied_page_ids {
        let revision = 1;
        committed_revisions.insert(format!("blockLocation:{page_id}"), revision);
        committed_revisions.insert(format!("blockMetadata:{page_id}"), revision);
        committed_revisions.insert(format!("pageParent:{page_id}"), revision);
    }
    committed_revisions.extend(
        page_file_manifest_revisions
            .into_iter()
            .map(|(page_id, revision)| (format!("pageFiles:{page_id}"), revision)),
    );
    for (document_id, head_seq) in &persisted_documents.heads {
        committed_revisions.insert(format!("documentHead:{document_id}"), *head_seq);
    }
    if let (Some(commit), Some(parent_document)) =
        (parent_commit.as_ref(), resolved_parent.document.as_ref())
    {
        committed_revisions.insert(
            format!("documentHead:{}", parent_document.authority.head.id),
            commit.head_seq,
        );
    }
    if let Some(placement) = &data_source_placement {
        committed_revisions.insert(
            format!("blockLocation:{}", target_page_id),
            placement.location_revision,
        );
        committed_revisions.insert(
            format!("blockMetadata:{}", target_page_id),
            placement.metadata_revision,
        );
        committed_revisions.insert(
            format!("pageParent:{}", target_page_id),
            placement.parent_revision,
        );
        committed_revisions.insert(
            format!("membership:{}:{}", placement.data_source_id, target_page_id),
            1,
        );
        committed_revisions.insert(
            format!("dataSourceSchema:{}", placement.data_source_id),
            data_source_destination
                .as_ref()
                .expect("placement has destination")
                .expected_data_source_revision,
        );
        for (property_id, revision) in &placement.value_revisions {
            committed_revisions.insert(
                format!(
                    "propertyValue:{}:{}:{}",
                    placement.data_source_id, target_page_id, property_id
                ),
                *revision,
            );
        }
        if let (Some(view), Some(revision)) = (
            data_source_destination
                .as_ref()
                .and_then(|destination| destination.view.as_ref()),
            placement.position_revision,
        ) {
            committed_revisions.insert(
                format!("viewPosition:{}:{}", view.view_id, target_page_id),
                revision,
            );
        }
    }
    persisted_documents.commits.extend(parent_commit);
    let target_authority = read_document_authority(connection, &target_document_id)?
        .ok_or_else(|| corrupt("Copied Page Document authority is unavailable"))?;
    let target_schema = BlockDocumentSchema::from_identity(
        &target_authority.head.schema_key,
        target_authority.head.schema_version,
    )
    .ok_or_else(|| corrupt("Copied Page Document schema is unsupported"))?;
    let target_engine = reconstruct_yjs_engine(connection, &target_authority.head)?;
    let target_decoded = decode_block_document(target_engine.document(), target_schema)
        .map_err(|error| corrupt(format!("Copied Page schema is invalid: {error}")))?;
    let target_materialization = materialize_decoded_document(&target_decoded)
        .map_err(|error| corrupt(format!("Copied Page cannot materialize: {error}")))?;
    let (title_etag, body_etag) = mint_document_semantic_etags(
        connection,
        requesting_project_id,
        store_epoch,
        &target_document_id,
        &target_materialization,
    )
    .map_err(|error| internal(format!("Copied Page ETags could not be minted: {error:?}")))?;
    Ok(PageCopyExecution {
        actor_project_id: resolved_parent.actor_project_id,
        parent_key: resolved_parent.parent_key,
        affected_page_ids,
        affected_database_ids: data_source_placement
            .as_ref()
            .map(|placement| vec![placement.database_id.clone()])
            .unwrap_or_default(),
        affected_view_ids: data_source_placement
            .as_ref()
            .map(|placement| placement.affected_view_ids.clone())
            .unwrap_or_default(),
        affected_document_ids,
        committed_revisions,
        result: LibraryPageCopyResult {
            source_page_id: source_page_id.to_owned(),
            page_key: current_page_key_for_page(connection, library_id, &target_page_id)?,
            page_id: target_page_id,
            document_id: target_document_id,
            block_ids: plan.block_ids,
            document_ids: plan.document_ids,
            document_generation: target_authority.head.generation,
            document_head_seq: target_authority.head.head_seq,
            title_etag,
            body_etag,
        },
        document_commits: std::mem::take(&mut persisted_documents.commits),
        committed_at: now,
    })
}

pub(crate) fn clone_page_for_occurrence(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    assets_root: &Path,
    input: OccurrencePageCloneInput<'_>,
) -> Result<OccurrencePageCloneResult, StoreError> {
    if !matches!(input.lifecycle, "active" | "archived") {
        return Err(invalid("Occurrence clone lifecycle is invalid"));
    }
    let source = connection
        .query_row(
            "SELECT block.lifecycle, page.document_id, document.readiness, document.authority, \
               membership.id, \
               membership.data_source_id, source.home_database_block_id \
             FROM pages page \
             JOIN blocks block ON block.id = page.block_id \
               AND block.library_id = page.library_id AND block.type = 'page' \
             JOIN documents document ON document.id = page.document_id \
               AND document.library_id = block.library_id \
             JOIN data_source_page_memberships membership ON membership.page_block_id = page.block_id \
               AND membership.removed_at IS NULL \
             JOIN data_sources source ON source.id = membership.data_source_id \
               AND source.library_id = block.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND page.parent_kind = 'data_source' AND page.parent_id = source.id",
            params![input.source_page_id, library_id],
            |row| {
                Ok(OccurrenceSourceAuthority {
                    lifecycle: row.get(0)?,
                    document_id: row.get(1)?,
                    document_readiness: row.get(2)?,
                    document_authority: row.get(3)?,
                    membership_id: row.get(4)?,
                    data_source_id: row.get(5)?,
                    database_id: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Occurrence source Page is unavailable"))?;
    if source.lifecycle == "deleted"
        || source.document_readiness != "ready"
        || source.document_authority != "ydoc_primary"
    {
        return Err(not_found("Occurrence source Page is unavailable"));
    }
    let target_document_id = format!("document:{}", input.new_page_id);
    let plan = build_copy_plan(
        connection,
        input.operation_id,
        library_id,
        input.source_page_id,
        &source.document_id,
        Some(ExplicitRootIdentity {
            page_id: input.new_page_id,
            document_id: &target_document_id,
        }),
    )?;
    assert_fresh_identities(connection, &plan)?;
    let resolved_parent = super::mutation::ResolvedWriteParent {
        parent_key: format!("library:{library_id}"),
        page_id: None,
        actor_project_id: input.actor_project_id.to_owned(),
        creator_project_id: Some(input.actor_project_id.to_owned()),
        document: None,
        before_block_id: None,
    };
    stage_copy_authority(
        connection,
        library_id,
        &resolved_parent,
        input.source_page_id,
        input.new_page_id,
        &plan,
        &LibraryWriteParent::Library { before: None },
        input.now,
    )?;
    super::page_file_entries::copy_for_pages(
        connection,
        library_id,
        &plan
            .documents
            .iter()
            .filter(|document| document.owner_type == "page")
            .map(|document| {
                (
                    document.source_owner_id.clone(),
                    document.target_owner_id.clone(),
                )
            })
            .collect(),
        input.now,
    )?;
    let document_heads = persist_copy_documents(
        connection,
        input.commit_context,
        input.actor_project_id,
        &plan,
        store_epoch,
        input.operation_id,
        input.now,
        assets_root,
    )?;

    connection.execute(
        "DELETE FROM library_block_placements WHERE block_id = ?1 AND library_id = ?2",
        params![input.new_page_id, library_id],
    )?;
    let block_changed = connection.execute(
        "UPDATE blocks SET lifecycle = ?1, updated_at = ?2 \
         WHERE id = ?3 AND library_id = ?4 AND type = 'page'",
        params![input.lifecycle, input.now, input.new_page_id, library_id,],
    )?;
    let page_changed = connection.execute(
        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1, \
           updated_at = ?2 WHERE block_id = ?3 AND library_id = ?4",
        params![
            source.data_source_id,
            input.now,
            input.new_page_id,
            library_id,
        ],
    )?;
    if block_changed != 1 || page_changed != 1 {
        return Err(corrupt("Occurrence clone root placement disappeared"));
    }
    let membership_id = format!(
        "membership:{}",
        sha256(format!("{}\0{}", source.data_source_id, input.new_page_id).as_bytes())
    );
    connection.execute(
        "INSERT INTO data_source_page_memberships( \
           id, data_source_id, page_block_id, revision, created_at, removed_at \
         ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
        params![
            membership_id,
            source.data_source_id,
            input.new_page_id,
            input.now
        ],
    )?;
    ensure_database_page_key(
        connection,
        library_id,
        &source.database_id,
        input.new_page_id,
        input.now,
    )?;

    let database_values = connection
        .prepare(
            "SELECT value.property_id, value.value_type, value.value_json \
             FROM data_source_property_values value \
             JOIN data_source_properties property ON property.data_source_id = value.data_source_id \
               AND property.id = value.property_id AND property.lifecycle = 'active' \
             WHERE value.data_source_id = ?1 AND value.membership_id = ?2 ORDER BY value.property_id",
        )?
        .query_map(params![source.data_source_id, source.membership_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut required_schedule = BTreeSet::new();
    for (property_id, value_type, value_json) in database_values {
        let next_value = match property_id.as_str() {
            "status" => serde_json::to_string(input.status)
                .map_err(|_| internal("Occurrence status JSON"))?,
            "scheduled_start" => {
                required_schedule.insert("scheduled_start");
                serde_json::to_string(input.scheduled_start)
                    .map_err(|_| internal("Occurrence start JSON"))?
            }
            "scheduled_end" => {
                required_schedule.insert("scheduled_end");
                serde_json::to_string(input.scheduled_end)
                    .map_err(|_| internal("Occurrence end JSON"))?
            }
            _ => value_json,
        };
        connection.execute(
            "INSERT INTO data_source_property_values( \
               data_source_id, membership_id, property_id, value_type, value_json, revision, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![
                source.data_source_id,
                membership_id,
                property_id,
                value_type,
                next_value,
                input.now,
            ],
        )?;
    }
    synchronize_membership_completion_timestamp(
        connection,
        &source.data_source_id,
        &membership_id,
        input.now,
    )?;
    copy_relation_edges(
        connection,
        &source.data_source_id,
        &source.membership_id,
        &membership_id,
        input.now,
    )?;
    if required_schedule.len() != 2 {
        return Err(corrupt(
            "Occurrence source Page is missing required schedule properties",
        ));
    }
    let recurrence = serde_json::from_str::<serde_json::Value>(input.recurrence_json)
        .map_err(|_| corrupt("Occurrence clone recurrence JSON is invalid"))?;
    let reminders = serde_json::from_str::<serde_json::Value>(input.reminders_json)
        .map_err(|_| corrupt("Occurrence clone reminder JSON is invalid"))?;
    let intrinsic_overrides = [
        (
            "schedule.isAllDay",
            serde_json::Value::Bool(input.is_all_day),
        ),
        ("recurrence.config", recurrence),
        ("reminders.config", reminders),
        (
            "schedule.timezone",
            input
                .schedule_timezone
                .map_or(serde_json::Value::Null, |value| {
                    serde_json::Value::String(value.to_owned())
                }),
        ),
    ];
    for (property_key, value) in intrinsic_overrides {
        let changed = connection.execute(
            "UPDATE block_properties SET value_json = ?1, updated_at = ?2 \
             WHERE block_id = ?3 AND library_id = ?4 AND property_key = ?5",
            params![
                serde_json::to_string(&value).map_err(|_| internal("Occurrence intrinsic JSON"))?,
                input.now,
                input.new_page_id,
                library_id,
                property_key,
            ],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Occurrence source Page is missing a required intrinsic property",
            ));
        }
    }

    let positions = connection
        .prepare(
            "SELECT view.id, container.default_view_id = view.id
             FROM database_views view
             JOIN database_containers container ON container.block_id = view.database_block_id
             WHERE view.database_block_id = ?1 AND view.data_source_id = ?2
               AND view.lifecycle = 'active' ORDER BY view.id",
        )?
        .query_map(params![source.database_id, source.data_source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (view_id, primary) in positions {
        let placement = if primary {
            input.primary_placement
        } else {
            crate::database::ViewOrderPlacement::After(input.source_page_id)
        };
        // Archived occurrences still have a retained position for later restore.
        crate::database::restore_page_view_position(
            connection,
            &view_id,
            input.new_page_id,
            placement,
            input.now,
        )?;
    }
    crate::database::refresh_copied_page_projection(
        connection,
        input.new_page_id,
        Some(&membership_id),
        Some(&source.data_source_id),
        input.now,
    )?;
    refresh_page_intrinsic_projection(connection, input.new_page_id, input.now)?;

    Ok(OccurrencePageCloneResult {
        page_id: input.new_page_id.to_owned(),
        database_id: source.database_id,
        affected_document_ids: document_heads.heads.into_keys().collect(),
    })
}

#[allow(clippy::too_many_arguments)]
fn persist_copy_documents(
    connection: &Connection,
    commit_context: &CommitContext,
    actor_project_id: &str,
    plan: &CopyPlan,
    store_epoch: &str,
    operation_id: &str,
    now: &str,
    assets_root: &Path,
) -> Result<PersistedCopyDocuments, StoreError> {
    let mut document_heads = BTreeMap::new();
    let mut document_commits = Vec::new();
    for document in &plan.documents {
        let target_authority =
            read_document_authority(connection, &document.target_document_id)?
                .ok_or_else(|| corrupt("Staged Page copy has no Document authority"))?;
        let CopyDocumentBody::Yjs {
            schema,
            title,
            materialization,
        } = &document.body
        else {
            let source_authority =
                read_document_authority(connection, &document.source_document_id)?
                    .ok_or_else(|| corrupt("Canvas copy source authority disappeared"))?;
            let head_seq = clone_canvas_genesis(
                connection,
                &source_authority,
                &target_authority,
                assets_root,
            )?;
            document_heads.insert(document.target_document_id.clone(), head_seq);
            continue;
        };
        let remapped_blocks = remap_blocks(&materialization.block_tree, &plan.block_ids)?;
        let prepared = prepare_yjs_clone_genesis(
            &document.target_document_id,
            &document.owner_type,
            *schema,
            title.as_deref(),
            &remapped_blocks,
        )?;
        let staged_typed_owner_ids = plan
            .documents
            .iter()
            .map(|document| document.target_owner_id.as_str())
            .collect::<BTreeSet<_>>();
        let placement_genesis_block_ids = prepared
            .materialization
            .search_units
            .iter()
            .filter(|unit| staged_typed_owner_ids.contains(unit.block_id.as_str()))
            .map(|unit| unit.block_id.clone())
            .collect::<Vec<_>>();
        let full_state = prepared.engine.full_state_v1();
        let authorized_file_ids = materialization.file_ids();
        let update_id = format!(
            "library-page-copy:{}:{}",
            sha256(operation_id.as_bytes()),
            sha256(document.source_document_id.as_bytes())
        );
        let persisted = persist_yjs_genesis_with_local_commit(
            connection,
            PersistYjsGenesis {
                authority: &target_authority,
                actor_project_id,
                materialization: &prepared.materialization,
                update_id: &update_id,
                client_session_id: "library-module",
                update: &prepared.update_v1,
                state_vector: &prepared.state_vector_v1,
                full_state: &full_state,
                store_epoch,
                operation_id: &update_id,
                placement: DocumentPlacementEvidence::STRUCTURAL
                    .with_genesis(&placement_genesis_block_ids)
                    .with_authorized_file_ids(&authorized_file_ids),
                emit_event: false,
            },
            commit_context,
        )?;
        document_heads.insert(document.target_document_id.clone(), persisted.head_seq);
        document_commits.push(LibraryBlockTransferDocumentCommit {
            document_id: document.target_document_id.clone(),
            generation: target_authority.head.generation,
            base_head_seq: 0,
            head_seq: persisted.head_seq,
            update_id,
            update: prepared.update_v1.clone(),
            state_vector: persisted.state_vector.clone(),
        });
        if document.owner_type != "page" {
            continue;
        }
        insert_page_read_model(
            connection,
            &document.target_owner_id,
            &prepared.materialization,
            persisted.head_seq,
            now,
        )?;
        ensure_default_page_intrinsic_properties(connection, &document.target_owner_id, now)?;
        refresh_page_intrinsic_projection(connection, &document.target_owner_id, now)?;
    }
    Ok(PersistedCopyDocuments {
        heads: document_heads,
        commits: document_commits,
    })
}

fn build_copy_plan(
    connection: &Connection,
    operation_id: &str,
    source_library_id: &str,
    source_page_id: &str,
    source_root_document_id: &str,
    explicit_root: Option<ExplicitRootIdentity<'_>>,
) -> Result<CopyPlan, StoreError> {
    let mut pending = VecDeque::from([source_page_id.to_owned()]);
    let mut documents = Vec::new();
    let mut source_blocks =
        BTreeMap::from([(source_page_id.to_owned(), ("page".to_owned(), None))]);
    let mut visited_owners = BTreeSet::new();
    while let Some(source_owner_id) = pending.pop_front() {
        if !visited_owners.insert(source_owner_id.clone()) {
            continue;
        }
        if visited_owners.len() > MAX_COPY_DOCUMENTS {
            return Err(invalid("Page copy exceeds its Document bound"));
        }
        let authority =
            read_document_authority_by_owner(connection, source_library_id, &source_owner_id)?
                .ok_or_else(|| corrupt("Page ownership closure has a missing Document"))?;
        let source_containing_document_id = source_blocks
            .get(&source_owner_id)
            .and_then(|(_, containing)| containing.clone());
        if authority.owner_type == "canvas"
            && authority.head.sync_engine
                == crate::infrastructure::document_repository::DocumentSyncEngine::CanvasScene
        {
            documents.push((
                source_owner_id,
                authority.head.id,
                authority.owner_type,
                source_containing_document_id,
                authority.head.schema_key,
                authority.head.schema_version,
                authority.head.generation,
                authority.head.head_seq,
                CopyDocumentBody::Canvas,
            ));
            continue;
        }
        if !YJS_OWNER_TYPES.contains(&authority.owner_type.as_str())
            || !authority.head.is_live_yjs_authority()
        {
            return Err(StoreError::new(
                StoreErrorCode::UnsupportedSchema,
                "Page copy currently requires Yjs Page/Synced/Template ownership",
                false,
            ));
        }
        let schema = BlockDocumentSchema::from_identity(
            &authority.head.schema_key,
            authority.head.schema_version,
        )
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::UnsupportedSchema,
                "Page copy encountered an unsupported Document schema",
                false,
            )
        })?;
        let engine = reconstruct_yjs_engine(connection, &authority.head)?;
        let decoded = decode_block_document(engine.document(), schema)
            .map_err(|error| corrupt(format!("Page copy Document schema is invalid: {error}")))?;
        let materialization = crate::document::materialize_decoded_document(&decoded)
            .map_err(|error| corrupt(format!("Page copy Document cannot materialize: {error}")))?;
        for block in flatten_blocks(&materialization.block_tree) {
            if source_blocks.len() >= MAX_COPY_BLOCKS && !source_blocks.contains_key(&block.id) {
                return Err(invalid("Page copy exceeds its Block bound"));
            }
            let row = connection
                .query_row(
                    "SELECT block.type, block.lifecycle, entry.document_id FROM blocks block \
                     JOIN document_block_index entry ON entry.block_id = block.id \
                     WHERE block.id = ?1 AND block.library_id = ?2 \
                       AND entry.document_id = ?3",
                    params![block.id, source_library_id, authority.head.id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| corrupt("Page copy projection references a missing Block"))?;
            if row.1 != "active" || row.2.as_deref() != Some(authority.head.id.as_str()) {
                return Err(corrupt("Page copy Block escaped its owning Document"));
            }
            source_blocks.insert(block.id.clone(), (row.0.clone(), row.2));
            let owns_document = connection
                .query_row(
                    "SELECT 1 FROM block_documents WHERE block_id = ?1 AND library_id = ?2",
                    params![block.id, source_library_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if owns_document {
                pending.push_back(block.id.clone());
            } else if TYPED_BLOCK_TYPES.contains(&row.0.as_str()) {
                return Err(StoreError::new(
                    StoreErrorCode::UnsupportedSchema,
                    format!(
                        "Page copy cannot clone embedded typed Block {} ({})",
                        block.id, row.0
                    ),
                    false,
                ));
            }
        }
        documents.push((
            source_owner_id,
            authority.head.id,
            authority.owner_type,
            source_containing_document_id,
            authority.head.schema_key,
            authority.head.schema_version,
            authority.head.generation,
            authority.head.head_seq,
            CopyDocumentBody::Yjs {
                schema,
                title: decoded.title,
                materialization: Box::new(materialization),
            },
        ));
    }
    if documents
        .first()
        .is_none_or(|document| document.1 != source_root_document_id)
    {
        return Err(corrupt("Page copy root Document changed during planning"));
    }
    let block_ids = source_blocks
        .keys()
        .map(|source_id| {
            (
                source_id.clone(),
                if source_id == source_page_id {
                    explicit_root.as_ref().map_or_else(
                        || stable_uuid_v7(operation_id, "block", source_id),
                        |identity| identity.page_id.to_owned(),
                    )
                } else {
                    stable_uuid_v7(operation_id, "block", source_id)
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let document_ids = documents
        .iter()
        .map(|document| {
            (
                document.1.clone(),
                if document.1 == source_root_document_id {
                    explicit_root.as_ref().map_or_else(
                        || stable_uuid_v7(operation_id, "document", &document.1),
                        |identity| identity.document_id.to_owned(),
                    )
                } else {
                    stable_uuid_v7(operation_id, "document", &document.1)
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let documents = documents
        .into_iter()
        .map(
            |(
                source_owner_id,
                source_document_id,
                owner_type,
                source_containing_document_id,
                schema_key,
                schema_version,
                source_generation,
                source_head_seq,
                body,
            )| {
                Ok(CopyDocument {
                    target_owner_id: block_ids
                        .get(&source_owner_id)
                        .cloned()
                        .ok_or_else(|| corrupt("Page copy owner identity is missing"))?,
                    target_document_id: document_ids
                        .get(&source_document_id)
                        .cloned()
                        .ok_or_else(|| corrupt("Page copy Document identity is missing"))?,
                    source_owner_id,
                    source_document_id,
                    owner_type,
                    source_containing_document_id,
                    schema_key,
                    schema_version,
                    source_generation,
                    source_head_seq,
                    body,
                })
            },
        )
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(CopyPlan {
        source_library_id: source_library_id.to_owned(),
        source_root_document_id: source_root_document_id.to_owned(),
        block_ids,
        document_ids,
        documents,
    })
}

pub(super) fn preview_page_copy(
    connection: &Connection,
    operation_id: &str,
    source_library_id: &str,
    source_page_id: &str,
    source_document_id: &str,
) -> Result<PageCopyPlanPreview, StoreError> {
    let plan = build_copy_plan(
        connection,
        operation_id,
        source_library_id,
        source_page_id,
        source_document_id,
        None,
    )?;
    let page_id = plan
        .block_ids
        .get(source_page_id)
        .cloned()
        .ok_or_else(|| corrupt("Page copy omitted its root identity"))?;
    let body_block_count = plan
        .documents
        .iter()
        .find(|document| document.source_owner_id == source_page_id)
        .and_then(|document| match &document.body {
            CopyDocumentBody::Yjs {
                materialization, ..
            } => Some(flatten_blocks(&materialization.block_tree).len()),
            CopyDocumentBody::Canvas => None,
        })
        .ok_or_else(|| corrupt("Page copy root materialization is unavailable"))?;
    let body_block_count = u32::try_from(body_block_count)
        .map_err(|_| invalid("Page copy body exceeds its public count bound"))?;
    let mut document_heads = plan
        .documents
        .iter()
        .map(|document| LibraryBlockTransferDocumentHead {
            document_id: document.source_document_id.clone(),
            generation: document.source_generation,
            expected_head_seq: document.source_head_seq,
        })
        .collect::<Vec<_>>();
    document_heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    document_heads.dedup_by(|left, right| left.document_id == right.document_id);
    Ok(PageCopyPlanPreview {
        page_id,
        block_ids: plan.block_ids,
        document_heads,
        body_block_count,
    })
}

pub(super) fn page_copy_closure_document_heads(
    connection: &Connection,
    operation_id: &str,
    source_library_id: &str,
    source_page_id: &str,
    source_root_document_id: &str,
) -> Result<Vec<LibraryBlockTransferDocumentHead>, StoreError> {
    let plan = build_copy_plan(
        connection,
        operation_id,
        source_library_id,
        source_page_id,
        source_root_document_id,
        None,
    )?;
    let mut heads = plan
        .documents
        .iter()
        .map(|document| LibraryBlockTransferDocumentHead {
            document_id: document.source_document_id.clone(),
            generation: document.source_generation,
            expected_head_seq: document.source_head_seq,
        })
        .collect::<Vec<_>>();
    heads.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    heads.dedup_by(|left, right| left.document_id == right.document_id);
    Ok(heads)
}

#[allow(clippy::too_many_arguments)]
fn stage_copy_authority(
    connection: &Connection,
    library_id: &str,
    parent: &super::mutation::ResolvedWriteParent,
    source_page_id: &str,
    target_page_id: &str,
    plan: &CopyPlan,
    requested_parent: &LibraryWriteParent,
    now: &str,
) -> Result<(), StoreError> {
    for document in &plan.documents {
        connection.execute(
            "INSERT INTO documents( \
               id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
               state_hash, readiness, authority, created_at, updated_at, sync_engine \
             ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', ?5, ?6, ?7, ?8, ?8, ?9)",
            params![
                document.target_document_id,
                library_id,
                document.schema_key,
                document.schema_version,
                if matches!(&document.body, CopyDocumentBody::Canvas) {
                    "0".repeat(64)
                } else {
                    String::new()
                },
                if matches!(&document.body, CopyDocumentBody::Canvas) {
                    "ready"
                } else {
                    "pending_genesis"
                },
                if matches!(&document.body, CopyDocumentBody::Canvas) {
                    "ydoc_primary"
                } else {
                    "legacy_shadow"
                },
                now,
                if matches!(&document.body, CopyDocumentBody::Canvas) {
                    "canvas_scene"
                } else {
                    "yjs"
                },
            ],
        )?;
    }
    for document in &plan.documents {
        let root = document.source_owner_id == source_page_id;
        let has_containing_document = if root {
            parent.document.is_some()
        } else {
            document
                .source_containing_document_id
                .as_ref()
                .and_then(|source| plan.document_ids.get(source))
                .is_some()
        };
        if !root && !has_containing_document {
            return Err(corrupt("Nested Page copy owner has no target container"));
        }
        connection.execute(
            "INSERT INTO blocks( \
               id, library_id, type, lifecycle, placement_revision, metadata_revision, \
               created_at, updated_at \
             ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
            params![
                document.target_owner_id,
                library_id,
                document.owner_type,
                now,
            ],
        )?;
        connection.execute(
            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                document.target_owner_id,
                document.target_document_id,
                library_id,
                now,
            ],
        )?;
        connection.execute(
            "INSERT INTO block_properties( \
               block_id, library_id, property_key, value_type, value_json, revision, updated_at \
             ) SELECT ?1, ?2, property_key, value_type, value_json, 1, ?3 \
               FROM block_properties WHERE block_id = ?4 AND library_id = ?5",
            params![
                document.target_owner_id,
                library_id,
                now,
                document.source_owner_id,
                plan.source_library_id,
            ],
        )?;
    }
    if parent.document.is_none() {
        insert_library_placement(
            connection,
            library_id,
            target_page_id,
            match requested_parent {
                LibraryWriteParent::Library { before } => before.as_ref(),
                LibraryWriteParent::Page { .. } => None,
            },
            now,
        )?;
    }
    for document in &plan.documents {
        if document.owner_type != "page" {
            continue;
        }
        let root = document.source_owner_id == source_page_id;
        let parent_page_id = if root {
            parent.page_id.clone()
        } else {
            let containing_source = document
                .source_containing_document_id
                .as_ref()
                .ok_or_else(|| corrupt("Nested Page copy has no containing Document"))?;
            plan.documents
                .iter()
                .find(|candidate| candidate.source_document_id == *containing_source)
                .filter(|candidate| candidate.owner_type == "page")
                .map(|candidate| candidate.target_owner_id.clone())
        };
        if !root && parent_page_id.is_none() {
            return Err(corrupt("Nested Page copy is not owned by a Page Document"));
        }
        connection.execute(
            "INSERT INTO pages( \
               block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                document.target_owner_id,
                library_id,
                document.target_document_id,
                if parent_page_id.is_some() {
                    "page"
                } else {
                    "library"
                },
                parent_page_id.as_deref().unwrap_or(library_id),
                now,
            ],
        )?;
    }
    Ok(())
}

fn read_document_authority_by_owner(
    connection: &Connection,
    library_id: &str,
    owner_block_id: &str,
) -> Result<Option<crate::document::DocumentAuthorityRow>, StoreError> {
    let document_id = connection
        .query_row(
            "SELECT document_id FROM block_documents WHERE block_id = ?1 AND library_id = ?2",
            params![owner_block_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    document_id
        .map(|document_id| read_document_authority(connection, &document_id))
        .transpose()
        .map(Option::flatten)
}

fn assert_fresh_identities(connection: &Connection, plan: &CopyPlan) -> Result<(), StoreError> {
    let mut allocated = BTreeSet::new();
    for identity in plan.block_ids.values().chain(plan.document_ids.values()) {
        if !allocated.insert(identity) {
            return Err(corrupt("Page copy allocated a duplicate identity"));
        }
    }
    for identity in plan.block_ids.values() {
        if connection
            .query_row("SELECT 1 FROM blocks WHERE id = ?1", [identity], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(StoreError::new(
                StoreErrorCode::AlreadyOwned,
                "Page copy Block identity already exists",
                false,
            ));
        }
    }
    for identity in plan.document_ids.values() {
        if connection
            .query_row("SELECT 1 FROM documents WHERE id = ?1", [identity], |_| {
                Ok(())
            })
            .optional()?
            .is_some()
        {
            return Err(StoreError::new(
                StoreErrorCode::AlreadyOwned,
                "Page copy Document identity already exists",
                false,
            ));
        }
    }
    Ok(())
}

fn remap_blocks(
    blocks: &[MaterializedBlockNode],
    block_ids: &BTreeMap<String, String>,
) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    blocks
        .iter()
        .map(|block| {
            Ok(MaterializedBlockNode {
                id: block_ids
                    .get(&block.id)
                    .cloned()
                    .ok_or_else(|| corrupt("Page copy omitted a content Block identity"))?,
                block_type: block.block_type.clone(),
                props: block.props.clone(),
                content: block.content.clone(),
                children: remap_blocks(&block.children, block_ids)?,
            })
        })
        .collect()
}

fn flatten_blocks(blocks: &[MaterializedBlockNode]) -> Vec<&MaterializedBlockNode> {
    fn visit<'a>(blocks: &'a [MaterializedBlockNode], result: &mut Vec<&'a MaterializedBlockNode>) {
        for block in blocks {
            result.push(block);
            visit(&block.children, result);
        }
    }
    let mut result = Vec::new();
    visit(blocks, &mut result);
    result
}

fn embedded_page(page_id: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: page_id.to_owned(),
        block_type: "page".to_owned(),
        props: BTreeMap::new(),
        content: None,
        children: Vec::new(),
    }
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn revision_conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn head_conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::HeadConflict, message, true)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::agent::{
        AgentExecutionAuthorization, AgentOperationPreparationState, AgentPreparedExecution,
        AgentProjectResourceAccess, AgentProjectResourceAction, AgentResourceAccessOverlay,
        AgentResourceAccessOverlayKind, AgentResourceAccessOverlayScope, AgentResourceGrantRoot,
        AgentResourceGrantSpec, AgentTurnProvenance,
    };
    use nodex_core_contracts::document::OwnedDocumentIntent;
    use nodex_core_contracts::library::{
        LibraryAccess, LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest,
        LibraryAgentMovePagesRequest, LibraryAgentPageCopyRequest, LibraryAgentPageDestination,
        LibraryCanvasDestination, LibraryIntent, LibraryNavigationNode, LibraryNavigationParent,
        LibraryPageCopyDestination, LibraryPageCopyValue, LibraryPageCopyViewPlacement,
        LibraryRead, LibraryReadValue, LibraryResourceTarget, LibraryWriteParent,
    };
    use nodex_core_contracts::workspace::{
        PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspaceThreadPatch,
        ProjectWorkspaceTurnAuthority, ProjectWorkspaceTurnAuthorityScope,
        ProjectWorkspaceTurnAuthoritySource,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, CoreErrorCode, LIBRARY_CONTRACT_VERSION, LibraryId,
        ModuleApplyRequest, ModuleReadRequest, OWNED_DOCUMENT_CONTRACT_VERSION, ProfileId,
        ProjectId, StoreEpoch,
    };
    use tempfile::{TempDir, tempdir};

    use crate::document::OwnedDocumentModule;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;
    use crate::workspace::ProjectWorkspaceModule;

    use super::*;

    const NOW: &str = "2026-07-19T02:20:00.000Z";

    fn context() -> BoundModuleContext {
        context_for("project-1")
    }

    fn context_for(project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId(project_id.to_owned())),
            connection_id: format!("connection:page-copy:{project_id}"),
            adapter: AdapterKind::Test,
        }
    }

    fn seeded_kernel() -> (TempDir, SqliteStoreKernel) {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        std::fs::create_dir(home.join("assets")).expect("assets root");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) \
                         VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Page copy', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed Library identity");
        (directory, kernel)
    }

    fn create_page(
        module: &LibraryModule,
        operation_id: &str,
        page_id: &str,
        document_id: &str,
        title: &str,
        parent: LibraryWriteParent,
    ) {
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: page_id.to_owned(),
                        document_id: document_id.to_owned(),
                        title: title.to_owned(),
                        parent,
                    },
                },
            )
            .expect("create Page");
    }

    fn agent_move_authorization(
        kernel: &SqliteStoreKernel,
        granted_page_ids: &[&str],
    ) -> AgentExecutionAuthorization {
        let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", kernel)
            .expect("Workspace module");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:create-agent-move-thread".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread:agent-move".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project-1".to_owned())),
                            thread_name: Some(Some("Agent move".to_owned())),
                            created_at: Some(100),
                            updated_at: Some(100),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                },
            )
            .expect("persist Agent move Thread");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:freeze-agent-move-turn".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread:agent-move".to_owned(),
                        turn_id: "turn:agent-move".to_owned(),
                        root_thread_id: "thread:agent-move".to_owned(),
                        actor_project_id: "project-1".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                },
            )
            .expect("freeze Agent move Turn");
        let turn = ProjectWorkspaceTurnAuthority {
            thread_id: "thread:agent-move".to_owned(),
            turn_id: "turn:agent-move".to_owned(),
            root_thread_id: "thread:agent-move".to_owned(),
            actor_project_id: "project-1".to_owned(),
            library_id: "library-1".to_owned(),
            store_epoch: "epoch-1".to_owned(),
            scope: ProjectWorkspaceTurnAuthorityScope::Project,
            source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
        };
        AgentExecutionAuthorization {
            provenance: AgentTurnProvenance {
                profile_id: "profile-1".to_owned(),
                authority: turn.clone(),
            },
            call_id: "call:agent-move".to_owned(),
            resource_access: Some(AgentResourceAccessOverlay {
                kind: AgentResourceAccessOverlayKind::Consent,
                scope: AgentResourceAccessOverlayScope::Call,
                thread_id: Some(turn.thread_id.clone()),
                turn_id: Some(turn.turn_id.clone()),
                call_id: Some("call:agent-move".to_owned()),
                root_thread_id: turn.root_thread_id,
                actor_project_id: turn.actor_project_id,
                library_id: turn.library_id,
                store_epoch: turn.store_epoch,
                grants: granted_page_ids
                    .iter()
                    .map(|page_id| AgentResourceGrantSpec {
                        root: AgentResourceGrantRoot::Page {
                            page_id: (*page_id).to_owned(),
                        },
                        access: AgentProjectResourceAccess::ReadWrite,
                        library_actions: Vec::new(),
                    })
                    .collect(),
                persist_resulting_page_grants: false,
            }),
        }
    }

    fn execute_agent_move(
        module: &LibraryModule,
        authorization: AgentExecutionAuthorization,
        operation_id: &str,
        request: LibraryAgentMovePagesRequest,
    ) -> LibraryApplyOutcome {
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentMovePages {
                        operation_id: operation_id.to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(request.clone()),
                    },
                },
            )
            .expect("prepare Agent Page move");
        let LibraryReadValue::AgentMovePagesPreparation { value } = prepared.value else {
            panic!("Agent Page-move preparation");
        };
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ExecutePreparedAgentMovePages {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization,
                            token: value.preparation.token,
                        }),
                        request: Box::new(request),
                    },
                },
            )
            .expect("execute Agent Page move")
    }

    fn copy_request(
        operation_id: &str,
        expected_document_head_seq: i64,
        destination: LibraryPageCopyDestination,
    ) -> ModuleApplyRequest<LibraryIntent> {
        copy_request_for(
            operation_id,
            "page:source",
            1,
            1,
            0,
            expected_document_head_seq,
            destination,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn copy_request_for(
        operation_id: &str,
        source_page_id: &str,
        expected_location_revision: i64,
        expected_parent_revision: i64,
        expected_active_membership_revision: i64,
        expected_document_head_seq: i64,
        destination: LibraryPageCopyDestination,
    ) -> ModuleApplyRequest<LibraryIntent> {
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation_id.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::CopyPage {
                source_page_id: source_page_id.to_owned(),
                expected_location_revision,
                expected_parent_revision,
                expected_active_membership_revision,
                expected_document_generation: 1,
                expected_document_head_seq,
                destination,
            },
        }
    }

    fn create_database(module: &LibraryModule) {
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000101".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000102".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000103".to_owned(),
                        name: "Copy target".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create target Database");
    }

    #[test]
    fn agent_page_copy_prepares_without_mutation_and_executes_once_under_exact_authority() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-agent-source",
            "page:agent-source",
            "document:agent-source",
            "Agent source",
            LibraryWriteParent::Library { before: None },
        );
        create_page(
            &module,
            "operation:create-agent-child",
            "page:agent-child",
            "document:agent-child",
            "Agent child",
            LibraryWriteParent::Page {
                page_id: "page:agent-source".to_owned(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                before: None,
                insertion: None,
            },
        );
        create_page(
            &module,
            "operation:create-agent-target",
            "page:agent-target",
            "document:agent-target",
            "Agent target",
            LibraryWriteParent::Library { before: None },
        );

        let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:create-agent-thread".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread:agent-copy".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project-1".to_owned())),
                            thread_name: Some(Some("Agent copy".to_owned())),
                            created_at: Some(100),
                            updated_at: Some(100),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                },
            )
            .expect("persist Agent Thread");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:freeze-agent-copy-turn".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread:agent-copy".to_owned(),
                        turn_id: "turn:agent-copy".to_owned(),
                        root_thread_id: "thread:agent-copy".to_owned(),
                        actor_project_id: "project-1".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                },
            )
            .expect("freeze Agent copy Turn");

        let authority = ProjectWorkspaceTurnAuthority {
            thread_id: "thread:agent-copy".to_owned(),
            turn_id: "turn:agent-copy".to_owned(),
            root_thread_id: "thread:agent-copy".to_owned(),
            actor_project_id: "project-1".to_owned(),
            library_id: "library-1".to_owned(),
            store_epoch: "epoch-1".to_owned(),
            scope: ProjectWorkspaceTurnAuthorityScope::Project,
            source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
        };
        let authorization = AgentExecutionAuthorization {
            provenance: AgentTurnProvenance {
                profile_id: "profile-1".to_owned(),
                authority: authority.clone(),
            },
            call_id: "call:agent-copy".to_owned(),
            resource_access: Some(AgentResourceAccessOverlay {
                kind: AgentResourceAccessOverlayKind::Consent,
                scope: AgentResourceAccessOverlayScope::Call,
                thread_id: Some(authority.thread_id.clone()),
                turn_id: Some(authority.turn_id.clone()),
                call_id: Some("call:agent-copy".to_owned()),
                root_thread_id: authority.root_thread_id.clone(),
                actor_project_id: authority.actor_project_id.clone(),
                library_id: authority.library_id.clone(),
                store_epoch: authority.store_epoch.clone(),
                grants: vec![
                    AgentResourceGrantSpec {
                        root: AgentResourceGrantRoot::Page {
                            page_id: "page:agent-source".to_owned(),
                        },
                        access: AgentProjectResourceAccess::Read,
                        library_actions: Vec::new(),
                    },
                    AgentResourceGrantSpec {
                        root: AgentResourceGrantRoot::Page {
                            page_id: "page:agent-target".to_owned(),
                        },
                        access: AgentProjectResourceAccess::ReadWrite,
                        library_actions: Vec::new(),
                    },
                ],
                persist_resulting_page_grants: false,
            }),
        };
        let copy = LibraryAgentPageCopyRequest {
            source_page_id: "page:agent-source".to_owned(),
            destination: LibraryAgentPageDestination::Page {
                page_id: "page:agent-target".to_owned(),
                at: None,
            },
            include_block_map: true,
            include_etags: true,
        };
        let durable_before = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM blocks", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM core_module_receipts",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read pre-prepare counts");
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentPageCopy {
                        operation_id: "operation:agent-copy".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(copy.clone()),
                    },
                },
            )
            .expect("prepare Agent Page copy");
        let durable_after = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM blocks", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM core_module_receipts",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read post-prepare counts");
        assert_eq!(durable_after, durable_before);
        assert_eq!(
            module
                .prepared_agent_operation_count()
                .expect("prepared count"),
            1
        );
        let LibraryReadValue::AgentPageCopyPreparation { value: prepared } = prepared.value else {
            panic!("Agent Page copy preparation");
        };
        assert_eq!(
            prepared.preparation.state,
            AgentOperationPreparationState::Prepared
        );
        assert_eq!(prepared.document_heads.len(), 3);
        assert_eq!(
            prepared
                .destination_document
                .as_ref()
                .map(|head| head.document_id.as_str()),
            Some("document:agent-target")
        );
        assert!(matches!(
            prepared.destination,
            Some(LibraryPageCopyDestination::Page { ref page_id, .. })
                if page_id == "page:agent-target"
        ));
        let token = prepared.preparation.token.expect("single-use token");
        let execute = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "operation:agent-copy".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ExecutePreparedAgentPageCopy {
                authorization: Box::new(AgentPreparedExecution {
                    authorization: authorization.clone(),
                    token: Some(token.clone()),
                }),
                request: Box::new(copy.clone()),
            },
        };
        let mut wrong_connection = context();
        wrong_connection.connection_id = "connection:wrong-agent-copy".to_owned();
        let wrong = module
            .apply(&wrong_connection, execute.clone())
            .expect_err("reject token on another connection");
        assert_eq!(wrong.code, CoreErrorCode::RevisionConflict, "{wrong:?}");
        assert_eq!(
            module
                .prepared_agent_operation_count()
                .expect("retained token"),
            1
        );

        let committed = module
            .apply(&context(), execute.clone())
            .expect("execute Agent Page copy");
        let replay = module
            .apply(&context(), execute)
            .expect("replay committed Agent Page copy");
        assert_eq!(
            module
                .prepared_agent_operation_count()
                .expect("consumed token"),
            0
        );
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        let result = committed
            .committed
            .value
            .agent_page_copy
            .as_ref()
            .expect("Agent copy result");
        assert!(result.etags.is_some());
        assert!(result.block_map.as_ref().expect("identity map").len() >= 2);
        assert!(result.document_commits.len() >= 3);
        assert!(matches!(
            result.location,
            nodex_core_contracts::library::LibraryAgentPageLocation::Page { ref page_id }
                if page_id == "page:agent-target"
        ));
        let copied_child_id =
            result.block_map.as_ref().expect("identity map")["page:agent-child"].clone();
        kernel
            .readers()
            .read_default(|connection| {
                let parent = connection.query_row(
                    "SELECT parent_id FROM pages WHERE block_id = ?1",
                    [&result.page_id],
                    |row| row.get::<_, String>(0),
                )?;
                let child_parent = connection.query_row(
                    "SELECT parent_id FROM pages WHERE block_id = ?1",
                    [&copied_child_id],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(parent, "page:agent-target");
                assert_eq!(child_parent, result.page_id);
                Ok(())
            })
            .expect("verify recursive copy hierarchy");

        let replay_preparation = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentPageCopy {
                        operation_id: "operation:agent-copy".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization),
                        request: Box::new(copy),
                    },
                },
            )
            .expect("prepare committed replay");
        let LibraryReadValue::AgentPageCopyPreparation { value } = replay_preparation.value else {
            panic!("Agent Page copy replay preparation");
        };
        assert_eq!(
            value.preparation.state,
            AgentOperationPreparationState::CommittedReplay
        );
        assert!(value.preparation.token.is_none());
        assert!(value.committed.is_some());
    }

    #[test]
    fn agent_page_batch_creation_previews_without_writes_and_commits_exactly_once() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-agent-create-target",
            "page:agent-create-target",
            "document:agent-create-target",
            "Create target",
            LibraryWriteParent::Library { before: None },
        );
        let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:create-agent-create-thread".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread:agent-create".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project-1".to_owned())),
                            thread_name: Some(Some("Agent create".to_owned())),
                            created_at: Some(100),
                            updated_at: Some(100),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                },
            )
            .expect("persist Agent Thread");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:freeze-agent-create-turn".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread:agent-create".to_owned(),
                        turn_id: "turn:agent-create".to_owned(),
                        root_thread_id: "thread:agent-create".to_owned(),
                        actor_project_id: "project-1".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                },
            )
            .expect("freeze Agent create Turn");
        let turn = ProjectWorkspaceTurnAuthority {
            thread_id: "thread:agent-create".to_owned(),
            turn_id: "turn:agent-create".to_owned(),
            root_thread_id: "thread:agent-create".to_owned(),
            actor_project_id: "project-1".to_owned(),
            library_id: "library-1".to_owned(),
            store_epoch: "epoch-1".to_owned(),
            scope: ProjectWorkspaceTurnAuthorityScope::Project,
            source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
        };
        let authorization = AgentExecutionAuthorization {
            provenance: AgentTurnProvenance {
                profile_id: "profile-1".to_owned(),
                authority: turn.clone(),
            },
            call_id: "call:agent-create".to_owned(),
            resource_access: Some(AgentResourceAccessOverlay {
                kind: AgentResourceAccessOverlayKind::Consent,
                scope: AgentResourceAccessOverlayScope::Call,
                thread_id: Some(turn.thread_id.clone()),
                turn_id: Some(turn.turn_id.clone()),
                call_id: Some("call:agent-create".to_owned()),
                root_thread_id: turn.root_thread_id.clone(),
                actor_project_id: turn.actor_project_id.clone(),
                library_id: turn.library_id.clone(),
                store_epoch: turn.store_epoch.clone(),
                grants: vec![AgentResourceGrantSpec {
                    root: AgentResourceGrantRoot::Page {
                        page_id: "page:agent-create-target".to_owned(),
                    },
                    access: AgentProjectResourceAccess::ReadWrite,
                    library_actions: Vec::new(),
                }],
                persist_resulting_page_grants: false,
            }),
        };
        let create = LibraryAgentCreatePagesRequest {
            destination: LibraryAgentPageDestination::Page {
                page_id: "page:agent-create-target".to_owned(),
                at: None,
            },
            pages: vec![
                LibraryAgentCreatePageDraft {
                    title_markdown: "**First**".to_owned(),
                    nfm: "First body".to_owned(),
                    values: Vec::new(),
                },
                LibraryAgentCreatePageDraft {
                    title_markdown: "Second".to_owned(),
                    nfm: "Second body".to_owned(),
                    values: Vec::new(),
                },
            ],
            include_block_ids: true,
            include_etags: true,
        };
        let durable_before = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM blocks", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM core_module_receipts",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read before create preparation");
        let prepare = || {
            module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read: LibraryRead::PrepareAgentCreatePages {
                            operation_id: "operation:agent-create-pages".to_owned(),
                            store_epoch: "epoch-1".to_owned(),
                            authorization: Box::new(authorization.clone()),
                            request: Box::new(create.clone()),
                        },
                    },
                )
                .expect("prepare Agent Page batch")
        };
        let first_preparation = prepare();
        let prepared = prepare();
        let durable_after = kernel
            .readers()
            .read_default(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM blocks", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM core_module_receipts",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read after create preparation");
        assert_eq!(durable_before, durable_after);
        assert_eq!(
            module
                .prepared_agent_operation_count()
                .expect("one refreshed preparation"),
            1
        );
        let LibraryReadValue::AgentCreatePagesPreparation { value: first } =
            first_preparation.value
        else {
            panic!("first Agent Page-create preparation");
        };
        let LibraryReadValue::AgentCreatePagesPreparation { value } = prepared.value else {
            panic!("Agent Page-create preparation");
        };
        assert_eq!(value.pages.len(), 2);
        assert_eq!(value.document_heads.len(), 1);
        assert_eq!(
            value.document_heads[0].document_id,
            "document:agent-create-target"
        );
        assert_ne!(first.preparation.token, value.preparation.token);
        assert!(
            value
                .pages
                .iter()
                .all(|page| page.body_block_ids.len() == 1)
        );
        let token = value.preparation.token.expect("create token");
        let execute = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "operation:agent-create-pages".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ExecutePreparedAgentCreatePages {
                authorization: Box::new(AgentPreparedExecution {
                    authorization: authorization.clone(),
                    token: Some(token),
                }),
                request: Box::new(create.clone()),
            },
        };
        let committed = module
            .apply(&context(), execute.clone())
            .expect("execute Agent Page batch");
        let replay = module
            .apply(&context(), execute)
            .expect("replay Agent Page batch");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        assert_eq!(
            module
                .prepared_agent_operation_count()
                .expect("consumed create token"),
            0
        );
        let result = committed
            .committed
            .value
            .agent_create_pages
            .as_ref()
            .expect("Agent create result");
        assert_eq!(result.pages.len(), 2);
        assert_eq!(result.document_commits.len(), 1);
        assert_eq!(
            result.document_commits[0].document_id,
            "document:agent-create-target"
        );
        assert!(result.pages.iter().all(|page| page.etags.is_some()));
        assert!(result.pages.iter().all(|page| matches!(
            page.location,
            nodex_core_contracts::library::LibraryAgentPageLocation::Page { ref page_id }
                if page_id == "page:agent-create-target"
        )));
        kernel
            .readers()
            .read_default(|connection| {
                for (page, expected_title) in result.pages.iter().zip(["First", "Second"]) {
                    let authority = connection.query_row(
                        "SELECT page.parent_kind, page.parent_id, entry.document_id, \
                           model.title, document.head_seq \
                         FROM pages page JOIN blocks block ON block.id = page.block_id \
                         JOIN document_block_index entry ON entry.block_id = page.block_id \
                         JOIN page_read_model model ON model.page_block_id = page.block_id \
                         JOIN documents document ON document.id = page.document_id \
                         WHERE page.block_id = ?1",
                        [&page.page_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, i64>(4)?,
                            ))
                        },
                    )?;
                    assert_eq!(authority.0, "page");
                    assert_eq!(authority.1, "page:agent-create-target");
                    assert_eq!(authority.2, "document:agent-create-target");
                    assert_eq!(authority.3, expected_title);
                    assert_eq!(authority.4, 1);
                    assert_eq!(page.block_ids.len(), 1);
                }
                let target_head = connection.query_row(
                    "SELECT head_seq FROM documents WHERE id = 'document:agent-create-target'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(target_head, 2);
                Ok(())
            })
            .expect("verify created Page authority");

        let replay_preparation = prepare();
        let LibraryReadValue::AgentCreatePagesPreparation { value } = replay_preparation.value
        else {
            panic!("Agent Page-create replay preparation");
        };
        assert_eq!(
            value.preparation.state,
            AgentOperationPreparationState::CommittedReplay
        );
        assert!(value.preparation.token.is_none());
        assert!(value.committed.is_some());
    }

    #[test]
    fn agent_page_batch_move_freezes_one_target_and_commits_in_input_order() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        for (operation, page, document, title) in [
            (
                "operation:create-agent-move-target",
                "page:agent-move-target",
                "document:agent-move-target",
                "Move target",
            ),
            (
                "operation:create-agent-move-first",
                "page:agent-move-first",
                "document:agent-move-first",
                "First",
            ),
            (
                "operation:create-agent-move-second",
                "page:agent-move-second",
                "document:agent-move-second",
                "Second",
            ),
        ] {
            create_page(
                &module,
                operation,
                page,
                document,
                title,
                LibraryWriteParent::Library { before: None },
            );
        }
        let authorization = agent_move_authorization(
            &kernel,
            &[
                "page:agent-move-target",
                "page:agent-move-first",
                "page:agent-move-second",
            ],
        );
        let request = LibraryAgentMovePagesRequest {
            page_ids: vec![
                "page:agent-move-second".to_owned(),
                "page:agent-move-first".to_owned(),
            ],
            destination: LibraryAgentPageDestination::Page {
                page_id: "page:agent-move-target".to_owned(),
                at: None,
            },
        };
        let durable_before = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT head_seq FROM documents \
                         WHERE id = 'document:agent-move-target'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("target head before prepare");
        let prepare = || {
            module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read: LibraryRead::PrepareAgentMovePages {
                            operation_id: "operation:agent-move-pages".to_owned(),
                            store_epoch: "epoch-1".to_owned(),
                            authorization: Box::new(authorization.clone()),
                            request: Box::new(request.clone()),
                        },
                    },
                )
                .expect("prepare Agent Page move")
        };
        let first = prepare();
        let refreshed = prepare();
        let LibraryReadValue::AgentMovePagesPreparation { value: first } = first.value else {
            panic!("first Agent Page-move preparation");
        };
        let LibraryReadValue::AgentMovePagesPreparation { value } = refreshed.value else {
            panic!("Agent Page-move preparation");
        };
        assert_ne!(first.preparation.token, value.preparation.token);
        assert_eq!(value.pages.len(), 2);
        assert_eq!(value.document_heads.len(), 1);
        assert_eq!(
            value.document_heads[0].document_id,
            "document:agent-move-target"
        );
        assert_eq!(
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT head_seq FROM documents \
                             WHERE id = 'document:agent-move-target'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(StoreError::from)
                })
                .expect("target head after prepare"),
            durable_before
        );
        let token = value.preparation.token.expect("move token");
        let apply = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "operation:agent-move-pages".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ExecutePreparedAgentMovePages {
                authorization: Box::new(AgentPreparedExecution {
                    authorization: authorization.clone(),
                    token: Some(token),
                }),
                request: Box::new(request.clone()),
            },
        };
        let committed = module
            .apply(&context(), apply.clone())
            .expect("execute Agent Page move");
        let replay = module
            .apply(&context(), apply)
            .expect("replay Agent Page move");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        let result = committed
            .committed
            .value
            .agent_move_pages
            .expect("Agent Page-move result");
        assert_eq!(result.pages.len(), 2);
        assert_eq!(result.document_commits.len(), 1);
        assert_eq!(
            result.document_commits[0].document_id,
            "document:agent-move-target"
        );
        assert!(result.pages.iter().all(|page| matches!(
            page.location,
            nodex_core_contracts::library::LibraryAgentPageLocation::Page { ref page_id }
                if page_id == "page:agent-move-target"
        )));
        kernel
            .readers()
            .read_default(|connection| {
                let order = connection
                    .prepare(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = 'document:agent-move-target' \
                           AND block_id IN ('page:agent-move-first', 'page:agent-move-second') \
                         ORDER BY ordinal, block_id",
                    )?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    order,
                    vec![
                        "page:agent-move-second".to_owned(),
                        "page:agent-move-first".to_owned(),
                    ]
                );
                let target_head = connection.query_row(
                    "SELECT head_seq FROM documents \
                     WHERE id = 'document:agent-move-target'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(target_head, durable_before + 1);
                let semantic_commits = connection.query_row(
                    "SELECT count(*) FROM local_commits
                     WHERE operation_id = 'operation:agent-move-pages'
                        OR operation_id LIKE 'operation:agent-move-pages:page:%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(semantic_commits, 1);
                let receipts = connection.query_row(
                    "SELECT count(*) FROM core_module_receipts
                     WHERE operation_id = 'operation:agent-move-pages'
                        OR operation_id LIKE 'operation:agent-move-pages:page:%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(receipts, 1);
                Ok(())
            })
            .expect("verify Agent Page move");
        let replay_preparation = prepare();
        let LibraryReadValue::AgentMovePagesPreparation { value } = replay_preparation.value else {
            panic!("Agent Page-move replay preparation");
        };
        assert_eq!(
            value.preparation.state,
            AgentOperationPreparationState::CommittedReplay
        );
        assert!(value.committed.is_some());
    }

    #[test]
    fn agent_page_batch_move_merges_distinct_source_and_target_documents_once() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        for (operation, page, document, title) in [
            (
                "operation:create-agent-batch-source-a",
                "page:agent-batch-source-a",
                "document:agent-batch-source-a",
                "Source A",
            ),
            (
                "operation:create-agent-batch-source-b",
                "page:agent-batch-source-b",
                "document:agent-batch-source-b",
                "Source B",
            ),
            (
                "operation:create-agent-batch-target",
                "page:agent-batch-target",
                "document:agent-batch-aaa-target",
                "Target",
            ),
        ] {
            create_page(
                &module,
                operation,
                page,
                document,
                title,
                LibraryWriteParent::Library { before: None },
            );
        }
        for (operation, page, document, title, parent) in [
            (
                "operation:create-agent-batch-child-a",
                "page:agent-batch-child-a",
                "document:agent-batch-child-a",
                "Child A",
                "page:agent-batch-source-a",
            ),
            (
                "operation:create-agent-batch-child-b",
                "page:agent-batch-child-b",
                "document:agent-batch-child-b",
                "Child B",
                "page:agent-batch-source-b",
            ),
        ] {
            create_page(
                &module,
                operation,
                page,
                document,
                title,
                LibraryWriteParent::Page {
                    page_id: parent.to_owned(),
                    expected_document_generation: 1,
                    expected_document_head_seq: 1,
                    before: None,
                    insertion: None,
                },
            );
        }
        let authorization = agent_move_authorization(
            &kernel,
            &[
                "page:agent-batch-child-a",
                "page:agent-batch-child-b",
                "page:agent-batch-target",
            ],
        );
        let request = LibraryAgentMovePagesRequest {
            page_ids: vec![
                "page:agent-batch-child-b".to_owned(),
                "page:agent-batch-child-a".to_owned(),
            ],
            destination: LibraryAgentPageDestination::Page {
                page_id: "page:agent-batch-target".to_owned(),
                at: None,
            },
        };
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentMovePages {
                        operation_id: "operation:agent-batch-distinct-documents".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(request.clone()),
                    },
                },
            )
            .expect("prepare distinct-Document Agent Page move");
        let LibraryReadValue::AgentMovePagesPreparation { value } = prepared.value else {
            panic!("distinct-Document Agent Page-move preparation");
        };
        let committed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:agent-batch-distinct-documents".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ExecutePreparedAgentMovePages {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization,
                            token: value.preparation.token,
                        }),
                        request: Box::new(request),
                    },
                },
            )
            .expect("execute distinct-Document Agent Page move");
        let result = committed
            .committed
            .value
            .agent_move_pages
            .expect("distinct-Document Agent Page-move result");
        assert_eq!(result.document_commits.len(), 3);
        assert_eq!(
            result
                .document_commits
                .iter()
                .map(|commit| commit.document_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "document:agent-batch-source-a",
                "document:agent-batch-source-b",
                "document:agent-batch-aaa-target",
            ])
        );
        kernel
            .readers()
            .read_default(|connection| {
                let target_order = connection
                    .prepare(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = 'document:agent-batch-aaa-target' \
                           AND block_id IN ('page:agent-batch-child-a', 'page:agent-batch-child-b') \
                         ORDER BY ordinal, block_id",
                    )?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    target_order,
                    vec![
                        "page:agent-batch-child-b".to_owned(),
                        "page:agent-batch-child-a".to_owned(),
                    ]
                );
                for document_id in [
                    "document:agent-batch-source-a",
                    "document:agent-batch-source-b",
                    "document:agent-batch-aaa-target",
                ] {
                    let head = connection.query_row(
                        "SELECT head_seq FROM documents WHERE id = ?1",
                        [document_id],
                        |row| row.get::<_, i64>(0),
                    )?;
                    assert_eq!(head, if document_id.ends_with("target") { 2 } else { 3 });
                }
                let semantic_commits = connection.query_row(
                    "SELECT count(*) FROM local_commits \
                     WHERE operation_id = 'operation:agent-batch-distinct-documents'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(semantic_commits, 1);
                Ok(())
            })
            .expect("verify distinct-Document Agent Page move");
    }

    #[test]
    fn agent_page_move_preserves_library_owned_closure_in_call_granted_page() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-agent-cross-project-source",
            "page:agent-cross-project-source",
            "document:agent-cross-project-source",
            "Cross-project source",
            LibraryWriteParent::Library { before: None },
        );
        create_page(
            &module,
            "operation:create-agent-cross-project-child",
            "page:agent-cross-project-child",
            "document:agent-cross-project-child",
            "Cross-project child",
            LibraryWriteParent::Page {
                page_id: "page:agent-cross-project-source".to_owned(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                before: None,
                insertion: None,
            },
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Move target', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed move target Project");
        module
            .apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-agent-cross-project-target".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:agent-cross-project-target".to_owned(),
                        document_id: "document:agent-cross-project-target".to_owned(),
                        title: "Cross-project target".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create cross-Project target Page");
        let authorization = agent_move_authorization(
            &kernel,
            &[
                "page:agent-cross-project-source",
                "page:agent-cross-project-target",
            ],
        );
        let request = LibraryAgentMovePagesRequest {
            page_ids: vec!["page:agent-cross-project-source".to_owned()],
            destination: LibraryAgentPageDestination::Page {
                page_id: "page:agent-cross-project-target".to_owned(),
                at: None,
            },
        };
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentMovePages {
                        operation_id: "operation:agent-cross-project-move".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(request.clone()),
                    },
                },
            )
            .expect("prepare cross-Project Agent Page move");
        let LibraryReadValue::AgentMovePagesPreparation { value } = prepared.value else {
            panic!("cross-Project Agent Page-move preparation");
        };
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:agent-cross-project-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ExecutePreparedAgentMovePages {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization,
                            token: value.preparation.token,
                        }),
                        request: Box::new(request),
                    },
                },
            )
            .expect("execute cross-Project Agent Page move");
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT root.library_id, root_entry.document_id, root_page.parent_id, \
                            root_document.library_id, child.library_id, child_page.parent_id, \
                            child_document.library_id \
                     FROM blocks root JOIN pages root_page ON root_page.block_id = root.id \
                     JOIN document_block_index root_entry ON root_entry.block_id = root.id \
                     JOIN documents root_document ON root_document.id = root_page.document_id \
                     JOIN blocks child ON child.id = 'page:agent-cross-project-child' \
                     JOIN pages child_page ON child_page.block_id = child.id \
                     JOIN documents child_document ON child_document.id = child_page.document_id \
                     WHERE root.id = 'page:agent-cross-project-source'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "library-1".to_owned(),
                        "document:agent-cross-project-target".to_owned(),
                        "page:agent-cross-project-target".to_owned(),
                        "library-1".to_owned(),
                        "library-1".to_owned(),
                        "page:agent-cross-project-source".to_owned(),
                        "library-1".to_owned(),
                    )
                );
                let wrong_search_owner = connection.query_row(
                    "SELECT count(*) FROM block_search_units \
                     WHERE owner_block_id IN \
                       ('page:agent-cross-project-source', 'page:agent-cross-project-child') \
                       AND library_id <> 'library-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(wrong_search_owner, 0);
                let foreign_keys = connection
                    .prepare("PRAGMA foreign_key_check")?
                    .query_map([], |_| Ok(()))?
                    .count();
                assert_eq!(foreign_keys, 0);
                Ok(())
            })
            .expect("verify Library-stable cross-Project Page move");
    }

    #[test]
    fn agent_page_move_changes_parent_while_preserving_library_content_identity() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-agent-storage-source",
            "page:agent-storage-source",
            "document:agent-storage-source",
            "Storage source",
            LibraryWriteParent::Library { before: None },
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Database target', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed Database target Project");
        module
            .apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-agent-storage-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000501".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000502".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000503".to_owned(),
                        name: "Agent storage target".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create target Database");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET database_block_id = \
                       '018f0000-0000-7000-8000-000000000501' WHERE id = 'project-2'",
                    [],
                )?;
                Ok(())
            })
            .expect("bind target Database");
        let mut authorization = agent_move_authorization(&kernel, &["page:agent-storage-source"]);
        authorization
            .resource_access
            .as_mut()
            .expect("Agent storage overlay")
            .grants
            .push(AgentResourceGrantSpec {
                root: AgentResourceGrantRoot::Database {
                    database_id: "018f0000-0000-7000-8000-000000000501".to_owned(),
                },
                access: AgentProjectResourceAccess::ReadWrite,
                library_actions: Vec::new(),
            });
        authorization
            .resource_access
            .as_mut()
            .expect("Agent storage overlay")
            .grants
            .push(AgentResourceGrantSpec {
                root: AgentResourceGrantRoot::Library {
                    library_id: "library-1".to_owned(),
                },
                access: AgentProjectResourceAccess::ReadWrite,
                library_actions: vec![AgentProjectResourceAction::CreateChild],
            });
        execute_agent_move(
            &module,
            authorization.clone(),
            "operation:agent-move-to-foreign-data-source",
            LibraryAgentMovePagesRequest {
                page_ids: vec!["page:agent-storage-source".to_owned()],
                destination: LibraryAgentPageDestination::DataSource {
                    data_source_id: "018f0000-0000-7000-8000-000000000502".to_owned(),
                    values: Vec::new(),
                    view_id: Some("018f0000-0000-7000-8000-000000000503".to_owned()),
                    group_key: None,
                    at: None,
                },
            },
        );
        kernel
            .readers()
            .read_default(|connection| {
                let state = connection.query_row(
                    "SELECT block.library_id, page.parent_kind, page.parent_id, \
                            document.library_id, model.library_id, model.database_block_id \
                     FROM blocks block JOIN pages page ON page.block_id = block.id \
                     JOIN documents document ON document.id = page.document_id \
                     JOIN page_read_model model ON model.page_block_id = page.block_id \
                     WHERE block.id = 'page:agent-storage-source'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )?;
                assert_eq!(
                    state,
                    (
                        "library-1".to_owned(),
                        "data_source".to_owned(),
                        "018f0000-0000-7000-8000-000000000502".to_owned(),
                        "library-1".to_owned(),
                        "library-1".to_owned(),
                        Some("018f0000-0000-7000-8000-000000000501".to_owned()),
                    )
                );
                Ok(())
            })
            .expect("verify foreign Data Source storage");

        authorization.call_id = "call:agent-move-library".to_owned();
        authorization
            .resource_access
            .as_mut()
            .expect("Agent Library overlay")
            .call_id = Some("call:agent-move-library".to_owned());
        execute_agent_move(
            &module,
            authorization,
            "operation:agent-move-back-to-library",
            LibraryAgentMovePagesRequest {
                page_ids: vec!["page:agent-storage-source".to_owned()],
                destination: LibraryAgentPageDestination::Library {
                    at: Some(nodex_core_contracts::library::LibraryAgentSiblingAnchor::Start),
                },
            },
        );
        kernel
            .readers()
            .read_default(|connection| {
                let state = connection.query_row(
                    "SELECT block.library_id, page.parent_kind, page.parent_id, \
                            document.library_id, placement.library_id, model.library_id, \
                            model.library_rank_key \
                     FROM blocks block JOIN pages page ON page.block_id = block.id \
                     JOIN documents document ON document.id = page.document_id \
                     JOIN library_block_placements placement ON placement.block_id = block.id \
                     JOIN page_read_model model ON model.page_block_id = block.id \
                     WHERE block.id = 'page:agent-storage-source'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<String>>(6)?,
                        ))
                    },
                )?;
                assert_eq!(state.0, "library-1");
                assert_eq!(state.1, "library");
                assert_eq!(state.2, "library-1");
                assert_eq!(state.3, "library-1");
                assert_eq!(state.4, "library-1");
                assert_eq!(state.5, "library-1");
                assert!(state.6.is_some());
                Ok(())
            })
            .expect("verify stable Library storage");
    }

    #[test]
    fn agent_page_batch_move_finalizes_data_source_order_in_one_receipt() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_database(&module);
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET database_block_id = \
                       '018f0000-0000-7000-8000-000000000101' WHERE id = 'project-1'",
                    [],
                )?;
                Ok(())
            })
            .expect("bind Agent move target Database");
        for (operation, page, document, title) in [
            (
                "operation:create-agent-database-move-first",
                "page:agent-database-move-first",
                "document:agent-database-move-first",
                "First",
            ),
            (
                "operation:create-agent-database-move-second",
                "page:agent-database-move-second",
                "document:agent-database-move-second",
                "Second",
            ),
        ] {
            create_page(
                &module,
                operation,
                page,
                document,
                title,
                LibraryWriteParent::Library { before: None },
            );
        }
        let mut authorization = agent_move_authorization(
            &kernel,
            &[
                "page:agent-database-move-first",
                "page:agent-database-move-second",
            ],
        );
        authorization
            .resource_access
            .as_mut()
            .expect("move overlay")
            .grants
            .push(AgentResourceGrantSpec {
                root: AgentResourceGrantRoot::Database {
                    database_id: "018f0000-0000-7000-8000-000000000101".to_owned(),
                },
                access: AgentProjectResourceAccess::ReadWrite,
                library_actions: Vec::new(),
            });
        let request = LibraryAgentMovePagesRequest {
            page_ids: vec![
                "page:agent-database-move-second".to_owned(),
                "page:agent-database-move-first".to_owned(),
            ],
            destination: LibraryAgentPageDestination::DataSource {
                data_source_id: "018f0000-0000-7000-8000-000000000102".to_owned(),
                values: Vec::new(),
                view_id: Some("018f0000-0000-7000-8000-000000000103".to_owned()),
                group_key: None,
                at: Some(nodex_core_contracts::library::LibraryAgentSiblingAnchor::Start),
            },
        };
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentMovePages {
                        operation_id: "operation:agent-database-move-pages".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(request.clone()),
                    },
                },
            )
            .expect("prepare Agent Data Source move");
        let LibraryReadValue::AgentMovePagesPreparation { value } = prepared.value else {
            panic!("Agent Data Source move preparation");
        };
        assert!(value.document_heads.is_empty());
        let committed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:agent-database-move-pages".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ExecutePreparedAgentMovePages {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization: authorization.clone(),
                            token: value.preparation.token,
                        }),
                        request: Box::new(request.clone()),
                    },
                },
            )
            .expect("execute Agent Data Source move");
        let result = committed
            .committed
            .value
            .agent_move_pages
            .expect("Agent Data Source move result");
        assert_eq!(
            result.affected_database_ids,
            vec!["018f0000-0000-7000-8000-000000000101".to_owned()]
        );
        assert!(result.document_commits.is_empty());
        kernel
            .readers()
            .read_default(|connection| {
                let order = connection
                    .prepare(
                        "SELECT membership.page_block_id \
                         FROM data_source_page_memberships membership \
                         JOIN database_view_page_positions position \
                           ON position.page_block_id = membership.page_block_id \
                          AND position.view_id = '018f0000-0000-7000-8000-000000000103' \
                         WHERE membership.data_source_id = \
                           '018f0000-0000-7000-8000-000000000102' \
                           AND membership.removed_at IS NULL \
                         ORDER BY position.rank_key, membership.page_block_id",
                    )?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    order,
                    vec![
                        "page:agent-database-move-second".to_owned(),
                        "page:agent-database-move-first".to_owned(),
                    ]
                );
                Ok(())
            })
            .expect("verify Agent Data Source move order");

        let same_source_request = LibraryAgentMovePagesRequest {
            page_ids: vec![
                "page:agent-database-move-first".to_owned(),
                "page:agent-database-move-second".to_owned(),
            ],
            destination: request.destination,
        };
        let prepared = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PrepareAgentMovePages {
                        operation_id: "operation:agent-same-database-move-pages".to_owned(),
                        store_epoch: "epoch-1".to_owned(),
                        authorization: Box::new(authorization.clone()),
                        request: Box::new(same_source_request.clone()),
                    },
                },
            )
            .expect("prepare same-Data-Source Agent move");
        let LibraryReadValue::AgentMovePagesPreparation { value } = prepared.value else {
            panic!("same-Data-Source Agent move preparation");
        };
        assert!(value.document_heads.is_empty());
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:agent-same-database-move-pages".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ExecutePreparedAgentMovePages {
                        authorization: Box::new(AgentPreparedExecution {
                            authorization,
                            token: value.preparation.token,
                        }),
                        request: Box::new(same_source_request),
                    },
                },
            )
            .expect("execute same-Data-Source Agent move");
        kernel
            .readers()
            .read_default(|connection| {
                let order = connection
                    .prepare(
                        "SELECT position.page_block_id \
                         FROM database_view_page_positions position \
                         WHERE position.view_id = \
                           '018f0000-0000-7000-8000-000000000103' \
                           AND position.page_block_id IN ( \
                             'page:agent-database-move-first', \
                             'page:agent-database-move-second' \
                           ) ORDER BY position.rank_key, position.page_block_id",
                    )?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    order,
                    vec![
                        "page:agent-database-move-first".to_owned(),
                        "page:agent-database-move-second".to_owned(),
                    ]
                );
                Ok(())
            })
            .expect("verify same-Data-Source Agent move order");
    }

    #[test]
    fn recursively_copies_page_authority_to_library_or_page_once() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-source",
            "page:source",
            "document:source",
            "Source Page",
            LibraryWriteParent::Library { before: None },
        );
        create_page(
            &module,
            "operation:create-child",
            "page:child",
            "document:child",
            "Child Page",
            LibraryWriteParent::Page {
                page_id: "page:source".to_owned(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                before: None,
                insertion: None,
            },
        );
        create_page(
            &module,
            "operation:create-target",
            "page:target",
            "document:target",
            "Target Page",
            LibraryWriteParent::Library { before: None },
        );

        let library_request = copy_request(
            "operation:copy-to-library",
            2,
            LibraryPageCopyDestination::Library { before: None },
        );
        let library_copy = module
            .apply(&context(), library_request.clone())
            .expect("copy Page to Library");
        let library_replay = module
            .apply(&context(), library_request)
            .expect("replay Page copy");
        let result = library_copy
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("copy result");
        let copied_root_id = result.page_id.clone();
        let copied_child_id = result.block_ids["page:child"].clone();
        let copied_root_document_id = result.document_id.clone();
        let copied_child_document_id = result.document_ids["document:child"].clone();
        assert!(library_copy.event.is_some());
        assert!(library_replay.event.is_none());
        assert!(library_replay.committed.receipt.mutation.duplicate);
        assert_eq!(result.block_ids.len(), 4);
        assert_eq!(result.document_ids.len(), 2);

        let page_request = copy_request(
            "operation:copy-to-page",
            2,
            LibraryPageCopyDestination::Page {
                page_id: "page:target".to_owned(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                before: None,
            },
        );
        let page_copy = module
            .apply(&context(), page_request.clone())
            .expect("copy Page into Page");
        let page_replay = module
            .apply(&context(), page_request)
            .expect("replay nested Page copy");
        let nested_result = page_copy
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("nested copy result");
        assert_eq!(
            page_copy.committed.receipt.committed_revisions["documentHead:document:target"],
            2
        );
        assert!(page_copy.event.is_some());
        assert!(page_replay.event.is_none());
        assert!(page_replay.committed.receipt.mutation.duplicate);

        let stale = module
            .apply(
                &context(),
                copy_request(
                    "operation:copy-stale-source",
                    1,
                    LibraryPageCopyDestination::Library { before: None },
                ),
            )
            .expect_err("reject stale Page copy");
        assert_eq!(stale.code, CoreErrorCode::HeadConflict);

        let roots = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::Children {
                        parent: LibraryNavigationParent::Library,
                        cursor: None,
                        limit: None,
                        force_include_target: None,
                    },
                },
            )
            .expect("read Library roots");
        let LibraryReadValue::Children { items, .. } = roots.value else {
            panic!("Library children");
        };
        assert!(items.iter().any(|item| matches!(
            item,
            LibraryNavigationNode::Page { page_id, title, .. }
                if page_id == &copied_root_id && title == "Source Page"
        )));
        assert!(!items.iter().any(|item| matches!(
            item,
            LibraryNavigationNode::Page { page_id, .. } if page_id == &copied_child_id
        )));

        kernel
            .readers()
            .read_default(|connection| {
                let copied = connection.query_row(
                    "SELECT root_document.head_seq, child_document.head_seq, \
                       child_page.parent_kind, child_page.parent_id, child_entry.document_id, \
                       (SELECT count(*) FROM document_block_index \
                         WHERE document_id = ?1 AND block_id = ?2), \
                       (SELECT count(*) FROM change_log \
                         WHERE operation_id = 'operation:copy-to-library'), \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' \
                           AND operation_id = 'operation:copy-to-library'), \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' \
                           AND operation_id = 'operation:copy-stale-source') \
                     FROM documents root_document \
                     JOIN documents child_document ON child_document.id = ?3 \
                     JOIN pages child_page ON child_page.block_id = ?2 \
                     JOIN blocks child_block ON child_block.id = child_page.block_id \
                     JOIN document_block_index child_entry ON child_entry.block_id = child_block.id \
                     WHERE root_document.id = ?1",
                    params![
                        copied_root_document_id,
                        copied_child_id,
                        copied_child_document_id,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )?;
                assert_eq!(
                    copied,
                    (
                        1,
                        1,
                        "page".to_owned(),
                        copied_root_id.clone(),
                        copied_root_document_id.clone(),
                        1,
                        1,
                        1,
                        0,
                    )
                );
                let nested_parent = connection.query_row(
                    "SELECT page.parent_kind, page.parent_id, entry.document_id, \
                       target_document.head_seq \
                     FROM pages page JOIN blocks block ON block.id = page.block_id \
                     JOIN document_block_index entry ON entry.block_id = block.id \
                     JOIN documents target_document ON target_document.id = 'document:target' \
                     WHERE page.block_id = ?1",
                    [&nested_result.page_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(
                    nested_parent,
                    (
                        "page".to_owned(),
                        "page:target".to_owned(),
                        "document:target".to_owned(),
                        2,
                    )
                );
                Ok(())
            })
            .expect("durable recursive copy evidence");
    }

    #[test]
    fn copies_page_into_data_source_with_values_and_view_position_atomically() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-source",
            "page:source",
            "document:source",
            "Source row",
            LibraryWriteParent::Library { before: None },
        );
        create_database(&module);
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET database_block_id = \
                     '018f0000-0000-7000-8000-000000000101' WHERE id = 'project-1'",
                    [],
                )?;
                Ok(())
            })
            .expect("bind target Database");
        let request = copy_request(
            "operation:copy-to-data-source",
            1,
            LibraryPageCopyDestination::DataSource {
                data_source_id: "018f0000-0000-7000-8000-000000000102".to_owned(),
                expected_data_source_revision: 1,
                values: vec![LibraryPageCopyValue {
                    property_id: "status".to_owned(),
                    value: serde_json::json!("ship"),
                }],
                view: Some(LibraryPageCopyViewPlacement {
                    view_id: "018f0000-0000-7000-8000-000000000103".to_owned(),
                    expected_view_revision: 1,
                    group_key: Some("ship".to_owned()),
                    before: None,
                }),
            },
        );
        let copied = module
            .apply(&context(), request.clone())
            .expect("copy Page to Data Source");
        let replay = module
            .apply(&context(), request)
            .expect("replay Data Source Page copy");
        let result = copied
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("copy result");
        assert!(copied.event.is_some());
        assert!(replay.event.is_none());
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            copied.committed.receipt.affected_database_ids,
            vec!["018f0000-0000-7000-8000-000000000101".to_owned()]
        );
        assert_eq!(
            copied.committed.receipt.affected_view_ids,
            vec!["018f0000-0000-7000-8000-000000000103".to_owned()]
        );
        assert_eq!(
            copied.committed.receipt.committed_revisions[&format!(
                "propertyValue:018f0000-0000-7000-8000-000000000102:{}:status",
                result.page_id
            )],
            2
        );

        let stale = module
            .apply(
                &context(),
                copy_request(
                    "operation:copy-to-stale-data-source",
                    1,
                    LibraryPageCopyDestination::DataSource {
                        data_source_id: "018f0000-0000-7000-8000-000000000102".to_owned(),
                        expected_data_source_revision: 0,
                        values: Vec::new(),
                        view: None,
                    },
                ),
            )
            .expect_err("reject stale Data Source copy");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        let relation_target_page_id = result.page_id.clone();
        let seeded_relation_target_page_id = relation_target_page_id.clone();
        kernel
            .writer()
            .call(move |connection| {
                let data_source_id = "018f0000-0000-7000-8000-000000000102";
                let property_id = "p_blocked0";
                connection.execute(
                    "INSERT INTO data_source_properties(\
                       data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                       schema_revision, created_at, updated_at\
                     ) VALUES (?1, ?2, 'Blocked by', 'relation', '{}', \
                       'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'active', 1, ?3, ?3)",
                    params![data_source_id, property_id, NOW],
                )?;
                connection.execute(
                    "INSERT INTO data_source_relation_properties(\
                       data_source_id, property_id, target_data_source_id\
                     ) VALUES (?1, ?2, ?1)",
                    params![data_source_id, property_id],
                )?;
                let membership_id = connection.query_row(
                    "SELECT id FROM data_source_page_memberships \
                     WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NULL",
                    params![data_source_id, seeded_relation_target_page_id],
                    |row| row.get::<_, String>(0),
                )?;
                connection.execute(
                    "INSERT INTO data_source_property_values(\
                       data_source_id, membership_id, property_id, value_type, value_json, \
                       revision, updated_at\
                     ) VALUES (?1, ?2, ?3, 'relation', ?4, 1, ?5)",
                    params![data_source_id, membership_id, property_id, "null", NOW],
                )?;
                connection.execute(
                    "INSERT INTO data_source_relation_edges(\
                       edge_id, source_data_source_id, source_membership_id, property_id, \
                       target_page_block_id, created_at\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        "a".repeat(64),
                        data_source_id,
                        membership_id,
                        property_id,
                        seeded_relation_target_page_id,
                        NOW,
                    ],
                )?;
                Ok(())
            })
            .expect("seed Relation value");

        let copied_again = module
            .apply(
                &context(),
                copy_request_for(
                    "operation:copy-data-source-row",
                    &result.page_id,
                    2,
                    2,
                    1,
                    1,
                    LibraryPageCopyDestination::DataSource {
                        data_source_id: "018f0000-0000-7000-8000-000000000102".to_owned(),
                        expected_data_source_revision: 1,
                        values: Vec::new(),
                        view: None,
                    },
                ),
            )
            .expect("copy Data Source row into same source");
        let copied_again_id = copied_again
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("second copy result")
            .page_id
            .clone();

        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT block.library_id, block.placement_revision, \
                       block.metadata_revision, page.parent_kind, page.parent_id, \
                       membership.revision, value.value_json, value.revision, position.revision, \
                       projection.membership_id, projection.database_block_id, \
                       projection.view_id, projection.view_group_key, \
                       json_extract(projection.database_values_json, '$.status'), \
                       (SELECT count(*) FROM library_block_placements WHERE block_id = block.id), \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' \
                           AND operation_id = 'operation:copy-to-stale-data-source') \
                     FROM blocks block JOIN pages page ON page.block_id = block.id \
                     JOIN data_source_page_memberships membership \
                       ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
                     JOIN data_source_property_values value ON value.membership_id = membership.id \
                       AND value.data_source_id = membership.data_source_id \
                       AND value.property_id = 'status' \
                     JOIN database_view_page_positions position ON position.page_block_id = block.id \
                       AND position.view_id = '018f0000-0000-7000-8000-000000000103' \
                     JOIN page_read_model projection ON projection.page_block_id = block.id \
                     WHERE block.id = ?1",
                    [&result.page_id],
                    |row| {
                        Ok((
                            (
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, i64>(5)?,
                                row.get::<_, String>(6)?,
                            ),
                            (
                                row.get::<_, i64>(7)?,
                                row.get::<_, i64>(8)?,
                                row.get::<_, String>(9)?,
                                row.get::<_, String>(10)?,
                                row.get::<_, String>(11)?,
                                row.get::<_, String>(12)?,
                                row.get::<_, String>(13)?,
                                row.get::<_, i64>(14)?,
                                row.get::<_, i64>(15)?,
                            ),
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        (
                            "library-1".to_owned(),
                            2,
                            3,
                            "data_source".to_owned(),
                            "018f0000-0000-7000-8000-000000000102".to_owned(),
                            1,
                            "\"ship\"".to_owned(),
                        ),
                        (
                            2,
                            1,
                            format!(
                                "membership:{}",
                                sha256(
                                    format!(
                                        "018f0000-0000-7000-8000-000000000102\0{}",
                                        result.page_id
                                    )
                                    .as_bytes()
                                )
                            ),
                            "018f0000-0000-7000-8000-000000000101".to_owned(),
                            "018f0000-0000-7000-8000-000000000103".to_owned(),
                            "ship".to_owned(),
                            "ship".to_owned(),
                            0,
                            0,
                        ),
                    )
                );
                let copied_value = connection.query_row(
                    "SELECT value.value_json, value.revision, membership.revision, \
                       block.placement_revision \
                     FROM data_source_page_memberships membership \
                     JOIN data_source_property_values value ON value.membership_id = membership.id \
                       AND value.data_source_id = membership.data_source_id \
                       AND value.property_id = 'status' \
                     JOIN blocks block ON block.id = membership.page_block_id \
                     JOIN pages page ON page.block_id = block.id \
                     WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL",
                    [&copied_again_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )?;
                assert_eq!(copied_value, ("\"ship\"".to_owned(), 1, 1, 2));
                let copied_relation = connection.query_row(
                    "SELECT value.value_json, edge.target_page_block_id \
                     FROM data_source_page_memberships membership \
                     JOIN data_source_property_values value ON value.membership_id = membership.id \
                       AND value.data_source_id = membership.data_source_id \
                       AND value.property_id = 'p_blocked0' \
                     JOIN data_source_relation_edges edge \
                       ON edge.source_data_source_id = membership.data_source_id \
                      AND edge.source_membership_id = membership.id \
                      AND edge.property_id = value.property_id \
                     WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL",
                    [&copied_again_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(
                    copied_relation,
                    (
                        "null".to_owned(),
                        relation_target_page_id.clone(),
                    )
                );
                Ok(())
            })
            .expect("durable Data Source copy evidence");
    }

    #[test]
    fn copies_library_owned_closure_into_granted_data_source() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-source",
            "page:source",
            "document:source",
            "Cross Project source",
            LibraryWriteParent::Library { before: None },
        );
        create_page(
            &module,
            "operation:create-child",
            "page:child",
            "document:child",
            "Cross Project child",
            LibraryWriteParent::Page {
                page_id: "page:source".to_owned(),
                expected_document_generation: 1,
                expected_document_head_seq: 1,
                before: None,
                insertion: None,
            },
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Target storage', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed target Project");
        module
            .apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-project-2-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: "018f0000-0000-7000-8000-000000000301".to_owned(),
                        data_source_id: "018f0000-0000-7000-8000-000000000302".to_owned(),
                        view_id: "018f0000-0000-7000-8000-000000000303".to_owned(),
                        name: "Granted target".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create target Project Database");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET database_block_id = \
                     '018f0000-0000-7000-8000-000000000301' WHERE id = 'project-2'",
                    [],
                )?;
                Ok(())
            })
            .expect("bind target Project Database");
        module
            .apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grant-project-1-target".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Database {
                            database_id: "018f0000-0000-7000-8000-000000000301".to_owned(),
                        },
                        access: LibraryAccess::ReadWrite,
                    },
                },
            )
            .expect("grant target Database write access");

        let copied = module
            .apply(
                &context(),
                copy_request(
                    "operation:copy-across-projects",
                    2,
                    LibraryPageCopyDestination::DataSource {
                        data_source_id: "018f0000-0000-7000-8000-000000000302".to_owned(),
                        expected_data_source_revision: 1,
                        values: Vec::new(),
                        view: None,
                    },
                ),
            )
            .expect("copy into granted Data Source");
        let result = copied
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("copy result");
        let copied_child_id = result.block_ids["page:child"].clone();
        let copied_child_document_id = result.document_ids["document:child"].clone();

        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT root.library_id, membership.data_source_id, \
                       root_page.parent_kind, root_page.parent_id, root_document.library_id, \
                       child.library_id, child_entry.document_id, child_page.parent_id, \
                       child_document.library_id, source.library_id, \
                       (SELECT count(*) FROM project_resource_grants \
                         WHERE project_id = 'project-1' AND root_kind = 'database' \
                           AND root_id = '018f0000-0000-7000-8000-000000000301' \
                           AND access = 'read_write' AND lifecycle = 'active') \
                     FROM blocks root JOIN pages root_page ON root_page.block_id = root.id \
                     JOIN data_source_page_memberships membership \
                       ON membership.page_block_id = root.id AND membership.removed_at IS NULL \
                     JOIN documents root_document ON root_document.id = ?2 \
                     JOIN blocks child ON child.id = ?3 \
                     JOIN pages child_page ON child_page.block_id = child.id \
                     JOIN document_block_index child_entry ON child_entry.block_id = child.id \
                     JOIN documents child_document ON child_document.id = ?4 \
                     JOIN blocks source ON source.id = 'page:source' \
                     WHERE root.id = ?1",
                    params![
                        result.page_id,
                        result.document_id,
                        copied_child_id,
                        copied_child_document_id,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, String>(9)?,
                            row.get::<_, i64>(10)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "library-1".to_owned(),
                        "018f0000-0000-7000-8000-000000000302".to_owned(),
                        "data_source".to_owned(),
                        "018f0000-0000-7000-8000-000000000302".to_owned(),
                        "library-1".to_owned(),
                        "library-1".to_owned(),
                        result.document_id.clone(),
                        result.page_id.clone(),
                        "library-1".to_owned(),
                        "library-1".to_owned(),
                        1,
                    )
                );
                Ok(())
            })
            .expect("cross-Project copy evidence");
    }

    #[test]
    fn page_destination_requires_write_grant_without_changing_library_ownership() {
        let (_directory, kernel) = seeded_kernel();
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        create_page(
            &module,
            "operation:create-source",
            "page:source",
            "document:source",
            "Source",
            LibraryWriteParent::Library { before: None },
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Page target', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed target Project");
        module
            .apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-target-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:target".to_owned(),
                        document_id: "document:target".to_owned(),
                        title: "Target".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create target Project Page");
        let grant = |operation_id: &str, access| {
            module.apply(
                &context_for("project-2"),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::GrantProjectAccess {
                        project_id: "project-1".to_owned(),
                        target: LibraryResourceTarget::Page {
                            page_id: "page:target".to_owned(),
                        },
                        access,
                    },
                },
            )
        };
        grant("operation:grant-target-read", LibraryAccess::Read).expect("grant Page read access");
        let denied = module
            .apply(
                &context(),
                copy_request(
                    "operation:copy-with-read-grant",
                    1,
                    LibraryPageCopyDestination::Page {
                        page_id: "page:target".to_owned(),
                        expected_document_generation: 1,
                        expected_document_head_seq: 1,
                        before: None,
                    },
                ),
            )
            .expect_err("read grant cannot write target Page");
        assert_eq!(denied.code, CoreErrorCode::NotFound);
        grant("operation:grant-target-write", LibraryAccess::ReadWrite)
            .expect("upgrade Page write access");
        let copied = module
            .apply(
                &context(),
                copy_request(
                    "operation:copy-with-write-grant",
                    1,
                    LibraryPageCopyDestination::Page {
                        page_id: "page:target".to_owned(),
                        expected_document_generation: 1,
                        expected_document_head_seq: 1,
                        before: None,
                    },
                ),
            )
            .expect("write grant copies into target Page");
        let result = copied
            .committed
            .value
            .page_copy
            .as_ref()
            .expect("copy result");
        kernel
            .readers()
            .read_default(|connection| {
                let evidence = connection.query_row(
                    "SELECT copied.library_id, entry.document_id, \
                       document.library_id, target.head_seq, \
                       (SELECT count(*) FROM core_module_receipts \
                         WHERE module_name = 'library' \
                           AND operation_id = 'operation:copy-with-read-grant') \
                     FROM blocks copied \
                     JOIN document_block_index entry ON entry.block_id = copied.id \
                     JOIN documents document ON document.id = ?2 \
                     JOIN documents target ON target.id = 'document:target' \
                     WHERE copied.id = ?1",
                    params![result.page_id, result.document_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )?;
                assert_eq!(
                    evidence,
                    (
                        "library-1".to_owned(),
                        "document:target".to_owned(),
                        "library-1".to_owned(),
                        2,
                        0,
                    )
                );
                Ok(())
            })
            .expect("Page grant copy evidence");
    }

    #[test]
    fn clones_canvas_genesis_without_a_second_public_event() {
        let (_directory, kernel) = seeded_kernel();
        let library = LibraryModule::new("profile-1", "library-1", &kernel);
        let source_canvas_id = "018f0000-0000-7000-8000-000000000201";
        let source_canvas_document_id = "018f0000-0000-7000-8000-000000000203";
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:create-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateCanvas {
                        canvas_id: source_canvas_id.to_owned(),
                        document_id: source_canvas_document_id.to_owned(),
                        display_name: "Sketch".to_owned(),
                        destination: LibraryCanvasDestination::Library { before: None },
                    },
                },
            )
            .expect("create Canvas");
        let documents = OwnedDocumentModule::new("profile-1", "library-1", &kernel);
        documents
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "operation:edit-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: source_canvas_document_id.to_owned(),
                        generation: 1,
                        expected_head_seq: 0,
                        mutation: serde_json::json!({
                            "elementCandidates": [{
                                "id": "element:note",
                                "type": "rectangle",
                                "version": 1,
                                "versionNonce": 7,
                                "index": "a0",
                                "isDeleted": false,
                                "text": "Native Canvas"
                            }],
                            "appStateIntents": {
                                "gridSize": {
                                    "expected": { "kind": "absent" },
                                    "value": { "kind": "value", "value": 20 }
                                }
                            },
                            "fileAdditions": {}
                        }),
                    },
                },
            )
            .expect("edit source Canvas");

        let target_canvas_id = "018f0000-0000-7000-8000-000000000202".to_owned();
        let target_canvas_document_id = "document:canvas-target".to_owned();
        let assets_root = kernel
            .database_path()
            .parent()
            .expect("Profile database parent")
            .join("assets");
        let before_event_count = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row("SELECT count(*) FROM change_log", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(StoreError::from)
            })
            .expect("count events before Canvas clone");
        let event_count = kernel
            .writer()
            .call({
                let target_canvas_id = target_canvas_id.clone();
                let target_canvas_document_id = target_canvas_document_id.clone();
                move |connection| {
                    with_immediate_transaction(connection, |transaction| {
                        transaction.execute(
                            "INSERT INTO blocks( \
                               id, library_id, type, lifecycle, placement_revision, \
                               metadata_revision, created_at, updated_at \
                             ) VALUES (?1, 'library-1', 'canvas', 'active', 1, 1, ?2, ?2)",
                            params![target_canvas_id, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO documents( \
                               id, library_id, generation, head_seq, schema_key, schema_version, \
                               state_vector, state_hash, readiness, authority, created_at, updated_at, \
                               sync_engine \
                             ) VALUES (?1, 'library-1', 1, 0, 'nodex.canvas', 2, X'', ?2, \
                               'ready', 'ydoc_primary', ?3, ?3, 'canvas_scene')",
                            params![target_canvas_document_id, "0".repeat(64), NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
                             VALUES (?1, ?2, 'library-1', ?3)",
                            params![target_canvas_id, target_canvas_document_id, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO canvas_owners(block_id, library_id, created_at, updated_at) \
                             VALUES (?1, 'library-1', ?2, ?2)",
                            params![target_canvas_id, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO library_block_placements( \
                               library_id, block_id, rank_key, revision, created_at, updated_at \
                             ) VALUES ('library-1', ?1, 'U', 1, ?2, ?2)",
                            params![target_canvas_id, NOW],
                        )?;
                        let source = read_document_authority(
                            transaction,
                            source_canvas_document_id,
                        )?
                        .expect("source Canvas authority");
                        let target = read_document_authority(
                            transaction,
                            &target_canvas_document_id,
                        )?
                        .expect("target Canvas authority");
                        assert_eq!(
                            clone_canvas_genesis(
                                transaction,
                                &source,
                                &target,
                                &assets_root,
                            )?,
                            1
                        );
                        transaction
                            .query_row("SELECT count(*) FROM change_log", [], |row| {
                                row.get::<_, i64>(0)
                            })
                            .map_err(StoreError::from)
                    })
                }
            })
            .expect("clone Canvas genesis");
        assert_eq!(event_count, before_event_count);

        kernel
            .readers()
            .read_default(|connection| {
                let source = connection.query_row(
                    "SELECT document.head_seq, scene.app_state_json, scene.scene_hash, \
                       element.element_json \
                     FROM documents document JOIN canvas_scenes scene \
                       ON scene.document_id = document.id \
                     JOIN canvas_scene_elements element ON element.document_id = document.id \
                     WHERE document.id = ?1",
                    [source_canvas_document_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )?;
                let target = connection.query_row(
                    "SELECT document.head_seq, scene.app_state_json, scene.scene_hash, \
                       element.element_json, block.type, \
                       (SELECT count(*) FROM library_block_placements placement \
                          WHERE placement.block_id = block.id), \
                       (SELECT count(*) FROM change_log) \
                     FROM documents document JOIN canvas_scenes scene \
                       ON scene.document_id = document.id \
                     JOIN canvas_scene_elements element ON element.document_id = document.id \
                     JOIN block_documents ownership ON ownership.document_id = document.id \
                     JOIN blocks block ON block.id = ownership.block_id \
                     WHERE document.id = ?1 AND block.id = ?2",
                    params![target_canvas_document_id, target_canvas_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )?;
                assert_eq!(target.0, source.0);
                assert_eq!(target.1, source.1);
                assert_eq!(target.2, source.2);
                assert_eq!(target.3, source.3);
                assert_eq!(target.4, "canvas");
                assert_eq!(target.5, 1);
                assert_eq!(target.6, before_event_count);
                Ok(())
            })
            .expect("durable Canvas clone evidence");
    }
}
